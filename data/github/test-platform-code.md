# test-platform -- Source Code Reference

## Go Grading Engine -- Core Types (types.go)

The central data structures that flow through the entire grading pipeline. GradingJob is what arrives from Redis Streams; GradingResult is what gets written back to PostgreSQL.

```go
type GradingJob struct {
    AttemptID        string            `json:"attemptId"`
    ChallengeID      string            `json:"challengeId,omitempty"`
    DependenciesHash string            `json:"dependenciesHash,omitempty"`
    Files            map[string]string `json:"files"`
    PublicTests      string            `json:"publicTests"`
    HiddenTests      string            `json:"hiddenTests"`
    Dependencies     map[string]string `json:"dependencies"`
    NodeVersion      string            `json:"nodeVersion"`
    TimeLimit        int               `json:"timeLimit"`
    MemoryLimit      int               `json:"memoryLimit"`
    Runner           *ChallengeRunner  `json:"runner,omitempty"`
    IsPreview        bool              `json:"isPreview,omitempty"`
}

type GradingResult struct {
    PublicScore int    `json:"publicScore"`
    HiddenScore int    `json:"hiddenScore"`
    TotalPublic int    `json:"totalPublic"`
    TotalHidden int    `json:"totalHidden"`
    Logs        string `json:"logs"`
    Success     bool   `json:"success"`
    Error       string `json:"error,omitempty"`
}
```

The ChallengeRunner struct tells the grader which execution mode to use (http, playwright, ui_jsdom, or sql) and includes runtime-specific config.

```go
type ChallengeRunner struct {
    Mode      string        `json:"mode"`
    Runtime   string        `json:"runtime,omitempty"`
    Candidate CandidateSpec `json:"candidate,omitempty"`
    Tests     TestSpec      `json:"tests,omitempty"`
    Database    *SqlDatabaseSpec  `json:"database,omitempty"`
    SampleData  *SqlSampleData    `json:"sampleData,omitempty"`
    SqlTests    *SqlTestConfig    `json:"sqlTests,omitempty"`
    PublicTests []SqlPublicTest   `json:"publicTests,omitempty"`
    HiddenTests []SqlHiddenTest   `json:"hiddenTests,omitempty"`
}

type CandidateSpec struct {
    Image            string            `json:"image"`
    Workdir          string            `json:"workdir"`
    GeneratedFiles   map[string]string `json:"generatedFiles,omitempty"`
    InstallCommand   string            `json:"installCommand,omitempty"`
    RunCommand       string            `json:"runCommand"`
    Port             int               `json:"port"`
    HealthPath       string            `json:"healthPath"`
    Env              map[string]string `json:"env,omitempty"`
    StartupTimeoutMs int               `json:"startupTimeoutMs"`
}
```

## Go Grading Engine -- Dispatcher (dispatcher.go)

The dispatcher routes each GradingJob to the correct grader implementation based on runner.Mode. It supports four grading modes: HTTP black-box, Playwright browser, UI JSDOM, and SQL.

```go
func RunGrader(ctx context.Context, job types.GradingJob, gctx *GraderContext) (types.GradingResult, error) {
    if job.Runner == nil || job.Runner.Mode == "" {
        return failureResult("missing runner configuration"), nil
    }
    switch job.Runner.Mode {
    case "http":
        return RunHTTPBlackboxGrader(ctx, job, gctx)
    case "playwright":
        return RunPlaywrightGrader(ctx, job, gctx)
    case "ui_jsdom":
        return RunUIJsdomGrader(ctx, job, gctx)
    case "sql":
        return RunSQLGrader(ctx, job, gctx)
    default:
        return failureResult(fmt.Sprintf("unknown runner mode: %s", job.Runner.Mode)), nil
    }
}
```

GraderContext bundles all pool managers and resources that graders need -- container pools, network pools, SQL database pools, and the async cleanup pool.

```go
type GraderContext struct {
    PoolManager          PoolManager
    ChallengePoolManager ChallengePoolManager
    UsePooling           bool
    UseChallengePooling  bool
    CleanupPool          *CleanupPool
    SQLPool              *SQLPool
    SQLHiddenPool        *SQLPool
    SQLContainerPool     *SQLContainerPool
}
```

## Redis Streams Consumer -- Worker (worker.go)

The worker reads grading jobs from two priority Redis Streams (high for final submissions, low for preview/test runs). It uses XREADGROUP with consumer groups for distributed processing.

```go
const (
    streamHigh  = "grading:jobs:high"
    streamLow   = "grading:jobs:low"
    streamDLQ   = "grading:jobs:dlq"
    retryZset   = "grading:jobs:retry"
    pauseKey    = "grading:queue:paused"
)

func (w *Worker) Run(ctx context.Context) error {
    if err := w.ensureStreamGroup(ctx, streamHigh); err != nil {
        return err
    }
    if err := w.ensureStreamGroup(ctx, streamLow); err != nil {
        return err
    }
    group, ctx := errgroup.WithContext(ctx)
    group.Go(func() error { return w.processingLoop(ctx) })
    group.Go(func() error { return w.reclaimLoop(ctx) })
    group.Go(func() error { return w.retryLoop(ctx) })
    err := group.Wait()
    w.waitForJobs()
    return err
}
```

XREADGROUP call that pulls new messages. It caps the read count to available semaphore slots so the worker never claims more jobs than it can process concurrently.

```go
func (w *Worker) readAndDispatch(ctx context.Context, stream string) error {
    available := w.availableSlots()
    if available <= 0 {
        return nil
    }
    count := int64(w.cfg.ReadBatch)
    if int64(available) < count {
        count = int64(available)
    }
    res, err := w.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
        Group:    w.cfg.StreamGroup,
        Consumer: w.consumer,
        Streams:  []string{stream, ">"},
        Count:    count,
        Block:    time.Duration(w.cfg.ReadBlockMs) * time.Millisecond,
    }).Result()
    if err != nil {
        return err
    }
    for _, streamRes := range res {
        for _, msg := range streamRes.Messages {
            w.dispatch(ctx, streamRes.Stream, msg)
        }
    }
    return nil
}
```

## Redis Streams -- Reclaim and Retry Logic (worker.go)

The reclaim loop uses XPENDING + XCLAIM to steal idle messages from dead consumers. This is Azure Redis compatible (no XAUTOCLAIM). Retry uses a sorted set with exponential backoff.

```go
func (w *Worker) reclaimStream(ctx context.Context, stream string) error {
    if !w.hasCapacity() {
        return nil
    }
    minIdle := time.Duration(w.cfg.PelIdleMs) * time.Millisecond
    pending, err := w.redis.XPendingExt(ctx, &redis.XPendingExtArgs{
        Stream: stream, Group: w.cfg.StreamGroup,
        Start: "-", End: "+", Count: 20,
    }).Result()
    if err != nil {
        return err
    }
    var ids []string
    for _, p := range pending {
        if p.Idle >= minIdle {
            ids = append(ids, p.ID)
        }
    }
    if len(ids) == 0 {
        return nil
    }
    messages, err := w.redis.XClaim(ctx, &redis.XClaimArgs{
        Stream: stream, Group: w.cfg.StreamGroup,
        Consumer: w.consumer, MinIdle: minIdle, Messages: ids,
    }).Result()
    for _, msg := range messages {
        w.dispatch(ctx, stream, msg)
    }
    return nil
}
```

Exponential backoff retry: failed jobs go into a Redis sorted set scored by retry-at timestamp. The retryLoop polls and requeues when time arrives.

```go
func retryDelay(baseMs, maxMs, attempt int) time.Duration {
    delayMs := float64(baseMs) * math.Pow(2, float64(attempt-1))
    if delayMs > float64(maxMs) {
        delayMs = float64(maxMs)
    }
    return time.Duration(delayMs) * time.Millisecond
}
```

## Redis Streams -- Job Status Transition (worker.go)

An atomic Lua script updates job status and stats counters in a single Redis round-trip. This prevents race conditions between concurrent workers.

```go
var transitionScript = redis.NewScript(`
local jobKey = KEYS[1]
local statsKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local nextStatus = ARGV[2]
local nowMs = ARGV[3]

local prev = redis.call("HGET", jobKey, "status")

if prev == "queued" then
  redis.call("HINCRBY", statsKey, "queued", -1)
elseif prev == "processing" then
  redis.call("HINCRBY", statsKey, "active", -1)
end

if nextStatus == "processing" then
  redis.call("HINCRBY", statsKey, "active", 1)
elseif nextStatus == "completed" then
  redis.call("HINCRBY", statsKey, "completed", 1)
elseif nextStatus == "failed" then
  redis.call("HINCRBY", statsKey, "failed", 1)
end

redis.call("HSET", jobKey, "status", nextStatus, "updatedAt", nowMs)
if ttl and ttl > 0 then
  redis.call("EXPIRE", jobKey, ttl)
end
return prev
`)
```

## Container Isolation -- Docker Security Hardening (docker.go)

Every candidate container runs with strict resource limits and read-only root filesystem. Runtime-specific tmpfs mounts allow npm/pip caches without writable root.

```go
func dockerRunArgs(containerWorkDir, hostWorkDir string, env map[string]string,
    memoryLimitMb int, runtime string, skipReadOnly bool) []string {
    args := []string{
        "--memory", fmt.Sprintf("%dm", memoryLimitMb),
        "--memory-swap", fmt.Sprintf("%dm", memoryLimitMb),
        "--cpus", "1",
        "--pids-limit", "150",
        "--tmpfs", "/tmp:rw,nosuid,size=200m",
        "-v", fmt.Sprintf("%s:%s:rw", hostWorkDir, workDir),
        "-w", workDir,
        "--user", "1000:1000",
    }
    if !skipReadOnly {
        args = append(args, "--read-only")
    }
    if config, ok := RuntimeProfiles[runtime]; ok {
        for _, mount := range config.TmpfsMounts {
            args = append(args, "--tmpfs", mount)
        }
    }
    return args
}
```

RuntimeProfiles defines per-language security configs. Adding a new language (Rust, Java) only requires a new entry here.

```go
var RuntimeProfiles = map[string]RuntimeConfig{
    "node":       {TmpfsMounts: []string{"/home/node/.npm:rw,size=200m"}},
    "playwright": {TmpfsMounts: []string{"/home/pwuser/.npm:rw,size=200m"}},
    "python":     {TmpfsMounts: []string{"/.local:rw,size=200m", "/.cache:rw,size=200m"}},
}
```

## Container Isolation -- Docker Client for SQL Containers (docker_client.go)

PostgreSQL containers for SQL challenges get extra security hardening: read-only root, tmpfs for data dirs, no-new-privileges, and tight resource caps.

```go
func (d *DockerClientImpl) CreateContainer(ctx context.Context, imageName string,
    env map[string]string, internalPort int) (string, error) {
    args := []string{
        "run", "-d", "--rm",
        "-p", fmt.Sprintf("0.0.0.0::%d", internalPort),
        "--memory", "256m",
        "--memory-swap", "256m",
        "--cpus", "0.5",
        "--pids-limit", "50",
        "--read-only",
        "--tmpfs", "/var/lib/postgresql/data:rw,size=100m",
        "--tmpfs", "/run/postgresql:rw,size=10m",
        "--tmpfs", "/tmp:rw,size=50m",
        "--security-opt", "no-new-privileges:true",
    }
    for k, v := range env {
        args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
    }
    args = append(args, imageName)
    result, err := docker.Exec(ctx, args, 60*time.Second)
    return strings.TrimSpace(result.Stdout), err
}
```

## Container Isolation -- Network Isolation and Lifecycle (docker.go)

Docker networks are created with --internal flag to prevent internet access from candidate containers. The SafeCleanup function is called on all exit paths.

```go
func CreateNetwork(ctx context.Context, name string) error {
    _, err := Exec(ctx, []string{"network", "create", "--internal", name}, 8*time.Second)
    return err
}

func SafeCleanup(ctx context.Context, containerName, networkName string) error {
    if containerName != "" {
        _, _ = Exec(ctx, []string{"rm", "-f", containerName}, 5*time.Second)
    }
    if networkName != "" {
        _, _ = Exec(ctx, []string{"network", "rm", networkName}, 5*time.Second)
    }
    return nil
}
```

## Container Pool -- Reusable Container Management (container_pool.go)

The ContainerPool pre-warms Docker containers to avoid cold-start latency during exams. Containers are validated on acquire, reset on release (preserving node_modules for dep caching).

```go
type PooledContainer struct {
    ID, Name, WorkDir, Network, Image, Runtime string
    CreatedAt, LastUsedAt time.Time
    InUse    bool
    DepsHash string
}

func (p *ContainerPool) Acquire(ctx context.Context) (*PooledContainer, error) {
    select {
    case container := <-p.containers:
        if p.validateContainer(ctx, container) {
            container.InUse = true
            container.LastUsedAt = time.Now()
            return container, nil
        }
        p.destroyContainer(ctx, container)
    default:
    }
    // Create new if under MaxSize, else wait with timeout
    container, err := p.createContainer(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to create container: %w", err)
    }
    return container, nil
}
```

On release, containers are cleaned (user files removed but node_modules preserved) and returned to the channel-based pool.

```go
func (p *ContainerPool) resetContainer(ctx context.Context, container *PooledContainer) error {
    entries, err := os.ReadDir(container.WorkDir)
    if err != nil {
        return err
    }
    for _, entry := range entries {
        if entry.Name() == "node_modules" {
            continue // Keep for dependency caching
        }
        path := filepath.Join(container.WorkDir, entry.Name())
        os.RemoveAll(path)
    }
    return nil
}
```

## Async Cleanup Pool (cleanup.go)

Graders submit Docker teardown work to this bounded pool instead of blocking the grading semaphore. This prevents docker rm / os.RemoveAll from reducing grading throughput.

```go
type CleanupPool struct {
    sem    chan struct{}
    wg     sync.WaitGroup
}

func NewCleanupPool(maxConcurrent int) *CleanupPool {
    return &CleanupPool{sem: make(chan struct{}, maxConcurrent)}
}

func (p *CleanupPool) Submit(fn func(ctx context.Context)) {
    p.wg.Add(1)
    go func() {
        defer p.wg.Done()
        p.sem <- struct{}{}
        defer func() { <-p.sem }()
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        fn(ctx)
    }()
}
```

## Health Check -- HTTP Readiness Probe (health_check.go)

The grader polls the candidate container's health endpoint using a Node.js one-liner executed via docker exec. On timeout, it captures process list and listening ports for debug logs.

```go
func waitForHTTP(ctx context.Context, containerName string, port int,
    healthPath string, timeoutMs int) (string, error) {
    deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
    script := fmt.Sprintf(`
const http = require('http');
const req = http.get('http://127.0.0.1:%d%s', { timeout: 3000 }, (res) => {
  process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
});
req.on('error', () => process.exit(1));
`, port, healthPath)

    for time.Now().Before(deadline) {
        args := []string{"exec", containerName, "node", "-e", script}
        if _, err := docker.Exec(ctx, args, 5*time.Second); err == nil {
            return debug, nil // Server is ready
        }
        sleepWithContext(ctx, 150*time.Millisecond)
    }
    return debug, fmt.Errorf("candidate app did not become ready in time")
}
```

## SQL Grader -- Query Comparison (sql_grader.go)

The SQL grader executes student queries against PostgreSQL and compares results. It supports shared (read-only pool) and isolated (per-test container) modes, plus random data generation for anti-cheat.

```go
func RunSQLGrader(ctx context.Context, job types.GradingJob, gctx *GraderContext) (types.GradingResult, error) {
    runner := job.Runner
    isolation := "shared"
    if runner.SqlTests != nil && runner.SqlTests.Isolation != "" {
        isolation = runner.SqlTests.Isolation
    }
    studentQuery := ""
    for name, content := range job.Files {
        if strings.HasSuffix(name, ".sql") {
            studentQuery = content
            break
        }
    }
    if strings.TrimSpace(studentQuery) == "" {
        return failureResult("No SQL query submitted"), nil
    }
    if len(runner.PublicTests) > 0 {
        if isolation == "shared" {
            publicResult = runSharedPublicTests(ctx, studentQuery, runner, gctx)
        } else {
            publicResult = runIsolatedPublicTests(ctx, studentQuery, runner, job, gctx)
        }
    }
    // Hidden tests only on final submit, not preview
    if !job.IsPreview && len(runner.HiddenTests) > 0 {
        hiddenResult = runSharedHiddenTests(ctx, studentQuery, runner, job, gctx)
    }
    return types.GradingResult{
        PublicScore: publicResult.Passed, HiddenScore: hiddenResult.Passed,
        TotalPublic: publicResult.Total,  TotalHidden: hiddenResult.Total,
        Logs: publicResult.Logs, Success: publicResult.Success,
    }, nil
}
```

## Security Middleware -- Rate Limiting (rateLimiter.ts)

Redis-backed distributed rate limiting with user-ID-based keys. Designed for college scenarios where 300+ students share a single public IP. Each student gets their own quota via JWT userId.

```typescript
function userIdKeyGenerator(req: Request): string {
    if (req.user?.userId) {
        return `user:${req.user.userId}`;
    }
    return `ip:${getClientIP(req)}`;
}

export const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300, // 300 requests per minute per USER
    keyGenerator: userIdKeyGenerator,
    store: createRedisStore('api'),
});

export const submissionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: userIdKeyGenerator,
    store: createRedisStore('submission'),
});

export const runTestsLimiter = rateLimit({
    windowMs: 30 * 1000,
    max: 5, // 5 test runs per 30 seconds per USER
    keyGenerator: userIdKeyGenerator,
    store: createRedisStore('runtests'),
});
```

Layer 1 DDoS protection limits per-IP at 5000 req/s to handle shared-NAT college networks without blocking legitimate users.

```typescript
export const globalIPLimiter = rateLimit({
    windowMs: 1000,
    max: process.env.NODE_ENV === 'development' ? 10000 : 5000,
    keyGenerator: (req: Request) => `gip:${getClientIP(req)}`,
    store: createRedisStore('gip'),
});
```

## Security Middleware -- JWT Authentication (auth.ts)

Bearer token authentication with role-based access control. Admin/Reviewer accounts require approval status check against the database on every request.

```typescript
export function authenticate(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        throw new ApiError('Authorization header missing or invalid', 401);
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, SECRET) as JwtPayload;
        req.user = decoded;
        next();
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            throw new ApiError('Token has expired', 401);
        }
        throw new ApiError('Invalid token', 401);
    }
}

export function requireRole(...roles: Array<'ADMIN' | 'CANDIDATE' | 'REVIEWER'>) {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (!roles.includes(req.user.role)) {
            throw new ApiError('Insufficient permissions', 403);
        }
        if (req.user.role === 'ADMIN' || req.user.role === 'REVIEWER') {
            const user = await db.query.users.findFirst({
                where: eq(users.id, req.user.userId),
                columns: { approvalStatus: true },
            });
            if (user.approvalStatus !== 'APPROVED') {
                throw new ApiError('Account pending approval', 403);
            }
        }
        next();
    };
}
```

## Database Schema -- Drizzle ORM Definitions (schema.ts)

PostgreSQL schema using Drizzle ORM with CUID2 primary keys, role-based enums, and comprehensive indexing for query performance.

```typescript
export const roleEnum = pgEnum('role', ['ADMIN', 'CANDIDATE', 'REVIEWER']);
export const attemptStatusEnum = pgEnum('attempt_status',
    ['IN_PROGRESS', 'SUBMITTED', 'GRADING', 'COMPLETED', 'FAILED']);

export const users = pgTable('users', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    email: text('email').notNull().unique(),
    password: text('password').notNull(),
    name: text('name'),
    role: roleEnum('role').default('CANDIDATE').notNull(),
    approvalStatus: approvalStatusEnum('approval_status').default('APPROVED').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const challenges = pgTable('challenges', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    name: text('name').notNull(),
    starterFiles: json('starter_files').$type<Record<string, string>>().notNull(),
    publicTests: text('public_tests').notNull(),
    hiddenTests: text('hidden_tests').notNull(),
    dependencies: json('dependencies').$type<Record<string, string>>().notNull(),
    runner: json('runner').$type<Record<string, unknown>>(),
});
```

The exams table supports scheduled windows (start/end), integrity settings (fullscreen, tab-switch logging, paste blocking), and pool pre-warming config.

```typescript
export const exams = pgTable('exams', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    title: text('title').notNull(),
    challengeId: text('challenge_id').references(() => challenges.id).notNull(),
    timeLimit: integer('time_limit').notNull(),
    maxAttempts: integer('max_attempts').default(1).notNull(),
    scheduledStartAt: timestamp('scheduled_start_at'),
    scheduledEndAt: timestamp('scheduled_end_at'),
    fullscreenRequired: boolean('fullscreen_required').default(true).notNull(),
    tabSwitchLogging: boolean('tab_switch_logging').default(true).notNull(),
    pasteDisabled: boolean('paste_disabled').default(true).notNull(),
    expectedCandidates: integer('expected_candidates').default(100),
    isPublished: boolean('is_published').default(false).notNull(),
});

export const examAttempts = pgTable('exam_attempts', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    examId: text('exam_id').references(() => exams.id).notNull(),
    candidateId: text('candidate_id').references(() => users.id).notNull(),
    status: attemptStatusEnum('status').default('IN_PROGRESS').notNull(),
    files: json('files').$type<Record<string, string>>(),
    publicScore: integer('public_score'),
    hiddenScore: integer('hidden_score'),
    tabExits: integer('tab_exits').default(0).notNull(),
    fullscreenExits: integer('fullscreen_exits').default(0).notNull(),
    pasteAttempts: integer('paste_attempts').default(0).notNull(),
});
```

## API Routes -- Submit Attempt for Grading (attempts.ts)

The submit endpoint flushes Redis-buffered autosaves, updates status to SUBMITTED, then queues a full grading job (public + hidden tests) via Redis Streams.

```typescript
router.post('/:id/submit', authenticate, submissionLimiter, async (req, res, next) => {
    const attempt = await db.query.examAttempts.findFirst({
        where: eq(examAttempts.id, attemptId),
        with: { exam: { with: { challenge: true } } },
    });
    await stopTimerPermanently(attemptId);
    await flushToDatabase(attemptId);
    const bufferedFiles = await getFromBuffer(attemptId);
    const finalFiles = data.files || bufferedFiles || attempt.files || {};
    await db.update(examAttempts)
        .set({ status: 'SUBMITTED', submittedAt: new Date(), files: finalFiles })
        .where(eq(examAttempts.id, attemptId));
    const jobId = await addGradingJob({
        attemptId: attempt.id,
        files: finalFiles,
        publicTests: attempt.exam.challenge.publicTests,
        hiddenTests: attempt.exam.challenge.hiddenTests,
        runner: attempt.exam.challenge.runner,
        challengeId: attempt.exam.challenge.id,
    });
    await db.update(examAttempts)
        .set({ status: 'GRADING' })
        .where(eq(examAttempts.id, attemptId));
    await clearBuffer(attemptId);
    res.json({ success: true, data: { jobId } });
});
```

## API Routes -- Run Public Tests Preview (attempts.ts)

The run-tests endpoint uses a Redis SET NX lock (90s TTL) to prevent concurrent test runs per attempt. It queues a preview job (isPreview=true) that only runs public tests.

```typescript
router.post('/:id/run-tests', authenticate, runTestsLimiter, async (req, res, next) => {
    const lockKey = `grading:lock:${attemptId}`;
    const lockAcquired = await redisConnection.set(lockKey, Date.now().toString(), 'NX', 'EX', 90);
    if (!lockAcquired) {
        throw new ApiError('Tests are already running for this attempt', 429);
    }
    const bufferedFiles = await getFromBuffer(attemptId);
    const files = bufferedFiles || attempt.files || {};
    const jobId = await addGradingJob({
        attemptId: attempt.id,
        files,
        publicTests: attempt.exam.challenge.publicTests,
        hiddenTests: '', // Empty -- only public tests
        runner: attempt.exam.challenge.runner,
        isPreview: true, // Don't change attempt status
    });
    res.json({ success: true, data: { jobId } });
});
```

## API Routes -- Job Enqueue to Redis Streams (grading.ts)

The addGradingJob function writes to Redis Streams (high priority for final submissions, low for previews), creates a tracking hash with TTL, and updates queue statistics atomically.

```typescript
export async function addGradingJob(job: GradingJobWithPreview): Promise<string> {
    const jobId = createJobId(job.attemptId);
    const stream = job.isPreview ? STREAMS.LOW : STREAMS.HIGH;
    const payload = JSON.stringify(job);
    const streamId = await redisConnection.xadd(
        stream, '*',
        'jobId', jobId,
        'attemptId', job.attemptId,
        'isPreview', job.isPreview ? '1' : '0',
        'createdAt', String(Date.now()),
        'payload', payload
    );
    const pipeline = redisConnection.multi();
    pipeline.hset(jobKey(jobId), {
        status: 'queued', progress: '0', attemptId: job.attemptId,
        stream, streamId, payload, group: STREAM_GROUP,
    });
    pipeline.expire(jobKey(jobId), JOB_TTL_SEC);
    pipeline.hincrby(STATS_KEY, 'queued', 1);
    await pipeline.exec();
    return jobId;
}
```

## API Routes -- Exam Invitation Security (exams.ts)

Invitation tokens are bound to specific emails. On accept, the server validates email match, checks expiry, prevents reuse, and creates a new exam attempt with starter files.

```typescript
router.post('/invite/:token/accept', authenticate, async (req, res, next) => {
    const invitation = await db.query.examInvitations.findFirst({
        where: eq(examInvitations.token, req.params.token),
        with: { exam: { with: { challenge: true } } },
    });
    if (invitation.email) {
        if (invitation.email.toLowerCase() !== req.user.email.toLowerCase()) {
            throw new ApiError('This invitation was sent to a different email', 403);
        }
    }
    if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
        throw new ApiError('Invitation has expired', 410);
    }
    if (invitation.usedAt) {
        throw new ApiError('Invitation already used', 400);
    }
    await db.update(examInvitations)
        .set({ usedAt: new Date() })
        .where(eq(examInvitations.id, invitation.id));
    const [attempt] = await db.insert(examAttempts).values({
        examId: invitation.examId,
        candidateId: req.user.userId,
        files: invitation.exam.challenge.starterFiles,
    }).returning();
    res.status(201).json({ success: true, data: { attemptId: attempt.id } });
});
```

## Grader Main Entry Point (cmd/grader/main.go)

The main function wires everything together: Redis client, PostgreSQL store, container pool, network pool, SQL pools, Docker client, cleanup pool, and the worker. Graceful shutdown waits for in-flight jobs.

```go
func main() {
    cfg, err := config.Load()
    ctx, cancel := context.WithCancel(context.Background())
    redisClient, _ := redis.NewClient(cfg.RedisURL)
    store, _ := db.New(ctx, cfg.DatabaseURL)
    containerPool := pool.NewContainerPool(pool.PoolConfig{
        MaxSize: cfg.PoolMaxSize, MinSize: cfg.PoolMinSize,
        AcquireTimeout: cfg.PoolAcquireTimeout,
    })
    networkPool := pool.NewNetworkPool(cfg.NetworkPoolMax)
    poolManager := pool.NewPoolManager(containerPool, networkPool, redisClient)
    cleanupPool := grader.NewCleanupPool(8)
    w := worker.New(cfg, redisClient, store, poolManager,
        challengePoolManager, sqlPool, sqlHiddenPool, sqlContainerPool, cleanupPool)
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    go func() { <-signals; cancel() }()
    w.Run(ctx)
    cleanupPool.Wait()
    poolManager.Close(context.Background())
}
```

## HTTP Blackbox Grader -- File Security (http_grader.go)

The grader blocks candidates from overwriting test files, package.json, or dependency manifests. This prevents cheating by modifying test assertions or injecting malicious dependencies.

```go
var blockedPaths = []string{
    "__tests__", "test", "tests", "node_modules",
    "package.json", "package-lock.json", "results.json",
    "requirements.txt", "go.mod", "go.sum", "cargo.toml",
}

var blockedFilePatterns = []*regexp.Regexp{
    regexp.MustCompile(`(?i)\.test\.(js|jsx|ts|tsx)$`),
    regexp.MustCompile(`(?i)\.spec\.(js|jsx|ts|tsx)$`),
    regexp.MustCompile(`(?i)^jest\.`),
    regexp.MustCompile(`(?i)^package(-lock)?\.json$`),
    regexp.MustCompile(`(?i)^requirements\.txt$`),
    regexp.MustCompile(`(?i)^go\.(mod|sum)$`),
    regexp.MustCompile(`(?i)^cargo\.(toml|lock)$`),
}
```

Log sanitization removes hidden test names, file paths, and internal container names from grading output before sending to candidates.

```go
var (
    reHiddenTest  = regexp.MustCompile(`(?i)hidden\.test\.(js|jsx|ts|tsx)`)
    reVarFolders  = regexp.MustCompile(`/var/folders/[^\s]+`)
    reTmpGrader   = regexp.MustCompile(`/tmp/grader_[^\s]+`)
    reGraderDirs  = regexp.MustCompile(`(?i)grader_bb_[a-z]+_[a-z]+_[a-z0-9]+_\d+_[a-z0-9]+`)
)
```
