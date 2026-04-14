# CP Tracker -- Source Code Reference

## CircuitBreaker -- execute Method
The circuit breaker wraps external API calls with fault tolerance. When closed, it executes normally. When open, it rejects immediately or uses a fallback. After the reset timeout, it transitions to half-open to test recovery.
```javascript
class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeout = options.resetTimeout || 60000;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failureCount = 0;
        this.metrics = { totalRequests: 0, totalFailures: 0,
                         totalSuccesses: 0, averageResponseTime: 0 };
    }

    async execute(operation, fallback = null) {
        this.metrics.totalRequests++;
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttemptTime) {
                if (fallback) return await fallback();
                throw new Error(`Circuit breaker '${this.name}' is OPEN`);
            }
            this.state = 'HALF_OPEN';
        }
        try {
            const result = await operation();
            this.onSuccess(Date.now());
            return result;
        } catch (error) {
            await this.onFailure(error, Date.now(), fallback);
            throw error;
        }
    }
}
```

## CircuitBreaker -- onSuccess and onFailure
onSuccess resets the failure counter and restores a half-open circuit to closed. onFailure increments the counter and opens the circuit when the threshold is exceeded, optionally invoking a fallback.
```javascript
onSuccess(startTime) {
    this.failureCount = 0;
    this.successCount++;
    this.metrics.totalSuccesses++;
    if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
    }
}

async onFailure(error, startTime, fallback) {
    this.failureCount++;
    this.metrics.totalFailures++;
    this.lastFailureTime = Date.now();
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        this.metrics.totalTimeouts++;
    }
    if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        this.nextAttemptTime = Date.now() + this.resetTimeout;
        if (fallback) return await fallback();
    }
}
```

## CodeforcesService -- Rate Limiting
Enforces strict rate limits matching Codeforces API constraints: 1 request per 2 seconds, max 30/minute, single concurrency. Cleans request history each check and blocks when limits are reached.
```javascript
class CodeforcesService {
    constructor() {
        this.rateLimit = {
            requestsPerMinute: parseInt(process.env.CF_REQUESTS_PER_MINUTE) || 30,
            minRequestInterval: parseInt(process.env.CF_MIN_INTERVAL_MS) || 2000,
            requestHistory: [],
            maxConcurrent: parseInt(process.env.CF_MAX_CONCURRENT) || 1,
            currentConcurrent: 0
        };
        this.circuitBreaker = circuitBreakerFactory.getBreaker('codeforces-api', {
            failureThreshold: 5, resetTimeout: 120000
        });
    }

    async checkRateLimit() {
        const now = Date.now();
        this.rateLimit.requestHistory = this.rateLimit.requestHistory.filter(
            ts => now - ts < 60000
        );
        if (this.rateLimit.requestHistory.length >= this.rateLimit.requestsPerMinute) {
            const waitTime = 60000 - (now - Math.min(...this.rateLimit.requestHistory));
            if (waitTime > 0) await this.sleep(waitTime);
        }
        const timeSinceLast = now - this.lastRequestTime;
        if (timeSinceLast < this.rateLimit.minRequestInterval)
            await this.sleep(this.rateLimit.minRequestInterval - timeSinceLast);
    }
}
```

## CodeforcesService -- makeRequest
Makes rate-limited, circuit-breaker-protected HTTP requests to the Codeforces API. Adds optional API key authentication, tracks concurrent requests, and falls back to cached data when the circuit opens.
```javascript
async makeRequest(endpoint, params = {}) {
    return await this.circuitBreaker.execute(
        async () => {
            await this.checkRateLimit();
            this.rateLimit.currentConcurrent++;
            try {
                const finalParams = this.addAuthParams(endpoint, params);
                const url = `${this.baseURL}/${endpoint}`;
                const response = await axios.get(url, {
                    params: finalParams, timeout: 30000,
                    headers: { 'User-Agent': 'TLE-Eliminators-Student-Management/1.0' }
                });
                this.lastRequestTime = Date.now();
                this.rateLimit.requestHistory.push(this.lastRequestTime);
                if (response.data.status !== 'OK')
                    throw new CodeforcesError(`API Error: ${response.data.comment}`);
                return response.data.result;
            } finally {
                this.rateLimit.currentConcurrent--;
            }
        },
        async () => this.getCachedData(endpoint, params)  // fallback
    );
}
```

## CodeforcesService -- syncStudentData
Orchestrates the full data sync for a single student: fetches user info, submissions, and contest history from Codeforces, processes them in batches for memory safety, and updates problem statistics. Includes retry logic with exponential backoff.
```javascript
async syncStudentData(studentId, retryCount = 0) {
    return await performanceManager.executeWithMemoryCheck(async () => {
        const student = await Student.findById(studentId);
        student.syncStatus = 'syncing';
        await student.save();

        const userInfo = await this.getUserInfo(student.codeforcesHandle);
        await this.updateStudentFromUserInfo(student, userInfo);

        const submissions = await this.getUserSubmissions(student.codeforcesHandle);
        await this.processSubmissionsBatched(student, submissions);

        const contests = await this.getUserContests(student.codeforcesHandle);
        await this.processContestHistory(student, contests);
        await this.updateProblemStatistics(student);

        student.markSynced();
        await student.save();
        return { success: true };
    }).catch(async (error) => {
        if (retryCount < this.maxRetries && !error.isCircuitBreakerError) {
            await this.sleep(this.retryDelay);
            return this.syncStudentData(studentId, retryCount + 1);
        }
        student.markSyncFailed(error.message);
        throw error;
    });
}
```

## CronService -- Daily Sync Scheduling
Manages scheduled jobs using node-cron. The daily sync runs at a configurable time (default 2 AM UTC) and can be toggled on/off or triggered manually.
```javascript
class CronService {
    constructor() {
        this.jobs = new Map();
        this.defaultSyncTime = process.env.SYNC_CRON_TIME || '0 2 * * *';
        this.syncEnabled = process.env.AUTO_SYNC_ENABLED === 'true';
    }

    scheduleDailySync() {
        const syncJob = cron.schedule(this.defaultSyncTime, async () => {
            const startTime = Date.now();
            const results = await codeforcesService.syncAllStudents();
            const duration = Date.now() - startTime;
            console.log(`Daily sync: ${results.success} ok, ${results.failed} failed in ${duration}ms`);
            if (results.failed > 0)
                results.errors.forEach(e => console.warn(`  - ${e.name}: ${e.error}`));
        }, { scheduled: false, timezone: 'UTC' });

        if (this.syncEnabled) syncJob.start();
        this.jobs.set('dailySync', { job: syncJob, name: 'Daily Codeforces Sync',
            schedule: this.defaultSyncTime, enabled: this.syncEnabled });
    }
}
```

## CronService -- Inactivity Check
Runs daily at 3 AM after sync completes. Finds students with no submissions in 7+ days and sends bulk email notifications via the email service.
```javascript
scheduleInactivityCheck() {
    const inactivityJob = cron.schedule('0 3 * * *', async () => {
        const inactiveStudents = await Student.findInactive();
        if (inactiveStudents.length === 0) return;

        const emailResults = await emailService.sendBulkInactivityNotifications(
            inactiveStudents
        );
        console.log(`Inactivity: ${emailResults.sent} sent, ${emailResults.failed} failed`);
    }, { scheduled: true, timezone: 'UTC' });

    this.jobs.set('inactivityCheck', {
        job: inactivityJob,
        name: 'Inactivity Check & Notifications',
        schedule: '0 3 * * *', enabled: true
    });
}
```

## Student Model Schema
Mongoose schema with Codeforces profile data, problem statistics, sync tracking, and inactivity notifications. Includes compound indexes, virtual fields, and static finder methods.
```javascript
const studentSchema = new Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phoneNumber: { type: String, required: true },
    codeforcesHandle: { type: String, required: true, unique: true },
    currentRating: { type: Number, default: 0 },
    maxRating: { type: Number, default: 0 },
    codeforcesData: {
        rank: { type: String, default: 'unrated' },
        maxRank: { type: String, default: 'unrated' },
        avatar: String, country: String, organization: String,
        contribution: { type: Number, default: 0 },
        lastOnlineTimeSeconds: { type: Number, default: 0 }
    },
    problemStats: {
        totalSolved: { type: Number, default: 0 },
        averageRating: { type: Number, default: 0 },
        ratingDistribution: { type: Map, of: Number }
    },
    syncStatus: { type: String, enum: ['pending','syncing','success','failed'], default: 'pending' },
    lastSubmissionDate: { type: Date, default: null },
    inactivityNotifications: { emailsSent: { type: Number, default: 0 },
        lastEmailSent: Date, emailsDisabled: { type: Boolean, default: false } }
}, { timestamps: true });
```

## Student Model -- Virtual Fields and Static Methods
Virtual properties compute inactivity status and sync needs on-the-fly. Static methods provide commonly-used query patterns for active, inactive, and sync-needed students.
```javascript
studentSchema.virtual('isInactive').get(function() {
    if (!this.lastSubmissionDate) return true;
    return this.daysSinceLastSubmission > 7;
});

studentSchema.virtual('needsSync').get(function() {
    if (!this.lastSyncedAt) return true;
    const diffHours = Math.abs(new Date() - this.lastSyncedAt) / (1000 * 60 * 60);
    return diffHours > 24;
});

studentSchema.statics.findInactive = function() {
    return this.find({
        isDeleted: false,
        $or: [
            { lastSubmissionDate: null },
            { lastSubmissionDate: { $lt: new Date(Date.now() - 7*24*60*60*1000) } }
        ]
    });
};

studentSchema.statics.findNeedsSync = function() {
    return this.find({
        isDeleted: false,
        $or: [
            { lastSyncedAt: null },
            { lastSyncedAt: { $lt: new Date(Date.now() - 24*60*60*1000) } },
            { syncStatus: 'failed' }
        ]
    });
};
```

## Analytics Controller -- getDashboard
Computes dashboard data with parallel optimized queries: total/active/inactive student counts, recent submission count, top performers by rating, rating distribution via MongoDB $bucket aggregation, sync status summary, and daily submission activity.
```javascript
const getDashboard = async (req, res) => {
    const periodDays = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const fromDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const [totalStudents, activeStudents, inactiveStudents,
           recentSubmissions, topPerformers] = await Promise.all([
        Student.countDocuments({ isDeleted: false }),
        Student.countDocuments({ isDeleted: false, isActive: true }),
        Student.countDocuments({ isDeleted: false,
            $or: [{ lastSubmissionDate: null },
                  { lastSubmissionDate: { $lt: new Date(Date.now()-7*24*3600*1000) } }] }),
        Submission.countDocuments({
            creationTimeSeconds: { $gte: Math.floor(fromDate.getTime()/1000) } }),
        Student.find({ isDeleted: false, isActive: true })
            .sort({ currentRating: -1 }).limit(10)
            .select('name codeforcesHandle currentRating maxRating').lean()
    ]);

    const ratingDistribution = await Student.aggregate([
        { $match: { isDeleted: false, currentRating: { $gt: 0 } } },
        { $bucket: { groupBy: '$currentRating',
            boundaries: [0,1200,1400,1600,1900,2100,2400,4000],
            output: { count: { $sum: 1 }, avgRating: { $avg: '$currentRating' } } } }
    ]);
};
```

## Analytics Controller -- getStudentHeatmap
Returns a GitHub-style submission heatmap for a student. Aggregates submissions by day using MongoDB date functions, then maps daily counts to 0-4 intensity levels.
```javascript
const getStudentHeatmap = async (req, res) => {
    const startOfYear = new Date(yearInt, 0, 1);
    const endOfYear = new Date(yearInt + 1, 0, 1);

    const dailySubmissions = await Submission.aggregate([
        { $match: {
            studentId: student._id,
            creationTimeSeconds: {
                $gte: Math.floor(startOfYear.getTime() / 1000),
                $lt: Math.floor(endOfYear.getTime() / 1000) }
        }},
        { $group: {
            _id: { $dateToString: {
                format: '%Y-%m-%d',
                date: { $toDate: { $multiply: ['$creationTimeSeconds', 1000] } } } },
            count: { $sum: 1 },
            accepted: { $sum: { $cond: ['$isAccepted', 1, 0] } }
        }},
        { $sort: { '_id': 1 } }
    ]);

    const heatmapData = dailySubmissions.map(day => ({
        date: day._id, count: day.count, accepted: day.accepted,
        level: Math.min(4, Math.floor(day.count / 2))
    }));
};
```
