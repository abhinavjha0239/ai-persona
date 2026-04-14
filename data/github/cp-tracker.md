# CP Tracker -- Competitive Programming Student Progress System

## Quick Summary
"TLE Eliminators - Student Progress Management System" -- a full-stack MERN application for tracking competitive programming students' Codeforces progress. The Express.js backend syncs student data from the Codeforces API (user info, contest ratings, submissions) with circuit breaker fault tolerance and sophisticated rate limiting (min 2s between requests, max 1 concurrent). Data is stored in MongoDB with four models (Student, Contest, Submission, RatingHistory). Cron jobs run daily sync at 2 AM UTC and inactivity detection at 3 AM. Inactive students (no submissions in 7+ days) receive styled HTML email notifications via Nodemailer/Gmail. Features analytics dashboards, leaderboards, student comparison, CSV export, and submission heatmaps.

GitHub repo: `abhinavjha0239/cp-tracker`

## Architecture (Actual File Paths)

```
backend/
  server.js               -- Express app, MongoDB connect, route mounting, cron init
  routes/
    students.js            -- CRUD routes for student management
    codeforces.js          -- Proxy routes for Codeforces API data
    analytics.js           -- Dashboard, rating graphs, heatmaps, leaderboard
    sync.js                -- Sync trigger, status, settings, history, retry
  controllers/
    studentController.js   -- Student CRUD logic with pagination/filtering
    codeforcesController.js -- Codeforces data fetching and formatting
    analyticsController.js -- Dashboard stats, rating distribution, comparisons
    syncController.js      -- SyncController class: cron management, full/student sync
  models/
    Student.js             -- Student schema (personal info, CF data, problemStats, inactivity tracking)
    Contest.js             -- Contest schema (CF contest info, problems, participant count)
    Submission.js          -- Submission schema (verdict, rating, language, analytics aggregation statics)
    RatingHistory.js       -- Rating change records per contest
  services/
    codeforcesService.js   -- CodeforcesService class: API calls, sync pipeline, rate limiting
    cronService.js         -- CronService class: daily sync, inactivity check, cleanup, health
    emailService.js        -- EmailService class: Nodemailer transporter, HTML email templates
  utils/
    circuitBreaker.js      -- CircuitBreaker class + CircuitBreakerFactory singleton
    healthMonitor.js       -- Service health checks (CF API, email, DB, memory)
    performanceManager.js  -- Memory-aware execution, batched processing
    migration.js           -- Database migration utilities
  middleware/
    errorHandler.js        -- Global error handler, custom error classes
    logger.js              -- Request logging, analytics logger, performance logger
frontend/                  -- React frontend (Vite)
```

## Technical Details

### Codeforces API Integration
`CodeforcesService` in `backend/services/codeforcesService.js` is a singleton class managing all CF API interactions.

**Rate limiting** is multi-layered:
```javascript
this.rateLimit = {
    requestsPerMinute: parseInt(process.env.CF_REQUESTS_PER_MINUTE) || 30,
    requestsPerHour: parseInt(process.env.CF_REQUESTS_PER_HOUR) || 1800,
    minRequestInterval: parseInt(process.env.CF_MIN_INTERVAL_MS) || 2000,
    requestHistory: [],
    maxConcurrent: parseInt(process.env.CF_MAX_CONCURRENT) || 1,
    currentConcurrent: 0
};
```

`checkRateLimit()` enforces: (1) minimum 2s between any two requests, (2) max requests per minute (default 30), (3) max 1 concurrent request. When syncing all students, adds 5s delay between students and 10s between batches.

**API authentication** supports optional API key/secret with SHA-512 HMAC signature generation via `generateApiSignature()`:
```javascript
const signatureString = `${rand}/${methodName}?${sortedParams}#${this.apiSecret}`;
const hash = crypto.createHash('sha512').update(signatureString).digest('hex');
```

**Core API methods**: `getUserInfo(handle)` -> `user.info`, `getUserContests(handle)` -> `user.rating`, `getUserSubmissions(handle)` -> `user.status`, `getContestList()` -> `contest.list`. All go through `makeRequest()` which wraps the circuit breaker.

### Circuit Breaker Implementation
`CircuitBreaker` class in `backend/utils/circuitBreaker.js` implements the standard three-state pattern:

**States**: CLOSED (normal) -> OPEN (failures >= threshold) -> HALF_OPEN (after reset timeout)

```javascript
class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeout = options.resetTimeout || 60000;
        this.state = 'CLOSED';
        this.failureCount = 0;
    }
    async execute(operation, fallback = null) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttemptTime) {
                if (fallback) return await fallback();
                throw error; // with isCircuitBreakerError = true
            }
            this.state = 'HALF_OPEN';
        }
        // ... try operation, onSuccess/onFailure
    }
}
```

The Codeforces API circuit breaker is configured with `failureThreshold: 5, resetTimeout: 120000` (2 minutes). When open, fallback returns cached/empty data via `getCachedData()`. `CircuitBreakerFactory` is a singleton map of named breakers.

Metrics tracked: totalRequests, totalFailures, totalSuccesses, totalTimeouts, averageResponseTime, failureRate, successRate.

### MongoDB Models

**Student** (`backend/models/Student.js`): Core fields include `name`, `email`, `phoneNumber`, `codeforcesHandle` (unique), `currentRating`, `maxRating`. Nested `codeforcesData` object stores rank, avatar, country, organization, etc. `problemStats` tracks totalSolved, averageRating, ratingDistribution (Map). `inactivityNotifications` tracks emailsSent count and lastEmailSent date. Key virtuals: `daysSinceLastSubmission`, `isInactive` (>7 days), `needsSync` (>24 hours). Static methods: `findInactive()`, `findNeedsSync()`, `findActive()`.

**Submission** (`backend/models/Submission.js`): Stores every CF submission with `submissionId` (unique), `verdict` (enum of 18 possible values like OK, WRONG_ANSWER, TLE), `problemRating`, `problemTags[]`, `programmingLanguage`. Pre-save middleware sets `isAccepted = (verdict === 'OK')`. Critical aggregation static:

```javascript
submissionSchema.statics.getStatsByStudent = function(studentId) {
    return this.aggregate([
        { $match: { studentId, isAccepted: true, isActive: true } },
        { $group: {
            _id: null,
            uniqueProblemsCount: { $addToSet: { contestId: '$contestId', index: '$problemIndex' } },
            averageRating: { $avg: '$problemRating' },
            maxRating: { $max: '$problemRating' }
        }},
        { $project: { uniqueProblemsCount: { $size: '$uniqueProblemsCount' } } }
    ]);
};
```

Also provides `getRecentActivity(studentId, days)` aggregation that groups submissions by date for heatmap data.

**Contest** (`backend/models/Contest.js`): Stores CF contest data with `contestId`, `contestName`, `type` (CF/IOI/ICPC), `phase`, `durationSeconds`, `startTimeSeconds`, nested `problems[]` array.

**RatingHistory** (`backend/models/RatingHistory.js`): Per-contest rating changes with `oldRating`, `newRating`, `ratingChange`, `rank`.

### Student Data Sync Pipeline
`syncStudentData(studentId)` in `CodeforcesService`:
1. Load student from MongoDB, set `syncStatus = 'syncing'`
2. `getUserInfo(handle)` -> update `codeforcesData`, ratings
3. `getUserSubmissions(handle)` -> `processSubmissionsBatched()` using `performanceManager.processBatched()` to prevent memory issues
4. `getUserContests(handle)` -> `processContestHistory()` saves RatingHistory entries, updates ratings
5. `updateProblemStatistics()` -> runs Submission aggregation pipeline
6. `student.markSynced()` -> sets `syncStatus='success'`, clears syncError

`syncAllStudents()` finds students where `syncStatus in ['pending','failed']` or `lastSyncedAt < 24h ago`, processes in batches with 5s inter-student delay and 10s inter-batch delay.

### Cron Jobs
`CronService` in `backend/services/cronService.js` manages four scheduled jobs:

| Job | Schedule | Description |
|---|---|---|
| dailySync | `0 2 * * *` (2 AM UTC) | Calls `codeforcesService.syncAllStudents()` |
| inactivityCheck | `0 3 * * *` (3 AM UTC) | Finds inactive students, sends bulk email notifications |
| cleanup | `0 4 * * 0` (4 AM Sunday) | Cleans temp files (>24h old), database maintenance |
| healthCheck | `0 * * * *` (hourly) | Logs memory usage, checks service connectivity |

Sync is conditional on `AUTO_SYNC_ENABLED=true`. Schedule is configurable via `PUT /api/sync/settings` which validates cron expressions with `cron.validate()`.

### Email Notifications
`EmailService` in `backend/services/emailService.js` uses Nodemailer with Gmail SMTP. Three email types:

1. **Inactivity notification** (`sendInactivityNotification`): Styled HTML with gradient header, student's current stats (rating, problems solved), motivational tips, links to CF profile and problemset. Tracks reminder count per student.
2. **Welcome email** (`sendWelcomeEmail`): Onboarding with feature overview and profile summary.
3. **Progress report** (`sendProgressReport`): Weekly stats cards (submissions, problems solved, rating).

Bulk sending via `sendBulkInactivityNotifications()` with 1s delay between emails. Respects `emailsDisabled` flag per student.

### Sync Controller
`SyncController` class in `backend/controllers/syncController.js` exposes:
- `POST /api/sync/trigger` -- Manual sync (type: 'all' or 'student')
- `GET /api/sync/status` -- Parallel queries for student counts by syncStatus, total submissions/ratings
- `PUT /api/sync/settings` -- Update cron schedule, enable/disable sync
- `POST /api/sync/retry-failed` -- Retry all students with `syncStatus: 'failed'`
- `GET /api/sync/queue` -- Shows pending, stale (>24h), never-synced students

### Dashboard Analytics
`analyticsController.js` provides `GET /api/analytics/dashboard` with parallel MongoDB queries:
- Total/active/inactive student counts
- Recent submission counts
- Top 10 performers by rating
- Rating distribution via `$bucket` aggregation (boundaries: 0, 1200, 1400, 1600, 1900, 2100, 2400, 4000)

### API Rate Limiting
Express `express-rate-limit` middleware: 100 requests per 15-minute window per IP on all `/api/` routes. Configurable via `API_RATE_LIMIT_WINDOW_MS` and `API_RATE_LIMIT_MAX`.

## Frequently Asked Questions

### Q1: How does the Codeforces sync handle API rate limits without getting banned?
Three layers: (1) `minRequestInterval: 2000ms` enforced between any two requests, (2) `requestHistory` array tracks timestamps, blocks if 30+ requests in last minute, (3) `maxConcurrent: 1` prevents parallel requests. During `syncAllStudents()`, an additional 5s sleep between students and 10s between batches accounts for multiple API calls per student (user.info + user.status + user.rating).

### Q2: What happens when the Codeforces API goes down?
The circuit breaker opens after 5 consecutive failures, blocking requests for 2 minutes. In OPEN state, `makeRequest()` calls the fallback function `getCachedData()` which returns empty arrays or stub user objects. After the reset timeout, the breaker transitions to HALF_OPEN and allows one test request -- if it succeeds, the breaker closes; if it fails, it reopens.

### Q3: How are inactive students detected?
`Student.findInactive()` queries for students where `lastSubmissionDate` is null or older than 7 days:
```javascript
studentSchema.statics.findInactive = function() {
    return this.find({ 
        isDeleted: false,
        $or: [
            { lastSubmissionDate: { $exists: false } },
            { lastSubmissionDate: null },
            { lastSubmissionDate: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
        ]
    });
};
```
The 3 AM cron job calls this, then `emailService.sendBulkInactivityNotifications()`. Each student's `inactivityNotifications.emailsSent` count is incremented.

### Q4: How does the submission aggregation pipeline work for analytics?
`Submission.getStatsByStudent()` runs a MongoDB aggregation: $match by studentId and isAccepted, $group with `$addToSet` on {contestId, problemIndex} to count unique solved problems, `$avg`/`$max`/`$min` on problemRating. A separate `getRecentActivity()` aggregation groups by `$dateToString` format for heatmap visualization.

### Q5: How is the sync controller's cron job reconfigurable at runtime?
`updateSyncSettings()` validates the new cron expression with `cron.validate()`, stops the existing job (`cronJob.stop()` + `destroy()`), creates a new `cron.schedule()` with the updated expression, and stores settings in memory. The schedule, enabled flag, and emailNotifications toggle are all runtime-configurable via `PUT /api/sync/settings`.

### Q6: What security measures are in place?
- Helmet.js for HTTP security headers (CSP, X-Frame-Options, etc.)
- CORS whitelist with origin validation (localhost:3000/5173/4173 + CLIENT_URL)
- express-rate-limit at 100 req/15min per IP
- Input validation on all controller methods
- Mongoose schema validation with regex patterns for email, phone, CF handle
- Graceful shutdown handlers (SIGTERM/SIGINT) close DB connections and stop cron jobs

### Q7: How does the system handle duplicate submissions during sync?
`createOrUpdateSubmission()` first checks `Submission.findOne({ submissionId: submission.id })`. If found, it skips (`return`). This is idempotent -- re-syncing a student won't create duplicate records. Similarly, `processContestHistory()` checks for existing RatingHistory entries by (studentId, contestId, ratingUpdateTimeSeconds) before inserting.

### Q8: What is the performance optimization for large submission histories?
`processSubmissionsBatched()` uses `performanceManager.processBatched()` to process submissions in configurable batch sizes, preventing Node.js memory exhaustion when a student has 100k+ submissions. `syncStudentData()` is wrapped in `performanceManager.executeWithMemoryCheck()` which monitors heap usage before proceeding.

## Design Tradeoffs

1. **In-memory sync history vs database**: `syncHistory` is stored in the SyncController instance (capped at 1000 entries). Simple but lost on restart. Acceptable since sync_logs in DB provide persistent audit trail.

2. **Circuit breaker fallback returns empty data**: When the CF API is down, the system returns empty arrays rather than stale cached data. Conservative approach -- avoids showing outdated ratings. A Redis cache layer would be the upgrade path.

3. **Single-threaded sync**: Students sync sequentially (not in parallel) to respect CF rate limits. A student with many submissions blocks the queue. Tradeoff: correctness over throughput.

4. **MongoDB vs PostgreSQL**: Chose MongoDB for flexible schema (nested codeforcesData, problemStats with Map, variable-length problemTags arrays). The submission aggregation pipeline is a natural fit for MongoDB's $group/$addToSet.

5. **Email credentials in source**: Gmail SMTP credentials appear directly in `emailService.js` (hardcoded as fallback). Should be purely env-var driven in production.

## What Makes This Impressive

- **Production-grade fault tolerance**: Circuit breaker pattern with CLOSED/OPEN/HALF_OPEN states, fallback functions, failure metrics tracking, and configurable thresholds. Not a toy implementation -- includes timeout detection, concurrent request limiting, and factory pattern for multiple breakers.
- **Comprehensive Codeforces integration**: Handles all four major API endpoints (user.info, user.rating, user.status, contest.list) with proper rate limiting that respects CF's 1-request-per-2-seconds rule, API key authentication with SHA-512 signatures, and retry logic.
- **Rich analytics pipeline**: MongoDB aggregation pipelines for rating distribution ($bucket), submission heatmaps ($dateToString grouping), problem difficulty analysis, and multi-student comparison. The Submission model alone has 6 aggregation statics.
- **Automated monitoring**: Four cron jobs covering sync, inactivity detection, cleanup, and health monitoring. Inactivity emails with styled HTML templates and per-student notification tracking.
- **Memory-aware processing**: `performanceManager` wraps sync operations with heap usage checks and batched processing to handle students with enormous submission histories.
