# Universal Exam & Grading Platform (test-platform)

## Quick Summary

A production-grade coding exam platform built as a **Turborepo monorepo** with three apps (`apps/api`, `apps/web`, `apps/grader-go`) and shared packages (`packages/database`, `packages/shared`, `packages/proto`). The platform supports **HTTP black-box**, **Playwright E2E**, **jsdom UI**, and **SQL** challenge types. The grading engine is written in **Go** and consumes jobs from **Redis Streams** with consumer groups, running candidate code in **ephemeral Docker containers** on isolated `--internal` bridge networks. The API is **Express/TypeScript** with **Socket.IO** (Redis adapter for horizontal scaling), **Drizzle ORM** on PostgreSQL, and a comprehensive **proctoring system** (tab-switch detection, fullscreen monitoring, paste blocking, keystroke analytics, screenshot capture to S3). Designed for **500+ concurrent students on a shared college IP** with per-user Redis-backed rate limiting.

---

## Architecture (with actual package/file paths)

```
test-platform/
  apps/
    api/              # Express.js API server (TypeScript)
      src/
        app.ts        # Express app setup, middleware, route mounting
        server.ts     # HTTP server + Socket.IO initialization
        routes/       # 7 route modules (auth, attempts, exams, proctor, reports, challenges, admin-users)
        middleware/    # auth.ts, rateLimiter.ts, errorHandler.ts, apiVersion.ts
        lib/          # grading.ts, redis.ts, autosave-buffer.ts, token-manager.ts, session-cache.ts, s3.ts
        socket/       # index.ts, examHandlers.ts, timerService.ts, proctorService.ts, keystrokeService.ts
    grader-go/        # Go grading worker (Redis Streams consumer)
      cmd/grader/main.go   # Entry point
      internal/
        config/config.go   # Env-based configuration with auto-detected concurrency
        worker/worker.go   # Redis Streams consumer loop (processingLoop, reclaimLoop, retryLoop)
        grader/            # 13 files: dispatcher, http_grader, playwright_grader, ui_jsdom_grader, sql_grader, etc.
        docker/docker.go   # Docker CLI wrapper (RunDetached, RunOnce, CreateNetwork)
        pool/              # network_pool.go, container_pool.go, challenge_pool.go, warmer.go, dep_cache.go
        redis/client.go    # Redis client factory
        db/postgres.go     # pgx-based store for writing grading results
        types/types.go     # GradingJob, GradingResult, ChallengeRunner, SQL* structs
    web/              # Next.js frontend
  packages/
    database/         # Drizzle ORM schema + migrations
      src/schema.ts   # 6 tables: users, challenges, exams, examInvitations, examAttempts, proctorEvents
    shared/           # Zod schemas, shared types
    proto/            # Protobuf definitions (for future gRPC)
  docker/             # Dockerfiles for React candidate/test containers
  nginx/nginx.conf    # SSL-terminating reverse proxy with rate limiting zones
  docker-compose.yml  # Local dev: api, postgres, redis, grader
```

### Data flow

1. **Candidate submits code** -> `PUT /api/attempts/:id/files` -> Redis autosave buffer (`autosave:{attemptId}`)
2. **Run Tests / Submit** -> `POST /api/attempts/:id/run-tests` or `POST /api/attempts/:id/submit` -> `addGradingJob()` in `apps/api/src/lib/grading.ts` -> `XADD` to `grading:jobs:high` or `grading:jobs:low`
3. **Go worker** reads via `XREADGROUP` -> `worker.processMessage()` -> `grader.RunGrader()` dispatches to correct grader mode
4. **Grader** creates ephemeral Docker containers (candidate + test) on an `--internal` network, runs tests, parses results
5. **Result** -> `store.UpdateAttemptResults()` writes to PostgreSQL -> `PUBLISH grading:complete` -> Socket.IO emits `grading:complete` to client

---

## Go Grading Engine (actual function names, goroutine model, struct definitions)

### Entry Point: `apps/grader-go/cmd/grader/main.go`

The `main()` function initializes: `config.Load()`, `redis.NewClient()`, `db.New()`, `pool.NewContainerPool()`, `pool.NewNetworkPool()`, `pool.NewPoolManager()`, `grader.NewSQLPool()`, `grader.NewSQLContainerPool()`, `grader.NewCleanupPool(8)`, then creates a `worker.New()` and calls `w.Run(ctx)`.

Background goroutines launched at startup:
- `poolManager.SubscribeWarmup(ctx)` -- listens on Redis pub/sub channel `pool:warmup`
- `networkPool.Warm(ctx, cfg.PoolMinSize)` -- pre-creates Docker networks

### Core Structs (`apps/grader-go/internal/types/types.go`)

```go
type GradingJob struct {
    AttemptID        string            `json:"attemptId"`
    ChallengeID      string            `json:"challengeId,omitempty"`
    Files            map[string]string `json:"files"`
    PublicTests      string            `json:"publicTests"`
    HiddenTests      string            `json:"hiddenTests"`
    Dependencies     map[string]string `json:"dependencies"`
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
}

type ChallengeRunner struct {
    Mode      string        `json:"mode"`       // "http", "playwright", "ui_jsdom", "sql"
    Runtime   string        `json:"runtime"`     // "node", "python", "playwright"
    Candidate CandidateSpec `json:"candidate"`
    Tests     TestSpec      `json:"tests"`
    Database  *SqlDatabaseSpec  `json:"database,omitempty"`  // SQL mode
    SqlTests  *SqlTestConfig    `json:"sqlTests,omitempty"`
}
```

SQL-specific structs include `SqlDatabaseSpec`, `SqlSampleData`, `SqlTestConfig`, `SqlPublicTest`, `SqlHiddenTest`, and `SqlDataGenerator` (for random anti-cheat data injection on hidden tests).

### Worker Goroutine Model (`apps/grader-go/internal/worker/worker.go`)

The `Worker` struct uses a **semaphore channel** (`sem chan struct{}`) to limit concurrency:

```go
type Worker struct {
    sem      chan struct{}       // capacity = cfg.Concurrency (auto-detected: NumCPU/3)
    wg       sync.WaitGroup     // tracks in-flight jobs for graceful shutdown
    consumer string             // unique consumer name (hostname-pid)
}
```

`w.Run(ctx)` launches **3 goroutines** via `errgroup`:
1. **`processingLoop`** -- reads from `grading:jobs:high` (priority) then `grading:jobs:low` via `XREADGROUP`. Caps read count to available semaphore slots. Has exponential backoff on consecutive errors (max 10s). Checks `grading:queue:paused` key to support queue pausing.
2. **`reclaimLoop`** -- every `PelPollMs` (default 10s), calls `XPENDING` + `XCLAIM` to reclaim messages idle > `PelIdleMs` (default 60s) from dead consumers.
3. **`retryLoop`** -- polls sorted set `grading:jobs:retry` for jobs whose retry-at timestamp has passed. Removes from ZSET and re-enqueues via `XADD`.

**Job dispatch** (`dispatch()`) acquires a semaphore slot, increments `wg`, and spawns a goroutine that calls `processMessage()`:

```go
func (w *Worker) dispatch(ctx context.Context, stream string, msg redis.XMessage) {
    w.sem <- struct{}{}
    w.wg.Add(1)
    go func() {
        defer func() { <-w.sem; w.wg.Done() }()
        w.processMessage(ctx, stream, msg)
    }()
}
```

### Dispatcher (`apps/grader-go/internal/grader/dispatcher.go`)

`RunGrader()` dispatches based on `job.Runner.Mode`:

```go
func RunGrader(ctx context.Context, job types.GradingJob, gctx *GraderContext) (types.GradingResult, error) {
    switch job.Runner.Mode {
    case "http":       return RunHTTPBlackboxGrader(ctx, job, gctx)
    case "playwright": return RunPlaywrightGrader(ctx, job, gctx)
    case "ui_jsdom":   return RunUIJsdomGrader(ctx, job, gctx)
    case "sql":        return RunSQLGrader(ctx, job, gctx)
    }
}
```

### GraderContext (dependency injection)

```go
type GraderContext struct {
    PoolManager          PoolManager
    ChallengePoolManager ChallengePoolManager
    UsePooling           bool
    CleanupPool          *CleanupPool       // async cleanup (docker rm, os.RemoveAll)
    SQLPool              *SQLPool           // shared read-only DB for public tests
    SQLHiddenPool        *SQLPool           // separate DB with more data for hidden tests
    SQLContainerPool     *SQLContainerPool  // Docker-based isolated PostgreSQL containers
}
```

### Async Cleanup Pool (`apps/grader-go/internal/grader/cleanup.go`)

```go
type CleanupPool struct {
    sem chan struct{}  // bounded to 8 concurrent cleanup goroutines
    wg  sync.WaitGroup
}
```

`Submit(fn)` spawns a goroutine that acquires the semaphore, then runs `fn` with a fresh 30-second context. This prevents docker cleanup from blocking the grading semaphore.

### Config Auto-Detection (`apps/grader-go/internal/config/config.go`)

Concurrency auto-detected: `runtime.NumCPU() / 3` (each grading job runs ~4 containers). Default pool sizes: `PoolMaxSize=20`, `PoolMinSize=5`, `NetworkPoolMax=50`. Retry: exponential backoff base 1s, max 60s, up to 3 attempts. Job TTL: 48 hours.

---

## Two-Container Isolation (actual Docker commands, gVisor config, bridge setup)

### Container Architecture

Each grading job creates **two ephemeral containers** on a shared **isolated Docker network**:

1. **Candidate container** -- runs the student's code (e.g., Express server, React app)
2. **Test container** -- runs the test suite against the candidate via the network

### Network Isolation (`apps/grader-go/internal/docker/docker.go`)

Networks are created with `--internal` flag, blocking internet access:

```go
func CreateNetwork(ctx context.Context, name string) error {
    _, err := Exec(ctx, []string{"network", "create", "--internal", name}, 8*time.Second)
    return err
}
```

The candidate container is attached with `--network-alias candidate`, so the test container can reach it at `http://candidate:PORT`.

### Container Security Hardening (`dockerRunArgs()` in `docker.go`)

Every container runs with:
```
--memory {N}m --memory-swap {N}m  (no swap)
--cpus 1
--pids-limit 150
--tmpfs /tmp:rw,nosuid,size=200m
--read-only                       (root filesystem is read-only)
--user 1000:1000                  (non-root)
```

Runtime-specific tmpfs mounts are defined in `RuntimeProfiles`:
- **node**: `/home/node/.npm:rw,size=200m`
- **playwright**: `/home/pwuser/.npm:rw,size=200m`
- **python**: `/.local:rw,size=200m`, `/.cache:rw,size=200m`

### Candidate Container Start (`RunDetached` in `docker.go`)

```go
func RunDetached(ctx context.Context, opts RunDetachedOptions) error {
    args := []string{"run", "-d", "--name", opts.Name, "--network", opts.Network}
    if opts.Alias != "" { args = append(args, "--network-alias", opts.Alias) }
    args = append(args, dockerRunArgs(...)...)
    args = append(args, opts.Image, "sh", "-c", opts.Command)
    _, err := Exec(ctx, args, opts.Timeout)
    return err
}
```

### Test Container Execution (`RunOnce` in `docker.go`)

Runs with `--rm` flag (auto-removed after exit). The test container connects to the same network to call the candidate's HTTP API or interact via Playwright/jsdom.

### Health Check (`waitForHTTP` in `health_check.go`)

Uses `docker exec` to run a Node.js HTTP check script inside the candidate container:

```go
script := fmt.Sprintf(`
const http = require('http');
const req = http.get('http://127.0.0.1:%d%s', { timeout: 3000 }, (res) => {
  process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
});`, port, healthPath)
```

Polls every 150ms until the candidate server is ready. On failure, captures `ps aux` and `netstat/ss` output for debugging.

### SQL Container Isolation (`apps/grader-go/internal/grader/sql_container_pool.go`)

For SQL write challenges, ephemeral **PostgreSQL containers** are created with security hardening:

```go
args := []string{"run", "-d", "--rm",
    "-p", fmt.Sprintf("0.0.0.0::%d", internalPort),
    "--memory", "256m", "--memory-swap", "256m",
    "--cpus", "0.5", "--pids-limit", "50",
    "--read-only",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=100m",
    "--tmpfs", "/run/postgresql:rw,size=10m",
    "--security-opt", "no-new-privileges:true",
}
```

The `SQLContainerPool` manages a pool of these containers keyed by `challengeID`, with a semaphore limiting concurrent creation to 3. Max container age: 10 minutes.

### Network Pool (`apps/grader-go/internal/pool/network_pool.go`)

`NetworkPool` maintains a buffered channel of pre-created Docker networks. `Acquire()` tries the channel first (non-blocking), falls back to creating a new one, or waits with 10s timeout if at max capacity (default 50). `Release()` returns networks to the channel; if the channel is full, the network is destroyed. `CleanupOrphans()` lists all `grader_net_*` networks from previous runs and removes them on startup.

### Grader Dockerfile (`apps/grader-go/Dockerfile`)

Two-stage build: `golang:1.24-alpine` builder -> `alpine:3.20` runtime with `docker-cli` installed. The grader binary runs as a **Docker-outside-of-Docker** pattern -- it mounts the host Docker socket via `docker-compose.yml`:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

---

## Security Model (actual middleware functions, rate limit config)

### Authentication (`apps/api/src/middleware/auth.ts`)

- `authenticate()` -- verifies JWT Bearer token, attaches `req.user` with `{userId, email, role}`
- `requireRole(...roles)` -- checks `req.user.role` against allowed roles; also **checks approval status** for ADMIN/REVIEWER roles by querying the DB
- `generateToken()` -- creates JWT signed with `JWT_SECRET` env var, 7-day expiry
- Production enforcement: `JWT_SECRET` must be set in production (process.exit(1) if missing)

### Token Management (`apps/api/src/lib/token-manager.ts`)

Full **refresh token rotation** system:
- `generateAccessToken()` -- 1-day JWT
- `generateRefreshToken()` -- 7-day JWT, stored in Redis with `refresh:{tokenId}` key
- `rotateRefreshToken()` -- validates old token, revokes it, generates new pair. If a revoked token is reused, the **entire token family** is revoked (breach detection)
- `revokeTokenFamily(familyId)` -- revokes all tokens sharing a family ID
- Uses `crypto.randomUUID()` for token IDs and family IDs

### Session Cache (`apps/api/src/lib/session-cache.ts`)

- **Fast-path login**: On first login, bcrypt + cache session in Redis (7-day TTL). Subsequent logins validate from Redis (microseconds).
- `createSession()` stores `{ userId, email, role, passwordHash: hash.substring(0,20) }` -- partial hash for change detection
- `getCachedLogin()` / `setCachedLogin()` use a `login_cache:{email}` secondary index
- `invalidateAllUserSessions()` removes all sessions for a user (used on password change/logout-all)

### Rate Limiting (`apps/api/src/middleware/rateLimiter.ts`)

All rate limiters use **Redis-backed** `RedisStore` (distributed across API instances). Key design: **per-user-ID** rate limiting for authenticated requests, allowing 500+ students on the same college IP:

| Limiter | Window | Max | Key Strategy |
|---------|--------|-----|-------------|
| `globalIPLimiter` | 1s | 5000 | IP (DDoS protection) |
| `apiLimiter` | 1min | 300 | User ID (authenticated) or IP |
| `loginLimiter` | 15min | 10 | Email (skips successful requests) |
| `registrationLimiter` | 1hr | 5 | Email |
| `submissionLimiter` | 1min | 10 | User ID |
| `runTestsLimiter` | 30s | 5 | User ID |
| `screenshotLimiter` | 5s | 15 | User ID (allows burst for multi-screenshot events) |
| `autosaveLimiter` | 10s | 20 | User ID |
| `strictLimiter` | 1hr | 5 | User ID |

### Nginx Rate Limiting (`nginx/nginx.conf`)

Three zones at the reverse proxy layer:
- `api_limit`: 30 req/s per IP, burst 50
- `auth_limit`: 10 req/min per IP (login/register)
- `auth_check_limit`: 30 req/min per IP (`/api/auth/me`)

Security headers: `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security` (HSTS), TLS 1.2+1.3 only.

### File Path Validation

- `validateFilePaths()` in `apps/api/src/routes/attempts.ts` blocks `..`, absolute paths, and hidden files/dirs
- Go graders have `blockedPaths` and `blockedFilePatterns` arrays that prevent students from overwriting test files, `package.json`, `go.mod`, `Cargo.toml`, etc.
- `sanitizeFilePath()` ensures writes stay within the workspace directory

### Admin Approval Workflow

- ADMIN/REVIEWER accounts default to `approvalStatus: 'PENDING'`
- First admin auto-approval only if `ALLOW_FIRST_ADMIN_BOOTSTRAP=true`
- `requireRole()` middleware checks approval status on every admin/reviewer request

### Proctoring Security

- **No clipboard content stored** -- only `pasteLength` and `isMultiline` are logged
- Screenshots stored in S3 with metadata only in Redis (24hr TTL)
- Integrity score calculated: `-5 per tab exit`, `-10 per fullscreen exit`, `-15 per paste attempt`, `-2 per 30s away`

---

## Redis Streams Pipeline (actual XREADGROUP/XPENDING/XCLAIM usage)

### Stream Names (constants in `worker.go`)

```go
const (
    streamHigh  = "grading:jobs:high"    // Final submissions
    streamLow   = "grading:jobs:low"     // Preview/test runs (isPreview=true)
    streamDLQ   = "grading:jobs:dlq"     // Dead letter queue
    retryZset   = "grading:jobs:retry"   // Sorted set for delayed retries
    pauseKey    = "grading:queue:paused" // EXISTS check to pause processing
    statsKey    = "grading:stats"        // Hash with queued/active/completed/failed/retrying counters
)
```

### Producer Side (`apps/api/src/lib/grading.ts`)

`addGradingJob()` does:
1. `XGROUP CREATE ... MKSTREAM` (idempotent, ignores BUSYGROUP)
2. `XADD` to `grading:jobs:high` (final submit) or `grading:jobs:low` (preview)
3. `HSET grading:job:{jobId}` with status=queued, progress=0, payload, etc.
4. `HINCRBY grading:stats queued 1`

```typescript
const stream = job.isPreview ? STREAMS.LOW : STREAMS.HIGH;
const streamId = await redisConnection.xadd(stream, '*',
    'jobId', jobId, 'attemptId', job.attemptId,
    'isPreview', job.isPreview ? '1' : '0',
    'createdAt', String(createdAt), 'payload', payload);
```

### Consumer Side (`worker.go`)

**Stream group creation** (`ensureStreamGroup()`):
```go
err := w.redis.XGroupCreateMkStream(ctx, stream, w.cfg.StreamGroup, "0").Err()
```

**Reading messages** (`readAndDispatch()`):
```go
res, err := w.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
    Group:    w.cfg.StreamGroup,      // "grading-workers"
    Consumer: w.consumer,             // "hostname-pid"
    Streams:  []string{stream, ">"},  // ">" = new messages only
    Count:    count,                  // capped to available semaphore slots
    Block:    time.Duration(w.cfg.ReadBlockMs) * time.Millisecond, // 2000ms
}).Result()
```

**Reclaim loop** (`reclaimStream()`):
```go
// Step 1: XPENDING to find idle messages
pending, err := w.redis.XPendingExt(ctx, &redis.XPendingExtArgs{
    Stream: stream, Group: w.cfg.StreamGroup,
    Start: "-", End: "+", Count: 20,
}).Result()

// Step 2: Filter by idle time manually (Azure Redis compat)
for _, p := range pending {
    if p.Idle >= minIdle { ids = append(ids, p.ID) }
}

// Step 3: XCLAIM the idle messages
messages, err := w.redis.XClaim(ctx, &redis.XClaimArgs{
    Stream: stream, Group: w.cfg.StreamGroup,
    Consumer: w.consumer, MinIdle: minIdle, Messages: ids,
}).Result()
```

Note: Uses `XPENDING` + `XCLAIM` instead of `XAUTOCLAIM` for Azure Redis compatibility.

**Retry with exponential backoff** (`retryLoop()`):
```go
// Poll sorted set for jobs whose retry timestamp has passed
ids, err := w.redis.ZRangeByScore(ctx, retryZset, &redis.ZRangeBy{
    Min: "-inf", Max: fmt.Sprintf("%d", now), Count: 50,
}).Result()
// Remove from ZSET in a pipeline, then requeue each via XADD
```

Retry delay formula: `baseMs * 2^(attempt-1)`, capped at `RetryMaxMs` (default 60s).

**Status transitions** via Lua script (`transitionScript`): Atomically decrements the old status counter in `grading:stats` and increments the new one, plus updates the job hash. This ensures accurate queue metrics.

**Dead Letter Queue**: After `MaxAttempts` (default 3) failures, the job is `XADD`'d to `grading:jobs:dlq` with the error message.

**ACK + DELETE**: `ackAndDelete()` uses a transaction pipeline to `XACK` + `XDEL` the message after processing or permanent failure.

### Progress Tracking

Job progress is updated in the Redis hash (`grading:job:{jobId}`) at milestones: 10% (processing started), 80% (grading complete), 90% (DB updated), 100% (result published).

### Result Publishing

After grading, the worker publishes to Redis Pub/Sub:
```go
w.redis.Publish(ctx, "grading:complete", payloadBytes)
```

The Socket.IO server subscribes to this channel and emits `grading:complete` to the `attempt:{attemptId}` room.

---

## API Endpoints (actual routes from code)

### Auth (`apps/api/src/routes/auth.ts`)

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| POST | `/api/auth/register` | No | `registrationLimiter` | Register with bcrypt (10 rounds). Admin/Reviewer need approval |
| POST | `/api/auth/login` | No | `loginLimiter` | Fast-path via Redis session cache, slow-path via bcrypt |
| POST | `/api/auth/refresh` | No | - | Rotate refresh token (new access + refresh) |
| POST | `/api/auth/logout` | No | - | Revoke refresh token, clear session cache |
| POST | `/api/auth/logout-all` | Yes | - | Revoke all tokens, evict all WebSocket sessions |
| GET | `/api/auth/me` | Yes | - | Get current user profile |

### Attempts (`apps/api/src/routes/attempts.ts`)

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/attempts` | Yes | `apiLimiter` | List user's attempts |
| GET | `/api/attempts/:id` | Yes | - | Get single attempt (hides hidden tests from candidates) |
| POST | `/api/attempts` | Yes | - | Start new attempt (checks schedule, max attempts, resumes in-progress) |
| GET | `/api/attempts/:id/starter-files` | Yes | - | Get starter files for code reset |
| PUT | `/api/attempts/:id/files` | Yes | `autosaveLimiter` | Save files to Redis buffer |
| POST | `/api/attempts/:id/run-tests` | Yes | `runTestsLimiter` | Run public tests (preview, low priority stream) |
| POST | `/api/attempts/:id/submit` | Yes | `submissionLimiter` | Final submit (high priority stream, runs public + hidden) |
| POST | `/api/attempts/:id/screenshot` | Yes | `screenshotLimiter` | Upload proctor screenshot (S3 or local) |
| GET | `/api/attempts/:id/screenshots` | Yes | - | List screenshots (Admin/Reviewer/Owner) |
| GET | `/api/attempts/:id/screenshots/live` | Yes | - | Live screenshots from Redis (Admin/Reviewer) |

### Exams (`apps/api/src/routes/exams.ts`)

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/exams` | Yes | Any | List exams (Admin: all, Candidate: published only). Pagination, search, sorting |
| GET | `/api/exams/:id` | Yes | Any | Get exam detail (hides hidden tests from non-Admin) |
| POST | `/api/exams` | Yes | ADMIN | Create exam |
| PUT | `/api/exams/:id` | Yes | ADMIN | Update exam |
| POST | `/api/exams/:id/publish` | Yes | ADMIN | Publish exam |
| POST | `/api/exams/:id/unpublish` | Yes | ADMIN | Unpublish exam |
| DELETE | `/api/exams/:id` | Yes | ADMIN | Delete exam (blocked if attempts exist) |
| GET | `/api/exams/invite/:token` | No | - | Get invitation details |
| POST | `/api/exams/invite/:token/accept` | Yes | - | Accept invitation, validates email binding |
| POST | `/api/exams/:id/invite` | Yes | ADMIN | Create invitation with optional email binding |

### Proctor (`apps/api/src/routes/proctor.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/proctor/event` | Yes | Log TAB_LEAVE, TAB_RETURN, FULLSCREEN_EXIT, PASTE_ATTEMPT events |
| GET | `/api/proctor/events/:attemptId` | Yes (Admin/Reviewer) | Get all proctor events for an attempt |
| GET | `/api/proctor/keystrokes/:attemptId` | Yes (Admin/Reviewer) | Get keystroke stats, typing speed, WPM |

### Reports (`apps/api/src/routes/reports.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/reports/attempts` | Admin/Reviewer | All attempts with search, pagination, integrity flags |
| GET | `/api/reports/exam/:examId` | Admin/Reviewer | Exam report: pass rate, avg score, per-student breakdown |
| GET | `/api/reports/attempt/:attemptId` | Admin/Reviewer | Detailed attempt: score, logs, proctor events, files |
| GET | `/api/reports/dashboard` | Admin/Reviewer | Dashboard stats: total exams, attempts, candidates |
| GET | `/api/reports/analytics` | Admin/Reviewer | Score distribution, daily attempts, top performers |

### WebSocket Events (`apps/api/src/socket/`)

- `grading:complete` -- emitted to `attempt:{id}` room when grading finishes
- `timer:tick` -- emitted every second with `{ remaining, endTime, formattedTime }`
- `timer:expired` -- auto-submit when timer hits zero
- `proctor:warning` -- real-time warning to candidate (tab switch, fullscreen exit, paste)
- `proctor:screenshot` -- screenshot metadata broadcast to monitoring admins
- `keystroke:batch` -- client -> server keystroke data (compressed: `{ k, t, c, s, a, m }`)
- `keystroke:speed` -- client -> server typing speed snapshots (WPM, CPM)
- `auth:refresh` -- client sends new token to re-authenticate socket
- `auth:expired` -- server evicts socket when token expires

---

## Database Schema (actual table/model definitions)

Defined in `packages/database/src/schema.ts` using **Drizzle ORM** with `pgTable`.

### Enums

```typescript
export const roleEnum = pgEnum('role', ['ADMIN', 'CANDIDATE', 'REVIEWER']);
export const attemptStatusEnum = pgEnum('attempt_status', ['IN_PROGRESS', 'SUBMITTED', 'GRADING', 'COMPLETED', 'FAILED']);
export const eventTypeEnum = pgEnum('event_type', ['TAB_LEAVE', 'TAB_RETURN', 'FULLSCREEN_EXIT', 'FULLSCREEN_ENTER', 'PASTE_ATTEMPT']);
export const approvalStatusEnum = pgEnum('approval_status', ['PENDING', 'APPROVED', 'REJECTED']);
```

### Tables

**`users`** -- `id (cuid2 PK)`, `email (unique)`, `password`, `name`, `role`, `approvalStatus`, `approvedBy`, `approvedAt`, `createdAt`, `updatedAt`. Indexes on email, role, approvalStatus.

**`challenges`** -- `id (PK)`, `name`, `description`, `starterFiles (json: Record<string,string>)`, `publicTests (text)`, `hiddenTests (text)`, `dependencies (json: Record<string,string>)`, `nodeVersion`, `runner (json)`, `createdBy -> users.id`. The `runner` JSON field holds the `ChallengeRunner` config (mode, candidate image, test config, SQL config).

**`exams`** -- `id (PK)`, `title`, `description`, `challengeId -> challenges.id`, `timeLimit (minutes)`, `maxAttempts`, `passThreshold (real, default 0.6)`, `scheduledStartAt`, `scheduledEndAt`, `timezone (default Asia/Kolkata)`, `fullscreenRequired`, `tabSwitchLogging`, `pasteDisabled`, `expectedCandidates`, `poolWarmedAt`, `isPublished`, `publishedAt`, `createdBy -> users.id`. Indexes on challengeId, createdBy, isPublished, scheduledEndAt.

**`examInvitations`** -- `id (PK)`, `examId -> exams.id`, `email`, `token (unique)`, `usedAt`, `expiresAt`. Index on token, examId, email.

**`examAttempts`** -- `id (PK)`, `examId -> exams.id`, `candidateId -> users.id`, `status`, `startedAt`, `submittedAt`, `files (json)`, `publicScore`, `hiddenScore`, `totalPublic`, `totalHidden`, `gradingLogs`, `gradedAt`, `tabExits (default 0)`, `totalOutOfWindowSeconds (default 0)`, `fullscreenExits (default 0)`, `pasteAttempts (default 0)`. Indexes on examId, candidateId, status, startedAt.

**`proctorEvents`** -- `id (PK)`, `attemptId -> examAttempts.id`, `eventType`, `timestamp`, `duration`, `pasteLength`, `isMultiline`. Indexes on attemptId, eventType, timestamp.

### Relations

All tables have Drizzle relations defined: `users -> exams (many), attempts (many)`, `challenges -> exams (many)`, `exams -> challenge (one), attempts (many), invitations (many)`, `examAttempts -> exam (one), candidate (one), proctorEvents (many)`.

### Go-Side DB Layer (`apps/grader-go/internal/db/postgres.go`)

Uses `pgxpool` directly (no ORM). `UpdateAttemptResults()` writes scores and logs back to `exam_attempts`:
- Preview mode: updates `public_score`, `total_public`, `grading_logs`
- Submit mode: updates all scores + `status` (COMPLETED or FAILED based on `result.Success`)

---

## Grading Modes Deep Dive

### HTTP Black-Box Grading (`apps/grader-go/internal/grader/http_grader.go`)

`RunHTTPBlackboxGrader()` runs public and hidden tests in separate phases. Each phase (`runHTTPPhase()`):
1. Writes candidate files to a temp dir (filtering blocked paths like `__tests__`, `node_modules`, etc.)
2. Writes test harness to a separate temp dir (installs Jest + supertest)
3. Runs candidate `installCommand` in a container on `bridge` network (internet access for `npm install`)
4. Runs test `installCommand` in a container on `bridge` network
5. Creates an `--internal` network, starts candidate container as detached with `--network-alias candidate`
6. Polls `waitForHTTP()` until the candidate server responds
7. Runs test container on the same `--internal` network with `BASE_URL=http://candidate:PORT`
8. Parses `results.json` (Jest JSON reporter) to extract passed/total counts
9. Cleanup: deferred to `CleanupPool.Submit()` for async docker rm + os.RemoveAll

File security: `blockedPaths` prevents overwriting `package.json`, `jest.config`, test directories. `sanitizeTestLogs()` removes paths like `/var/folders/`, hidden test references, and truncates to 20KB.

### Playwright E2E Grading (`apps/grader-go/internal/grader/playwright_grader.go`)

`RunPlaywrightGrader()` follows the same two-phase pattern but uses `mcr.microsoft.com/playwright:v1.57.0-jammy` as the test image. Test results are parsed from JUnit XML (`results.xml`) via `parseJUnit()`. Test container gets 2x memory limit (min 1024MB). Runtime is set to `"playwright"` for correct tmpfs mounts.

### UI jsdom Grading (`apps/grader-go/internal/grader/ui_jsdom_grader.go`)

`RunUIJsdomGrader()` has two execution paths:
- **Pooled parallel path** (`runPooledUIJsdomParallel()`): Uses `ChallengePoolManager` to get pre-warmed candidate containers. Public and hidden tests run simultaneously in separate test containers sharing the same candidate.
- **Legacy sequential path**: Creates ephemeral containers for each phase.

### SQL Grading (`apps/grader-go/internal/grader/sql_grader.go`)

`RunSQLGrader()` supports two isolation modes:

**Shared mode** (`runSharedPublicTests()`): Executes student SQL against a shared read-only PostgreSQL pool. Uses `pgx.TxOptions{AccessMode: pgx.ReadOnly}` transactions. Compares results against `expectedResult` from challenge config.

**Isolated mode** (`runIsolatedPublicTests()`): Acquires a Docker PostgreSQL container from `SQLContainerPool`, runs `setupScript` to create tables/data, then executes student queries. For hidden tests, uses `SqlDataGenerator` to inject random data with a deterministic seed (`sha256(attemptId + testName)`).

SQL result comparison (`compareResults()` in `sql_compare.go`): Canonicalizes values (time.Time -> RFC3339, float64 -> int64 when exact), optionally sorts rows (order-insensitive by default), and does `reflect.DeepEqual`.

Anti-cheat for SQL: `generateRandomInserts()` in `sql_random.go` supports generators like `RANDOM_INT(min,max)`, `RANDOM_NAME()`, `RANDOM_EMAIL()`, `RANDOM_DATE('start','end')`, `RANDOM_CHOICE('opt1','opt2')`, `SEQUENCE(start)`. Hidden tests compare student output against a reference query result on the same random data.

---

## Autosave & Timer System

### Redis-Buffered Autosave (`apps/api/src/lib/autosave-buffer.ts`)

- `saveToBuffer()` writes to `autosave:{attemptId}` with 12hr TTL, marks attempt as dirty in `autosave:dirty` set
- Background flush runs every 30s (`flushAllDirty()`) -- scans dirty set, writes to PostgreSQL
- `flushToDatabase()` force-flushes a specific attempt (called before submit)
- `getBufferStats()` uses `SCAN` instead of `KEYS` to avoid blocking Redis

### Server-Authoritative Timer (`apps/api/src/socket/timerService.ts`)

- Timer state stored in Redis (`timer:{attemptId}`) for horizontal scaling
- `startTimer()` calculates end time as `min(startedAt + timeLimit, scheduledEndAt)`
- Local `setInterval` broadcasts `timer:tick` every second to the attempt room
- Auto-submit on expiration: `handleTimerExpired()` uses Redis `SET NX` lock to ensure only one instance handles it
- `stopTimerPermanently()` marks timer as handled in Redis (`timer_handled:{attemptId}` with 1hr TTL)
- `resumeTimer()` re-creates local interval from Redis state on reconnect

### Keystroke Analytics (`apps/api/src/socket/keystrokeService.ts`)

- Compressed keystroke batches stored in Redis lists (`keystroke:batch:{attemptId}`) -- max 200 batches, 24hr TTL
- Typing speed snapshots in `keystroke:speed:{attemptId}` -- WPM, CPM, interval
- Aggregate stats in `keystroke:stats:{attemptId}` hash (totalKeystrokes, lastWpm, lastCpm)
- Max batch payload: 50KB to prevent abuse

---

## Socket.IO Horizontal Scaling

### Redis Adapter (`apps/api/src/socket/index.ts`)

```typescript
const pubClient = createAdapterPubClient();
const subClient = createAdapterSubClient();
io.adapter(createAdapter(pubClient, subClient));
```

This enables multiple API instances to broadcast events. Socket eviction for cross-process logout uses a dedicated `socket:evict` Redis channel.

### Token Validation

Periodic (5-minute interval) token re-verification on all connected sockets. Expired tokens trigger `auth:expired` event and socket disconnect. Clients can send `auth:refresh` with a new token.

---

## Challenge Types (32 challenges in `challenges/` directory)

Categories: Express.js (5), React (7), Django (2), Flask (2), FastAPI (2), Go (2), Rust (2), SQL (3), Prisma (1), DOM (2), Full-stack (weather-dashboard, ai-chat-assistant, async-data-loader).

---

## Frequently Asked Questions (Code-Level Specifics)

### Q1: How does the grader prevent students from overwriting test files?

In `http_grader.go`, the `blockedPaths` array includes `__tests__`, `node_modules`, `package.json`, `jest.config`, etc. The `blockedFilePatterns` array has regexes matching `.test.js`, `.spec.tsx`, etc. The `sanitizeFilePath()` function also blocks `..` traversal and absolute paths. The Go grader writes its own test files to a **separate directory** (`testsDir`) that is mounted into the test container, not the candidate container.

### Q2: How does Redis Streams handle a crashed grader worker?

The `reclaimLoop()` goroutine runs every `PelPollMs` (10s). It calls `XPENDING` to find messages idle longer than `PelIdleMs` (60s), then `XCLAIM` to take ownership. The reclaimed messages are re-dispatched through the normal `dispatch()` path. After `MaxAttempts` (3) failures, jobs go to the DLQ (`grading:jobs:dlq`).

### Q3: How is the candidate container prevented from accessing the internet?

Docker networks are created with `--internal` flag in `CreateNetwork()`. This blocks all outbound traffic. The candidate container is attached to this internal network. Dependency installation happens on the `bridge` network (which has internet access) in a separate `RunOnce` container before the candidate server starts.

### Q4: How does the platform handle 500 students from the same college IP?

Rate limiting uses **per-user-ID** keying for authenticated requests (via `userIdKeyGenerator()`). The `globalIPLimiter` is set to 5000 req/s per IP (1-second window), and the per-user `apiLimiter` allows 300 req/min per authenticated user. Redis-backed `RedisStore` ensures distributed rate limit counters. Login rate limiting is per-email, not per-IP.

### Q5: How does the SQL grader prevent cheating on hidden tests?

Hidden SQL tests use `SqlDataGenerator` to inject **random data** seeded by `sha256(attemptId + testName)`. The student's query output is compared against a **reference query** run on the same random data. Since data is different for each student+test combination, hardcoded answers fail. The grader uses a separate `SQLHiddenPool` with potentially different (more) data than the public pool.

### Q6: What happens when a student's timer expires mid-exam?

`timerService.ts` `handleTimerExpired()` acquires a Redis `SET NX` lock (60s TTL), flushes the autosave buffer to DB, updates status to SUBMITTED, queues a full grading job (`addGradingJob()` with both public + hidden tests), then updates to GRADING. The client receives `timer:expired` via Socket.IO. The lock prevents duplicate auto-submissions across API instances.

### Q7: How does the pooled grading path work for UI/jsdom challenges?

`runPooledUIJsdomParallel()` in `ui_jsdom_grader.go` uses `ChallengePoolManager.GetOrCreateCandidate()` to get a pre-warmed container with dependencies already installed. Public and hidden tests run **simultaneously** in separate test containers, both connecting to the same candidate container's network. This halves grading latency for two-phase challenges.

### Q8: How does the async cleanup pool prevent blocking the grading semaphore?

`CleanupPool` (bounded to 8 concurrent goroutines) accepts cleanup functions via `Submit()`. Each function gets a fresh 30-second context (independent of the cancelled grading context). Docker rm, network disconnect, and `os.RemoveAll` run asynchronously without holding the grading semaphore slot. On shutdown, `cleanupPool.Wait()` blocks until all pending cleanups finish.

### Q9: How does the invitation system work for exams?

Admins create invitations via `POST /api/exams/:id/invite` with optional email binding. A unique token is generated via `createId()` (cuid2). If `REQUIRE_EMAIL_FOR_INVITATIONS=true` (default), the invitation's email **must match** the authenticated user's email when accepting. The accept endpoint (`POST /api/exams/invite/:token/accept`) checks expiry, marks the invitation as used, and creates an attempt with starter files.

### Q10: How does the platform ensure grading results reach the client in real-time?

After the Go worker writes results to PostgreSQL, it publishes to Redis Pub/Sub channel `grading:complete`. The Socket.IO server (in `apps/api/src/socket/index.ts`) subscribes to this channel via `redisSubscriber`. The `handleGradingComplete()` function emits to `io.to(\`attempt:${attemptId}\`).emit('grading:complete', { result, isPreview })`. For preview runs, it also releases the `grading:lock:{attemptId}` Redis key so the student can run tests again.

### Q11: How does the pool warmup system work?

`PoolManager.SubscribeWarmup()` listens on Redis pub/sub channel `pool:warmup`. When a `WarmupRequest` arrives (with examID, expectedCandidates, startsAt), it acquires a Redis `SET NX` lock (5min), calculates pool size (`candidates * 0.3 * 5 submissions`, clamped 5-50), then calls `containerPool.Warm()` and `networkPool.Warm()`. Status is tracked in `pool:warmup:status:{examId}`.

### Q12: How is the Go grader's concurrency determined?

In `config.go`: `autoConcurrency := runtime.NumCPU() / 3`. Each grading job runs ~4 Docker containers (candidate install, test install, candidate server, test run), so ~3 vCPUs per job. On a 4-core machine, default concurrency = 1. On 12 cores, default = 4. Overridable via `GRADING_CONCURRENCY` env var.

---

## Design Tradeoffs

1. **Docker CLI vs Docker API**: Uses `exec.CommandContext("docker", ...)` instead of the Docker Go SDK. Simpler, fewer dependencies, easier debugging (can reproduce commands manually), but slightly higher overhead per container operation.

2. **Network pooling enabled, container pooling disabled**: Networks are lightweight and reusable. Containers need specific code/deps per job, making pooling impractical without workspace mounting. Comment in `main.go`: "Container pooling would require workspace mounting which is not implemented."

3. **XPENDING + XCLAIM instead of XAUTOCLAIM**: Azure Redis doesn't support `XAUTOCLAIM` (requires Redis 6.2+). The manual approach filters by idle time client-side, adding one more round-trip but ensuring Azure compatibility.

4. **Lua script for status transitions**: `transitionScript` atomically updates both the job hash and the stats counters. Without atomicity, counters could drift under concurrent updates.

5. **Separate SQLPool for hidden tests**: `SQLHiddenPool` can point to a database with more/different test data. This prevents students from inspecting public test data and reverse-engineering hidden test answers.

6. **Redis autosave buffer**: Writes go to Redis first (instant), then flush to PostgreSQL every 30s. This reduces DB write pressure during exams (300 students saving every few seconds) while preserving data safety via Redis persistence.

7. **Server-authoritative timers**: Timers tick on the server, not the client. This prevents time manipulation. State in Redis enables horizontal scaling -- any API instance can resume a timer.

8. **Per-user rate limiting over per-IP**: The college scenario (500 students, 1 public IP) makes IP-based rate limiting unusable. Using JWT `userId` as the rate limit key gives each student their own quota.

---

## What Makes This Impressive

1. **Go + Redis Streams grading engine**: The 3-goroutine consumer model (`processingLoop` + `reclaimLoop` + `retryLoop`) with semaphore-based concurrency control is production-grade queue infrastructure, not a toy implementation.

2. **True container isolation**: `--internal` networks prevent internet access, `--read-only` filesystem with targeted tmpfs mounts, `--user 1000:1000` non-root, `--pids-limit 150`, memory limits with no swap. Each grading job gets a fresh container and network.

3. **Multi-paradigm challenge support**: Four distinct grading modes (HTTP black-box, Playwright E2E, jsdom unit, SQL) with proper abstractions (`ChallengeRunner` struct, `RunGrader()` dispatcher, per-mode file security).

4. **SQL anti-cheat with random data**: Deterministic random data generation seeded by `sha256(attemptId + testName)` makes hardcoded SQL answers impossible. Reference query comparison instead of expected result sets means hidden test answers don't exist in the challenge config.

5. **Comprehensive proctoring**: Tab-switch detection, fullscreen monitoring, paste blocking, keystroke analytics (WPM/CPM tracking), screenshot capture to S3, integrity scoring -- all with real-time Socket.IO alerts to reviewers.

6. **College-scale rate limiting**: 9 distinct rate limiters, all Redis-backed for distributed enforcement, all using per-user-ID keying for authenticated routes. The `globalIPLimiter` (5000 req/s per IP) coexists with per-user limits (300 req/min).

7. **Horizontal scaling architecture**: Socket.IO Redis adapter, Redis-backed timers, Redis-backed session cache, distributed rate limiting -- everything needed to run multiple API instances behind a load balancer.

8. **Async cleanup pool**: The `CleanupPool` (8 concurrent goroutines, 30s timeout contexts) prevents Docker cleanup from blocking the grading pipeline -- a subtle but critical optimization for throughput.

9. **Refresh token rotation with breach detection**: Token families tracked in Redis. Reuse of a revoked token triggers revocation of the entire family -- a security pattern from OAuth 2.0 best practices.

10. **32 challenge templates** spanning Express, React, Django, Flask, FastAPI, Go, Rust, SQL, Prisma, and DOM manipulation -- demonstrating the platform's multi-runtime support.
