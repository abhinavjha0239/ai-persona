# OS Tracker -- Open Source Contribution Tracker

## Quick Summary
A Next.js (TypeScript) application for tracking students' open-source contributions across GitHub organizations. Admins register students (by GitHub username), assign repositories (including org repos), and the system syncs commits, pull requests, and issues via the GitHub API (Octokit). Data is stored in PostgreSQL with raw SQL queries (no ORM). Features a leaderboard ranked by merged PRs, per-student contribution dashboards, organization views, mentor management, and automated daily sync via Vercel Cron. The architecture is a Next.js App Router monolith with API routes serving as the backend and React Server Components for the admin panel.

GitHub repo: `abhinavjha0239/Os_Tracker`

## Architecture (Actual File Paths)

```
app/
  layout.tsx                      -- Root layout
  page.tsx                        -- Landing page
  admin/
    page.tsx                      -- Admin dashboard (client component, stats overview)
    students/                     -- Student management UI
    organizations/                -- Org management UI
    mentors/                      -- Mentor management UI
  leaderboard/page.tsx            -- Public leaderboard
  students/                       -- Student profile pages
  mentors/                        -- Mentor views
  organizations/                  -- Organization views
  api/
    students/
      route.ts                    -- GET (list with merged PR counts), POST (create)
      [id]/route.ts               -- GET/PUT/DELETE per student
      stats/route.ts              -- Student-level stats
    repositories/
      route.ts                    -- GET (list with joins), POST (create with URL parsing)
    contributions/
      route.ts                    -- GET (grouped by type: commits, pullRequests, issues)
    organizations/
      route.ts                    -- GET (with student/repo/PR counts), POST (create)
    leaderboard/
      route.ts                    -- GET (ranked by merged PRs, filterable by month/org)
    stats/
      route.ts                    -- GET (per-student or all-students contribution stats)
    sync/
      route.ts                    -- POST (trigger sync for repo or student)
    cron/
      route.ts                    -- GET (Vercel Cron endpoint, auth via CRON_SECRET)
    init/                         -- Database initialization endpoint
    mentors/                      -- Mentor CRUD
    user/                         -- User-related endpoints
lib/
  db.ts                           -- PostgreSQL Pool (pg), initDatabase() schema creation
  db-types.ts                     -- TypeScript interfaces (Student, Repository, Contribution, etc.)
  github.ts                       -- Octokit instance, parseRepoUrl(), isValidUsername()
  sync.ts                         -- syncRepository() -- core sync logic with pagination
  cron-sync.ts                    -- syncAllRepositories() -- iterates all repos
  cron-job.ts                     -- startDailySync() via node-cron at 2 AM
  types.ts                        -- Shared types
  colors.ts                       -- UI color utilities
vercel.json                       -- Cron config: path=/api/cron, schedule="0 2 * * *"
```

## Technical Details

### PostgreSQL Schema (Raw SQL)
`initDatabase()` in `lib/db.ts` creates 5 tables with raw `client.query()` calls:

**students** table:
```sql
CREATE TABLE students (
    id SERIAL PRIMARY KEY,
    github_username VARCHAR(255) UNIQUE NOT NULL,
    student_name VARCHAR(255),
    email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

**organizations** table: `id SERIAL PRIMARY KEY`, `name VARCHAR(255) UNIQUE`, `github_org_name VARCHAR(255) UNIQUE`.

**repositories** table: Links student to repo with `student_id INTEGER REFERENCES students(id) ON DELETE CASCADE`, `organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`, `is_organization_repo BOOLEAN DEFAULT FALSE`. Unique constraint: `UNIQUE(student_id, owner, name)`.

**contributions** table: Core data table with polymorphic `type` column:
```sql
CREATE TABLE contributions (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('commit', 'pull_request', 'issue')),
    external_id VARCHAR(255) NOT NULL,
    title TEXT,
    url TEXT NOT NULL,
    state VARCHAR(50),
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    metadata JSONB,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id, type, external_id)
)
```

**sync_logs** table: Audit trail with `status CHECK (IN ('success', 'error', 'partial'))`, `contributions_count`, `error_message`, `started_at`, `completed_at`.

Performance indexes created:
```sql
CREATE INDEX idx_contributions_repository_id ON contributions(repository_id);
CREATE INDEX idx_contributions_student_id ON contributions(student_id);
CREATE INDEX idx_contributions_type ON contributions(type);
CREATE INDEX idx_contributions_created_at ON contributions(created_at);
```

### GitHub API Sync Logic
`syncRepository()` in `lib/sync.ts` is the core function. It fetches three types of contributions with full pagination handling:

**Commits**: Uses `octokit.repos.listCommits({ owner, repo, author: username, per_page: 100, page })`. Paginates until `data.length < 100`. Each commit is upserted with sha as external_id, first line of message as title, and metadata containing full message, author name, and email.

**Pull Requests** (optimized dual strategy):
```typescript
// Strategy 1: GitHub Search API (fast, user-specific)
const searchResponse = await octokit.search.issuesAndPullRequests({
    q: `repo:${owner}/${repoName} author:${username} type:pr`,
    per_page: 100,
    page: searchPage,
    sort: 'updated',
    order: 'desc',
});
// Then batch-fetch full PR details in groups of 10
const batchPromises = batch.map(async (item) => {
    const fullPR = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    // Verify author matches (search can include co-authored PRs)
    if (fullPR.data.user?.login.toLowerCase() === username.toLowerCase()) return fullPR.data;
});
```
If Search API fails (rate limit), falls back to `octokit.pulls.list({ state: 'all' })` and filters client-side by `pr.user?.login`. If 1000+ PRs found via search, logs a warning about the search API result limit.

**Issues**: Uses `octokit.issues.listForRepo({ creator: username, state: 'all' })`. Filters out pull requests (`!issue.pull_request`).

**Upsert pattern** (ON CONFLICT):
```sql
INSERT INTO contributions (repository_id, student_id, type, external_id, title, url, state, created_at, updated_at, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (repository_id, type, external_id)
DO UPDATE SET
    title = EXCLUDED.title, url = EXCLUDED.url, state = EXCLUDED.state,
    updated_at = EXCLUDED.updated_at, metadata = EXCLUDED.metadata,
    synced_at = CURRENT_TIMESTAMP
```

### Vercel Cron Setup
`vercel.json` configures a daily cron:
```json
{ "crons": [{ "path": "/api/cron", "schedule": "0 2 * * *" }] }
```

The `app/api/cron/route.ts` handler verifies `CRON_SECRET` via Bearer token in the Authorization header, then calls `syncAllRepositories()`. This function queries all repositories joined with students, iterates sequentially, and calls `syncRepository()` for each.

### API Routes -- Key SQL Queries

**GET /api/students** -- Lists students with merged PR counts:
```sql
SELECT s.*, COUNT(DISTINCT c.id)
    FILTER (WHERE c.type = 'pull_request' AND c.state = 'merged') as merged_prs_count
FROM students s
LEFT JOIN repositories r ON r.student_id = s.id
LEFT JOIN contributions c ON c.repository_id = r.id
GROUP BY s.id ORDER BY s.created_at DESC
```

**GET /api/leaderboard** -- Ranked by merged PRs with month/org filtering:
```sql
SELECT s.id as student_id, s.github_username, s.student_name,
    COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'pull_request' AND c.state = 'merged') as merged_prs_count,
    MAX(c.created_at) FILTER (WHERE c.type = 'pull_request' AND c.state = 'merged') as last_pr_date
FROM students s
LEFT JOIN contributions c ON s.id = c.student_id
LEFT JOIN repositories r ON c.repository_id = r.id
WHERE 1=1
    AND DATE_TRUNC('month', c.created_at) = DATE_TRUNC('month', $1::date)  -- optional month filter
    AND r.organization_id = $2                                               -- optional org filter
GROUP BY s.id, s.github_username, s.student_name
HAVING COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'pull_request' AND c.state = 'merged') > 0
ORDER BY merged_prs_count DESC, s.student_name ASC
LIMIT $3
```

**GET /api/stats** (per-student with repo breakdown):
```sql
SELECT s.id as student_id, s.github_username, s.student_name,
    COUNT(DISTINCT r.id) as total_repos,
    COUNT(CASE WHEN c.type = 'commit' THEN 1 END) as total_commits,
    COUNT(CASE WHEN c.type = 'pull_request' THEN 1 END) as total_prs,
    COUNT(CASE WHEN c.type = 'issue' THEN 1 END) as total_issues,
    COUNT(c.id) as total_contributions,
    MAX(c.synced_at) as last_sync
FROM students s
LEFT JOIN repositories r ON s.id = r.student_id
LEFT JOIN contributions c ON r.id = c.repository_id
WHERE s.id = $1
GROUP BY s.id, s.github_username, s.student_name
```

Then a second query gets per-repository breakdown with commit/PR/issue counts.

**GET /api/organizations** -- With aggregated counts:
```sql
SELECT o.*,
    COUNT(DISTINCT r.student_id) as student_count,
    COUNT(DISTINCT r.id) as repo_count,
    COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'pull_request' AND c.state = 'merged') as merged_prs_count
FROM organizations o
LEFT JOIN repositories r ON r.organization_id = o.id
LEFT JOIN contributions c ON c.repository_id = r.id
GROUP BY o.id ORDER BY o.name
```

**GET /api/contributions** -- Grouped by type:
```sql
SELECT c.*, r.owner, r.name as repo_name, r.full_name
FROM contributions c
JOIN repositories r ON c.repository_id = r.id
WHERE c.repository_id = $1 AND c.student_id = $2
ORDER BY c.created_at DESC LIMIT 100
```
Results are grouped into `{ commits: [...], pullRequests: [...], issues: [...] }` in the API response.

### Repository URL Parsing
`parseRepoUrl()` in `lib/github.ts` handles multiple formats:
- `https://github.com/owner/repo` and `https://github.com/owner/repo.git`
- `owner/repo` shorthand
- Strips `.git` suffix, validates hostname is github.com

### Admin Panel
Client-side React component at `app/admin/page.tsx`. Loads stats by fetching `/api/students`, `/api/organizations`, `/api/mentors` in parallel. Then iterates students to count repositories. Displays 4 stat cards (Students, Organizations, Repositories, Mentors) with glassmorphism styling. Links to sub-pages for managing students, organizations, and mentors.

### PostgreSQL Connection
`lib/db.ts` creates a `pg.Pool` with `DATABASE_URL` from environment, SSL enabled (`rejectUnauthorized: false` for hosted PG). Error handler on pool calls `process.exit(-1)` on idle client errors.

### TypeScript Interfaces
`lib/db-types.ts` defines: `Student`, `Organization`, `Repository`, `Contribution` (with `type: 'commit' | 'pull_request' | 'issue'`), `SyncLog`, `StudentStats` (with nested `repos[]` array).

## Frequently Asked Questions

### Q1: Why use raw SQL instead of an ORM like Prisma or Drizzle?
The app uses `pg.Pool` with parameterized `pool.query()` calls throughout. This gives full control over complex queries (like the leaderboard with `FILTER (WHERE ...)` clauses and `DATE_TRUNC` filtering) without ORM abstraction overhead. The queries use PostgreSQL-specific features like `FILTER`, `JSONB`, and `ON CONFLICT ... DO UPDATE` that ORMs may not express cleanly.

### Q2: How does the PR sync avoid fetching all PRs in large repos?
The dual-strategy approach first uses GitHub's Search API (`octokit.search.issuesAndPullRequests`) with query `repo:owner/name author:username type:pr`. This returns only the user's PRs, not all PRs in the repo. For a repo with 10,000 PRs where the student authored 5, this fetches ~5 results instead of paginating through 100 pages. Falls back to `pulls.list` with client-side filtering only if the Search API fails.

### Q3: How does the Vercel Cron work?
`vercel.json` declares a cron job at `path: "/api/cron", schedule: "0 2 * * *"` (daily 2 AM UTC). Vercel's infrastructure sends a GET request to `/api/cron` at that schedule. The handler checks `authorization: Bearer CRON_SECRET` header, then calls `syncAllRepositories()` which queries all repos from the database and syncs each sequentially.

### Q4: How are contribution upserts idempotent?
The `contributions` table has a `UNIQUE(repository_id, type, external_id)` constraint. The `upsertContribution()` function uses `INSERT ... ON CONFLICT DO UPDATE SET title = EXCLUDED.title, state = EXCLUDED.state, ...`. This means re-syncing a repository updates existing contributions (e.g., PR state changed from 'open' to 'merged') without creating duplicates.

### Q5: How does the leaderboard handle monthly filtering?
The leaderboard query uses PostgreSQL's `DATE_TRUNC('month', c.created_at) = DATE_TRUNC('month', $1::date)` where `$1` is formatted as `YYYY-MM-01`. This efficiently filters contributions to a specific month. Combined with the `HAVING` clause that requires `merged_prs_count > 0`, only students with merged PRs in that month appear.

### Q6: What data does the JSONB metadata column store?
For commits: `{ sha, message, author_name, author_email }`. For PRs: `{ number, merged_at, body, draft }`. For issues: `{ number, body, labels }`. The JSONB type allows flexible schema per contribution type without separate tables, and supports PostgreSQL JSON querying if needed.

### Q7: How does the system distinguish organization repos from personal repos?
When adding a repository via `POST /api/repositories`, the caller optionally passes `organization_id`. The route sets `is_organization_repo = true` if an organization_id is provided. This allows filtering repos by organization in queries (e.g., leaderboard scoped to a specific org).

### Q8: What happens if a GitHub API call fails during sync?
`syncRepository()` wraps each contribution type (commits, PRs, issues) in separate try/catch blocks. If commits fail but PRs succeed, the sync log records status `'partial'` (not total failure). The function returns `{ success: errors.length < 3, contributions_count, error }` -- only a complete failure of all three types is marked `success: false`.

## Design Tradeoffs

1. **Raw SQL vs ORM**: Chose raw `pg` queries for full PostgreSQL feature access (FILTER, JSONB, ON CONFLICT). Trades type safety and migration tooling for query expressiveness and zero abstraction overhead.

2. **Sequential sync**: Repositories sync one at a time in `syncAllRepositories()`. Prevents GitHub API rate limit issues but means a student with 50 repos takes 50x longer. Parallel sync with concurrency limits would be the upgrade.

3. **Monolith (Next.js API routes as backend)**: All logic in one deployable unit on Vercel. Simple deployment but couples frontend and backend scaling. The API routes are essentially an Express-like backend inside Next.js.

4. **JSONB metadata vs separate columns**: Contributions use a generic JSONB column for type-specific data. Flexible but sacrifices queryability -- you can't index individual metadata fields as easily as dedicated columns.

5. **Vercel Cron vs dedicated worker**: Using Vercel's built-in cron means the sync runs as a serverless function with timeout limits. Long syncs (many repos) might hit Vercel's function timeout. A dedicated background worker (e.g., on Railway or Render) would be more robust for large-scale syncing.

6. **No authentication on admin panel**: The admin UI at `/admin` has no auth gate -- anyone with the URL can manage students and organizations. Suitable for internal/trusted use but needs auth for production deployment.

## What Makes This Impressive

- **Dual-strategy GitHub API sync**: The Search API optimization for PRs is a thoughtful performance improvement. Instead of paginating through thousands of PRs in popular repos, it queries only the user's PRs -- reducing API calls by orders of magnitude.
- **Production PostgreSQL schema design**: Proper foreign keys with CASCADE/SET NULL, unique constraints for idempotent upserts, CHECK constraints on enum columns, JSONB for flexible metadata, and performance indexes on all join/filter columns.
- **Complex analytical SQL**: The leaderboard query with `COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'pull_request' AND c.state = 'merged')`, `DATE_TRUNC` filtering, `HAVING` clauses, and dynamic parameterized WHERE conditions demonstrates strong SQL skills.
- **Full Vercel integration**: Leverages Vercel Cron, Next.js App Router API routes, and serverless deployment in a cohesive architecture. The `vercel.json` cron config, Bearer token auth on the cron endpoint, and database connection pooling are production-ready patterns.
- **Comprehensive contribution tracking**: Syncs three contribution types (commits, PRs, issues) with full metadata, handles PR state transitions (open -> merged), filters out PRs from the issues endpoint, and provides both per-student and per-organization analytics.
