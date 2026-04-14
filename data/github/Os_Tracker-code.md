# OS Tracker -- Source Code Reference

## syncRepository -- Main Sync Function
The core sync function fetches a student's commits, pull requests, and issues from a GitHub repository using the Octokit API. It uses pagination to handle large repos and upserts each contribution into PostgreSQL.
```typescript
export async function syncRepository(
  repositoryId: number, username: string,
  owner: string, repoName: string
): Promise<{ success: boolean; contributions_count: number; error?: string }> {
  const client = await pool.connect();
  const syncLogId = await createSyncLog(client, repositoryId, username);
  try {
    let totalCount = 0;
    const errors: string[] = [];

    // Fetch commits with pagination
    let page = 1; let hasMore = true;
    while (hasMore) {
      const commitsResponse = await octokit.repos.listCommits({
        owner, repo: repoName, author: username, per_page: 100, page
      });
      for (const commit of commitsResponse.data) {
        await upsertContribution(client, {
          repository_id: repositoryId,
          student_id: await getStudentIdFromRepo(client, repositoryId),
          type: 'commit', external_id: commit.sha,
          title: commit.commit.message.split('\n')[0],
          url: commit.html_url, state: null,
          created_at: commit.commit.author?.date || new Date().toISOString(),
        });
        totalCount++;
      }
      hasMore = commitsResponse.data.length >= 100;
      page++;
    }
    // ... also fetches PRs and issues similarly
    return { success: errors.length < 3, contributions_count: totalCount };
  } finally { client.release(); }
}
```

## syncRepository -- PR Fetching with Search API
For pull requests, the function first tries the GitHub Search API (faster, fetches only the user's PRs) and falls back to paginating through all PRs if search fails. Batch-fetches full PR details in groups of 10.
```typescript
// Strategy 1: GitHub Search API (fast, user-scoped)
const searchResponse = await octokit.search.issuesAndPullRequests({
  q: `repo:${owner}/${repoName} author:${username} type:pr`,
  per_page: 100, page: searchPage, sort: 'updated', order: 'desc',
});

// Batch fetch full PR details
const batchSize = 10;
for (let i = 0; i < searchResponse.data.items.length; i += batchSize) {
  const batch = searchResponse.data.items.slice(i, i + batchSize);
  const batchPromises = batch.map(async (item) => {
    const fullPR = await octokit.pulls.get({
      owner, repo: repoName, pull_number: item.number
    });
    if (fullPR.data.user?.login.toLowerCase() === username.toLowerCase())
      return fullPR.data;
    return null;
  });
  allUserPRs.push(...(await Promise.all(batchPromises)).filter(Boolean));
  await new Promise(resolve => setTimeout(resolve, 100)); // rate limit
}
```

## upsertContribution -- SQL Upsert
Inserts a contribution (commit, PR, or issue) into the contributions table with ON CONFLICT to update existing records. Uses parameterized queries with JSON metadata.
```typescript
async function upsertContribution(client: any, contribution: {
  repository_id: number; student_id: number;
  type: 'commit' | 'pull_request' | 'issue';
  external_id: string; title: string; url: string;
  state: string | null; created_at: string; metadata: any;
}) {
  await client.query(
    `INSERT INTO contributions (
      repository_id, student_id, type, external_id, title, url, state,
      created_at, updated_at, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (repository_id, type, external_id)
    DO UPDATE SET
      title = EXCLUDED.title, url = EXCLUDED.url,
      state = EXCLUDED.state, updated_at = EXCLUDED.updated_at,
      metadata = EXCLUDED.metadata, synced_at = CURRENT_TIMESTAMP`,
    [contribution.repository_id, contribution.student_id,
     contribution.type, contribution.external_id, contribution.title,
     contribution.url, contribution.state, contribution.created_at,
     contribution.updated_at, JSON.stringify(contribution.metadata)]
  );
}
```

## Leaderboard SQL Query
Ranks students by merged PR count using a FILTER clause for conditional aggregation. Supports optional month and organization filters via dynamic parameterized query building.
```typescript
export async function GET(request: NextRequest) {
  const limit = parseInt(searchParams.get('limit') || '10');
  const month = searchParams.get('month');
  const organization_id = searchParams.get('organization_id');

  let query = `
    SELECT 
      s.id as student_id, s.github_username, s.student_name,
      COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'pull_request'
        AND c.state = 'merged') as merged_prs_count,
      MAX(c.created_at) FILTER (WHERE c.type = 'pull_request'
        AND c.state = 'merged') as last_pr_date
    FROM students s
    LEFT JOIN contributions c ON s.id = c.student_id
    LEFT JOIN repositories r ON c.repository_id = r.id
    WHERE 1=1
  `;
  if (month) { query += ` AND DATE_TRUNC('month', c.created_at) = DATE_TRUNC('month', $1::date)`; }
  query += ` GROUP BY s.id HAVING COUNT(...) > 0
             ORDER BY merged_prs_count DESC LIMIT $N`;
  const result = await pool.query(query, params);
}
```

## Stats SQL Queries
Returns per-student statistics with contribution type breakdowns and per-repository detail. Uses conditional COUNT with CASE expressions to compute commits, PRs, and issues in a single query.
```typescript
const statsQuery = `
  SELECT 
    s.id as student_id, s.github_username, s.student_name,
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
`;

const reposQuery = `
  SELECT r.id, r.owner, r.name, r.full_name,
    COUNT(CASE WHEN c.type = 'commit' THEN 1 END) as commits,
    COUNT(CASE WHEN c.type = 'pull_request' THEN 1 END) as prs,
    COUNT(CASE WHEN c.type = 'issue' THEN 1 END) as issues
  FROM repositories r
  LEFT JOIN contributions c ON r.id = c.repository_id
  WHERE r.student_id = $1
  GROUP BY r.id ORDER BY r.created_at DESC
`;
```

## Cron API Route Handler
Next.js API route that triggers a full sync of all repositories. Protected by a Bearer token from the CRON_SECRET environment variable, designed to be called by Vercel Cron or an external scheduler.
```typescript
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await syncAllRepositories();
    return NextResponse.json({ message: 'Sync completed successfully' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

## syncAllRepositories -- Batch Orchestration
Initializes the database, queries all repositories joined with their students, and syncs each one sequentially. Reports per-repo success/failure and a final summary count.
```typescript
export async function syncAllRepositories() {
  await initDatabase();
  const result = await pool.query(`
    SELECT r.id, r.owner, r.name, s.github_username
    FROM repositories r
    JOIN students s ON r.student_id = s.id
    ORDER BY r.id
  `);

  const results = [];
  for (const repo of result.rows) {
    try {
      const syncResult = await syncRepository(
        repo.id, repo.github_username, repo.owner, repo.name
      );
      results.push({ repository: `${repo.owner}/${repo.name}`, ...syncResult });
    } catch (error: any) {
      results.push({ repository: `${repo.owner}/${repo.name}`,
                      success: false, error: error.message });
    }
  }
  const successCount = results.filter(r => r.success).length;
  console.log(`Sync completed: ${successCount}/${result.rows.length} successful`);
  return results;
}
```

## Cron Job Scheduler
Registers a daily cron job at 2 AM using node-cron that triggers the full repository sync pipeline.
```typescript
import cron from 'node-cron';
import { syncAllRepositories } from './cron-sync';

export function startDailySync() {
  cron.schedule('0 2 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Starting daily sync...`);
    try {
      await syncAllRepositories();
      console.log(`[${new Date().toISOString()}] Daily sync completed`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Daily sync failed:`, error);
    }
  });
  console.log('Daily sync job scheduled (runs at 2 AM daily)');
}
```

## db.ts -- Pool Setup and Database Initialization
Creates a PostgreSQL connection pool with SSL, then initializes the full schema: students, organizations, repositories, contributions, and sync_logs tables with foreign keys, constraints, and performance indexes.
```typescript
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE students (
      id SERIAL PRIMARY KEY,
      github_username VARCHAR(255) UNIQUE NOT NULL,
      student_name VARCHAR(255), email VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query(`CREATE TABLE repositories (
      id SERIAL PRIMARY KEY,
      owner VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id),
      UNIQUE(student_id, owner, name)
    )`);
    await client.query(`CREATE TABLE contributions (
      id SERIAL PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL CHECK (type IN ('commit','pull_request','issue')),
      external_id VARCHAR(255) NOT NULL,
      title TEXT, url TEXT NOT NULL, state VARCHAR(50),
      metadata JSONB, synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, type, external_id)
    )`);
    await client.query(`
      CREATE INDEX idx_contributions_student_id ON contributions(student_id);
      CREATE INDEX idx_contributions_type ON contributions(type);
      CREATE INDEX idx_contributions_created_at ON contributions(created_at);
    `);
  } finally { client.release(); }
}
```
