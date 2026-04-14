# GSoC Tracker -- Open Source Contribution Tracking Dashboard

## Quick Summary
GSoC Tracker is a Next.js full-stack dashboard for tracking students' open-source contributions to Google Summer of Code (GSoC), SBoC, and other programs. It syncs pull requests from the GitHub API for tracked students, stores them in PostgreSQL via Prisma, and provides a filterable dashboard with stats, pagination, tagging, and sorting. Features include bulk CSV import of students, GitHub PR sync (with fallback from Search API to Events API), organization tagging for filtering by program, and a leaderboard sorted by merged PRs or lines of code.

**Repo:** `abhinavjha0239/gsoc-tracker`
**Language:** TypeScript (Next.js full-stack)
**Key Dependencies:** Next.js, Prisma, GitHub REST API, csv-parse

## Architecture (actual file paths)

```
prisma/
  schema.prisma                     -- 6 models: Student, Organization, Repository, PullRequest, Tag, OrganizationTag
app/
  page.tsx                          -- Dashboard with stats cards, quick actions, recent activity
  layout.tsx                        -- Root layout with tag filter context
  students/                         -- Student list + add student pages
  organizations/                    -- Organization list + detail pages
  tags/                             -- Tag management page
  components/
    RecentActivity.tsx              -- Recent PR activity feed
    TagFilterContext.tsx             -- Global tag filter state (React context)
  lib/
    prisma.ts                       -- Prisma client singleton
    github.ts                       -- GitHub API client (user PRs, org PRs, events fallback)
    csv-import.ts                   -- CSV student import with upsert
  api/
    stats/                          -- GET: dashboard stats (filterable by tag)
    students/
      route.ts                      -- GET: paginated student list; POST: add student
      [id]/
        route.ts                    -- GET/PATCH/DELETE: student detail + update + remove
        sync/                       -- POST: sync single student's PRs
      sync-all/route.ts             -- POST: bulk sync all tracked students
      master/                       -- GET: master student list (all students from CSV)
    organizations/
      route.ts                      -- GET: organization list with tag filtering
    tags/
      route.ts                      -- GET/POST/DELETE: tag CRUD
    recent-activity/                -- GET: recent PRs across all students
scripts/
  migrate-to-postgres.js            -- SQLite -> PostgreSQL migration script
  test-connection.js                -- Database connection test
  exported-data/                    -- Data export backups
data/
  students.csv                      -- Source CSV for student import
```

## Technical Details

### 1. Prisma Schema (`prisma/schema.prisma`)

Six models with a many-to-many tagging system:

```prisma
model Student {
  id              String        @id @default(cuid())
  githubUsername   String?       @unique
  isTracked       Boolean       @default(false)
  name            String
  sstEmail        String        @unique
  contributedOrgs String?       // JSON array: '["CCExtractor", "AOSSIE-Org"]'
  lastSyncedAt    DateTime?
  pullRequests    PullRequest[]
}

model PullRequest {
  prNumber   Int
  title      String
  url        String
  state      String // "open" | "closed" | "merged"
  additions  Int        @default(0)
  deletions  Int        @default(0)
  createdAt  DateTime
  mergedAt   DateTime?
  studentId  String
  repoId     String
  student    Student    @relation(fields: [studentId], references: [id], onDelete: Cascade)
  repository Repository @relation(fields: [repoId], references: [id])
  @@unique([prNumber, repoId])
}
```

The `OrganizationTag` join table implements many-to-many between `Organization` and `Tag` with a composite primary key `@@id([orgId, tagId])`. The `contributedOrgs` field on `Student` stores a JSON-serialized array of org names discovered during sync.

### 2. GitHub API Client (`app/lib/github.ts`)

Three strategies for fetching PRs, with automatic fallback:

**Primary: GitHub Search API** (`fetchUserPRs()`):
```typescript
let query = `type:pr author:${escapedUsername} is:public`;
if (since) {
    query += ` created:>=${sinceDate}`;
}
const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=30&page=${page}`;
```
Paginates up to 10 pages (300 PRs). Handles rate limiting (403 -> 60s sleep) and 422 errors (falls back to Events API).

**Fallback: Events API** (`fetchPRsFromEvents()`):
When the Search API returns 422 (happens for some valid users), falls back to scanning the user's public events for `PullRequestEvent` types, extracting contributed repo names, then fetching PRs from each repo. Limited to ~300 events (90 days).

**Org-specific: Direct repo scanning** (`fetchPRsFromOrg()`):
For students with known `contributedOrgs`, fetches all repos from those orgs (up to 500), then scans each repo's PRs filtering by the student's username. Deduplicates using a `Set<string>` with `${repoFullName}#${prNumber}` keys.

All three methods include rate limiting (`sleep(200-1000ms)` between API calls) and respect the `since` parameter for incremental sync.

### 3. Bulk Sync Pipeline (`app/api/students/sync-all/route.ts`)

The `POST /api/students/sync-all` endpoint syncs all tracked students sequentially:

```typescript
for (const student of students) {
    // 1. Fetch PRs via Search API
    let prs = await fetchUserPRs(student.githubUsername, since);
    
    // 2. Also fetch from contributed orgs (if known)
    for (const orgName of studentOrgs) {
        const orgPrs = await fetchPRsFromOrg(student.githubUsername, orgName, since);
        // Merge and dedupe
    }
    
    // 3. Upsert orgs, repos, and PRs
    for (const pr of prs) {
        let org = await prisma.organization.findUnique({ where: { name: pr.orgName } });
        if (!org) org = await prisma.organization.create({ data: { name: pr.orgName, ... } });
        // Same for repo...
        
        const existingPR = await prisma.pullRequest.findUnique({
            where: { prNumber_repoId: { prNumber: pr.prNumber, repoId: repo.id } },
        });
        if (existingPR) { /* update state */ } else { /* create */ }
    }
    
    // 4. Update contributedOrgs with newly discovered orgs
    await prisma.student.update({
        data: { lastSyncedAt: new Date(), contributedOrgs: JSON.stringify(updatedOrgs) },
    });
}
```

Supports `?full=true` query param to ignore `lastSyncedAt` and re-sync everything. Returns per-student results with created/updated counts and errors.

### 4. Paginated Student List with Tag Filtering (`app/api/students/route.ts`)

The GET endpoint supports pagination, search, batch filtering, tracking status filtering, sorting, and tag-based PR filtering:

```typescript
// Filter PRs by tag (filters through org -> tag join table)
const prWhere: Prisma.PullRequestWhereInput = tag ? {
    repository: {
        organization: {
            tags: { some: { tagId: tag } }
        }
    }
} : {};

// Calculate total lines for each student (only MERGED PRs)
const studentsWithStats = students.map((student) => ({
    ...student,
    totalLines: student.pullRequests
        .filter((pr) => pr.state === 'merged')
        .reduce((sum, pr) => sum + pr.additions + pr.deletions, 0),
    mergedPRs: student.pullRequests.filter((pr) => pr.state === 'merged').length,
}));
```

Sorting options: `name` (alphabetical), `prs` (total PR count), `lines` (total lines of merged PRs). Pagination is applied after sorting (in-memory sort then slice).

### 5. CSV Student Import (`app/lib/csv-import.ts`)

Bulk imports students from a CSV file using Prisma upsert:

```typescript
export async function importStudentsFromCSV(): Promise<{ imported: number; skipped: number }> {
    const csvPath = path.join(process.cwd(), 'data', 'students.csv');
    const records: CSVStudent[] = parse(fileContent, {
        columns: true, skip_empty_lines: true,
    });
    for (const record of records) {
        await prisma.student.upsert({
            where: { sstEmail: record.sst_email },
            update: { name: record.name, mobile: record.mobile, ... },
            create: { sstEmail: record.sst_email, name: record.name, isTracked: false, ... },
        });
    }
}
```

Uses `sst_email` as the unique key for upsert. Maps CSV columns (`sst_email`, `name`, `mobile`, `personal_email`, `batch`, `roll_number`, `profile_photo_url`) to Prisma model fields. Skips records without email and catches individual record errors without aborting the entire import.

### 6. Tag Management (`app/api/tags/route.ts`)

Simple CRUD for tags with organization count:

```typescript
export async function GET() {
    const tags = await prisma.tag.findMany({
        include: { _count: { select: { organizations: true } } },
        orderBy: { name: 'asc' },
    });
    return NextResponse.json(tags);
}

export async function POST(request: NextRequest) {
    const { name, color } = body;
    const tag = await prisma.tag.create({
        data: { name, color: color || '#2563eb' },
    });
}
```

Tags have a `name` (unique) and `color` (hex, defaults to blue). The `OrganizationTag` join table connects tags to organizations. Deleting a tag cascades to remove all `OrganizationTag` entries.

### 7. Student Detail and PR Management (`app/api/students/[id]/route.ts`)

The GET endpoint returns a student with all PRs, including repository and organization info:

```typescript
const student = await prisma.student.findUnique({
    where: { id },
    include: {
        pullRequests: {
            orderBy: { createdAt: 'desc' },
            include: {
                repository: {
                    include: {
                        organization: {
                            include: { tags: { select: { tagId: true } } },
                        },
                    },
                },
            },
        },
    },
});
```

PATCH supports updating `githubUsername`, `isTracked`, and `contributedOrgs` (accepts array, stringifies for storage). DELETE removes tracking by nullifying `githubUsername`, setting `isTracked: false`, and deleting all associated PRs (`prisma.pullRequest.deleteMany({ where: { studentId: id } })`).

### 8. Dashboard with Tag Filter Context (`app/page.tsx`)

The dashboard fetches stats filtered by the global tag selection:

```typescript
const { selectedTagId, selectedTag, loading: tagLoading } = useTagFilter();

const fetchStats = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedTagId) params.set('tag', selectedTagId);
    const res = await fetch(`/api/stats?${params}`);
    const data = await res.json();
    setStats(data);
}, [selectedTagId]);
```

Stats include: totalStudents, trackedStudents, totalPRs, mergedPRs, totalOrgs. All filterable by the selected tag (which filters through the org -> tag join table).

## Frequently Asked Questions

**Q: How does the GitHub sync work?**
A: Three strategies with automatic fallback. Primary: GitHub Search API (`type:pr author:USERNAME is:public`), paginating up to 300 PRs. If Search API returns 422, falls back to Events API (scans user's public events for PullRequestEvent, finds contributed repos, then fetches PRs from each). Additionally, for students with known `contributedOrgs`, directly scans those orgs' repos. All methods include rate limiting (200-1000ms sleep between API calls) and deduplication using `${repoFullName}#${prNumber}` keys.

**Q: How does the tagging system filter data?**
A: Tags are attached to Organizations via the `OrganizationTag` join table. When a tag is selected, PRs are filtered through `repository.organization.tags.some.tagId`. This propagates to student stats (PR count, merged PRs, lines of code) so the leaderboard shows only contributions to tagged organizations. The dashboard stats endpoint also accepts a `tag` query parameter.

**Q: How does the CSV import handle duplicates?**
A: Uses Prisma `upsert` with `sstEmail` as the unique key. If a student with that email already exists, their fields are updated. If not, a new record is created with `isTracked: false`. Individual record errors are caught and counted as "skipped" without aborting the import.

**Q: How is pagination implemented?**
A: The students API accepts `page`, `limit`, `search`, `batch`, `tracked`, `sortBy`, and `tag` query parameters. Prisma fetches all matching students with PR stats, then sorts in-memory (by name, PR count, or total lines), then slices for pagination. Returns `{ students, pagination: { page, limit, total, totalPages } }`.

**Q: How does incremental sync differ from full sync?**
A: Incremental sync (default) passes `student.lastSyncedAt` as the `since` parameter to the GitHub API, only fetching PRs created after the last sync. Full sync (`?full=true`) passes `since: undefined`, re-fetching all PRs. Both modes use upsert for PRs (find by `prNumber + repoId` composite key, update state if exists, create if new).

**Q: How are lines of code calculated?**
A: Only from MERGED PRs. The student list endpoint filters `pullRequests.filter(pr => pr.state === 'merged')` then sums `additions + deletions`. This prevents inflating stats with open/closed PRs. The `additions` and `deletions` fields come from the GitHub API during sync.

**Q: How does the contributed orgs discovery work?**
A: During sync, the system collects all unique org names from fetched PRs: `const newOrgs = [...new Set(prs.map(pr => pr.orgName))]`. These are merged with existing `contributedOrgs` and saved back as a JSON array string. On subsequent syncs, these known orgs are scanned directly (via `fetchPRsFromOrg`), which catches PRs that the Search API might miss.

**Q: What was the SQLite to PostgreSQL migration?**
A: The project started with SQLite (`dev.db`) but hit concurrent access limits in production. Migration scripts in `scripts/migrate-to-postgres.js` handle the data transfer. The Prisma schema was updated to use `provider = "postgresql"` with `DATABASE_URL` from env vars. Export scripts in `scripts/exported-data/` provide backups.

## Design Tradeoffs

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| PostgreSQL (migrated from SQLite) | PostgreSQL via Prisma | Keep SQLite | SQLite failed under concurrent access in production deployment; PostgreSQL handles concurrent reads/writes properly |
| In-memory sort + slice for pagination | Fetch all, sort, paginate in Node | SQL ORDER BY + OFFSET/LIMIT | Need to compute derived fields (totalLines, mergedPRs) from PR aggregation before sorting; Prisma doesn't support computed column ordering. Acceptable for <500 students |
| JSON string for contributedOrgs | `String` field with `JSON.parse/stringify` | Separate join table | Avoids an extra table and complex queries for a simple list of org names. Prisma's PostgreSQL JSON type would work but this field is only read/written as a whole |
| GitHub Search API + Events fallback | Multi-strategy with fallback | Search API only | GitHub Search API returns 422 for some valid users; Events API covers the gap. Direct org scanning catches PRs to private-fork repos that Search misses |
| Sequential student sync | Process one student at a time | Parallel with Promise.all | GitHub API rate limits (5000/hour authenticated, 60/hour unauthenticated). Sequential processing with 200-1000ms delays avoids hitting limits |
| Composite unique key for PRs | `@@unique([prNumber, repoId])` | URL as unique key | PR numbers are unique within a repo but not globally. Composite key enables natural upsert logic |
| No authentication | Public dashboard | Admin login | This is an internal tool for tracking contributions within a cohort; the URL itself is the access control. Adding auth would slow down the common use case |

## What Makes This Impressive

1. **Multi-strategy GitHub API integration** -- Not a naive "call Search API and hope." Implements three fallback strategies (Search -> Events -> Direct Org Scan) with deduplication, rate limiting, and incremental sync. Handles real-world GitHub API quirks (422 for valid users, rate limits, missing PRs from Search).

2. **Tag-based hierarchical filtering** -- Tags on organizations propagate through the entire data model (org -> repo -> PR -> student stats). A single tag filter changes the leaderboard, dashboard stats, and per-student metrics. Implemented with Prisma's nested `where` clauses through three levels of relations.

3. **Contributed orgs discovery** -- The system learns which organizations each student contributes to and stores them for faster future syncs. New orgs discovered during sync are automatically added. This avoids scanning all GSoC orgs for every student.

4. **Production-ready data pipeline** -- CSV import with upsert, incremental vs. full sync toggle, per-student error handling in bulk operations, and data export scripts. The SQLite -> PostgreSQL migration shows real production debugging experience.

5. **Leaderboard with meaningful metrics** -- Sorts by merged PRs or lines of code (only from merged PRs, not open/closed). Prevents gaming stats with unmerged PRs. Filters by tag so you can compare contributions to specific programs (GSoC vs. SBoC).

6. **Clean API design with query parameter filtering** -- Single endpoint handles search, batch filter, tracking status filter, tag filter, sort order, and pagination. Returns computed stats per student (totalLines, mergedPRs) alongside the raw data.
