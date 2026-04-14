# Contest Tracker with AI Tutor

## Quick Summary

A full-stack web application that helps competitive programmers track coding contests across Codeforces, LeetCode, CodeChef, and AtCoder. Goes beyond simple tracking by integrating automated YouTube solution video discovery, Google Calendar sync for contest reminders, and a Google Gemini-powered AI tutor that guides students through problem solutions using a Socratic teaching method. Built with Node.js + Express backend, React frontend, MongoDB database, and AWS S3 for file storage.

**Repo**: github.com/abhinavjha0239/contest-tracker-with-AI-tutor

---

## Architecture

### System Overview
```
Frontend (React 18)  <-->  Backend (Express/Node.js)  <-->  External APIs
     |                          |                              |
     |                     MongoDB                    - clist.by (contest data)
     |                     AWS S3                     - YouTube Data API v3
     |                                                - Google Calendar API
     |                                                - Google Gemini API
     |
  Pages: UpcomingContests, PastContests, BookmarkedContests,
         ContestVideos, ContestQuestions, AiTutor, CalendarCallback
```

### Backend Structure (`/backend`)
```
backend/
  server.js                    # Express app, cron-based contest fetching
  config/
    db.js                      # MongoDB connection
    platforms.js               # Platform registry (Codeforces, LeetCode, etc.)
    youtube.js                 # YouTube API config + known playlists
  middleware/
    auth.js                    # JWT authentication middleware
    s3Upload.js                # Multer + S3 file upload middleware
  models/
    Contest.js                 # Contest schema with questions, videos, calendar
    User.js                    # User schema with Google Calendar tokens
    PlatformSubscription.js    # Platform auto-calendar subscription
  routes/
    contests.js                # Upcoming/past contest endpoints + video lookup
    aitutor.routes.js          # AI chat, file upload, question management
    calendar.js                # Google Calendar OAuth + event management
    bookmarks.js               # Contest bookmarking
    auth.js                    # JWT login/register
    admin.js                   # Admin endpoints
  services/
    geminiService.js           # Google Gemini AI integration with session mgmt
    youtubeService.js          # YouTube video search + playlist scanning
```

### Frontend Structure (`/frontend/src`)
```
pages/
  UpcomingContests/            # Filterable upcoming contest list
  PastContests/                # Paginated past contests
  BookmarkedContests/          # User's saved contests
  ContestVideos/               # Video solutions for a contest
  ContestQuestions/             # Questions + AI chat interface
  AiTutor/                     # Past contest selection for AI tutoring
  Login/ & Register/           # JWT authentication
  CalendarCallback/            # Google OAuth callback handler
components/
  QuestionChat/                # Chat UI for AI tutor conversations
  common/
    ContestCard/               # Contest display card
    ContestList/               # Contest list container
    PlatformFilters/           # Platform toggle filters
    PlatformSubscriptions.js   # Calendar subscription UI
    LoadingSpinner/            # Loading indicator
  Navbar/                      # Navigation bar
  BubbleNav.js & FloatingNav.js  # Floating navigation elements
hooks/
  useContests.js               # Shared hook for fetching/bookmarking contests
services/
  api.js                       # Axios API client
utils/
  calendarUtils.js             # Calendar helper functions
  dateUtils.js                 # Date formatting utilities
  platforms.js                 # Platform config (colors, names)
```

---

## Technical Details

### 1. Multi-Platform Contest Aggregation

The app fetches contests from **clist.by API** (a contest aggregation service) on a cron schedule.

**Platform Registry** (`backend/config/platforms.js`):
```javascript
const platforms = {
  codeforces: { id: 1, name: 'Codeforces', resourceId: 1, enabled: true },
  codechef:   { id: 2, name: 'CodeChef',   resourceId: 2, enabled: true },
  leetcode:   { id: 3, name: 'LeetCode',   resourceId: 102, enabled: true },
  atcoder:    { id: 4, name: 'AtCoder',     resourceId: 93, enabled: true }
};
```

**Cron-Based Fetching** (`backend/server.js` -- `fetchContests()`):
- Runs every hour via `node-cron`: `cron.schedule('0 * * * *', fetchContests)`
- Fetches contests from 1 month ago to 2 months ahead
- Uses clist.by resource IDs to filter by platform
- Upserts contests by `(platformId, contestId)` compound unique index
- Preserves existing questions and YouTube links when updating
- Auto-adds new contests to Google Calendar for subscribed users

**Contest Model** (`backend/models/Contest.js`):
```javascript
const ContestSchema = new mongoose.Schema({
  platformId: Number,        // Platform enum ID
  platform: String,          // Platform name
  contestId: String,         // External contest ID
  name: String,              // Contest title
  startTime: Date,
  endTime: Date,
  duration: Number,          // In seconds
  url: String,               // Link to original contest
  questions: [{              // Admin-uploaded questions
    questionId: String,
    title: String,
    filePath: String,        // S3 URL
    s3Key: String,           // S3 key for retrieval
    answerPath: String,      // Solution file S3 URL
    answerS3Key: String      // Solution file S3 key
  }],
  videos: [{                 // YouTube solution videos
    id: String, title: String, channelTitle: String,
    thumbnail: String, score: Number, fromOfficialPlaylist: Boolean
  }],
  calendarEventId: String,   // Google Calendar event ID
  videosLastChecked: Date    // Cache timestamp
});
ContestSchema.index({ platformId: 1, contestId: 1 }, { unique: true });
```

### 2. Google Gemini AI Tutor

The AI tutor uses Google Gemini (1.5 Pro with fallback to Gemini Pro) in a Socratic teaching mode.

**Core Service** (`backend/services/geminiService.js`):

- **Model initialization**: Tries `gemini-1.5-pro` first, falls back to `gemini-pro`
- **Session management**: `Map<sessionId, {chat, lastAccessed}>` with 1-hour TTL and automatic cleanup via `cleanupOldSessions()`
- **System prompt**: Instructs the AI to act as a DSA Teaching Assistant that:
  - Uses reference solutions as source of truth
  - Never reveals complete solutions until student demonstrates effort
  - Guides step-by-step through the reference solution's approach
  - Supports Hinglish mode (Hindi/English) when triggered by keywords like "samjhao", "batao"
- **Key function**: `getAIResponse(title, content, message, history, sessionId)`:
  - Creates or retrieves a persistent Gemini chat session
  - Injects system prompt with question + reference solution context on first message
  - Falls back to single-shot `generateContent()` if chat session fails
  - Returns `{text, sessionId}` for session continuity

**S3 Integration** (`getS3FileContent(s3Key)`):
- Retrieves question files and reference solutions from AWS S3
- Streams S3 object body to buffer, converts to UTF-8 string
- Used by AI tutor to load full question text and answer code

**Chat Routes** (`backend/routes/aitutor.routes.js`):
- `POST /api/ai-tutor/chat` -- Chat about a specific contest question (loads question + answer from S3, passes to Gemini)
- `POST /api/ai-tutor/chat-file` -- Chat about an uploaded file (generic file analysis)
- `POST /api/ai-tutor/upload` -- Upload a file to S3 for AI analysis
- `POST /api/ai-tutor/upload-answer` -- Upload a reference solution for a question
- `POST /api/ai-tutor/add-question/:contestId` -- Add question + answer pair to a contest (dual file upload)

**Frontend Chat UI** (`frontend/src/components/QuestionChat/index.js`):
- Conversational interface with message history
- Session persistence via `sessionId` passed between requests
- Question selection from contest's question list

### 3. AWS S3 File Storage

**Upload Middleware** (`backend/middleware/s3Upload.js`):
```javascript
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.AWS_BUCKET_NAME,
    acl: 'private',
    key: (req, file, cb) => {
      cb(null, `contest_questions/${Date.now()}-${path.basename(file.originalname)}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10MB limit
  fileFilter: // Allows jpeg, png, gif, pdf, txt, doc, docx, md
});
```

- Files stored under `contest_questions/` prefix with timestamp-based naming
- Private ACL -- accessed only through backend's `getS3FileContent()`
- Supports both question files and answer/solution files
- Used by admin to upload contest problems and reference solutions

### 4. Google Calendar Sync

**OAuth2 Flow** (`backend/routes/calendar.js`):
1. `GET /api/calendar/auth/url` -- Generates Google OAuth2 URL with `calendar.events` scope
2. `GET /api/calendar/auth/callback` -- Receives OAuth code, exchanges for tokens, redirects to frontend
3. `POST /api/calendar/auth/exchange` -- Frontend sends state token, backend saves Google tokens to user model

**Calendar Operations**:
- `POST /api/calendar/add/:contestId` -- Creates calendar event with contest name, link, platform, custom reminders (email 60min, popup 30min before)
- `DELETE /api/calendar/remove/:contestId` -- Removes calendar event
- `GET /api/calendar/status/:contestId` -- Checks if contest is already in calendar

**Platform Subscriptions**:
- `POST /api/calendar/subscribe/:platform` -- Subscribe to auto-add all future contests from a platform
- When a new contest is fetched by the cron job, it auto-creates calendar events for all subscribed users
- `PlatformSubscription` model tracks user-platform pairs

### 5. YouTube Video Solution Discovery

**Video Search Service** (`backend/services/youtubeService.js`):
- `searchContestVideos(contestName, platform, contestEndTime)` -- Main search function
- `searchPlaylistForContestVideos(playlistId, contestInfo, contestEndTime)` -- Searches known educator playlists
- Filters videos by:
  - Publication date (must be after contest end time)
  - Contest name/number matching in video title
  - Known platform expert channels (e.g., NeetCode, Errichto)
- **Quality scoring algorithm**: Videos scored by relevance, channel reputation, and playlist membership
  - Official playlist videos get score of 1500 (highest priority)
  - Platform expert videos get bonus scoring
- **Caching**: Videos cached per contest for 24 hours (`videosLastChecked` field), with manual refresh option

**Contest Video Routes** (`backend/routes/contests.js`):
- `GET /api/contests/:contestId/videos` -- Returns scored, cached video list
- `POST /api/contests/:contestId/refresh-videos` -- Force refresh from YouTube
- `POST /api/contests/update-videos` -- Admin batch update for all contests

### 6. Authentication & Frontend

**JWT Auth**: Standard register/login with bcrypt password hashing, JWT tokens stored in localStorage

**Frontend Hook** (`frontend/src/hooks/useContests.js`):
```javascript
export const useContests = (type = 'upcoming') => {
  // Shared state: contests, loading, error, pagination
  // fetchContests({platforms, page, isAuthenticated})
  // toggleBookmark(contestId, isBookmarked)
};
```

- Reusable across UpcomingContests and PastContests pages
- Handles platform filtering, pagination, and bookmark toggling
- Automatic auth header injection when user is logged in

---

## FAQ

**Q: What is the Contest Tracker with AI Tutor?**
A: A full-stack web app that aggregates competitive programming contests from Codeforces, LeetCode, CodeChef, and AtCoder, provides automated YouTube solution video discovery, Google Calendar integration for reminders, and an AI-powered tutor that helps students learn from contest problems using Google Gemini.

**Q: What tech stack does it use?**
A: Node.js + Express backend, React 18 frontend, MongoDB database, AWS S3 for file storage, and integrations with clist.by API, YouTube Data API v3, Google Calendar API, and Google Gemini API.

**Q: How does the AI tutor work?**
A: The AI tutor uses Google Gemini (1.5 Pro) with a Socratic teaching approach. Admins upload contest questions and reference solutions to S3. When a student asks for help, the system loads both the question and solution, injects them into a system prompt that instructs Gemini to guide the student step-by-step without revealing the answer. It maintains conversational context via persistent chat sessions with 1-hour TTL. It also supports Hinglish (Hindi+English) mode.

**Q: How are contests fetched and kept up to date?**
A: A cron job runs every hour, fetching contest data from the clist.by aggregation API. It covers contests from 1 month in the past to 2 months in the future, filtered by platform resource IDs. Contests are upserted by a unique (platformId, contestId) compound index, preserving existing questions and video links.

**Q: How does the YouTube video integration work?**
A: After a contest ends, the system searches YouTube for solution videos using the YouTube Data API v3. It checks known educator playlists first, then does broader searches. Videos are scored by relevance, channel reputation (known experts like NeetCode get priority), and publication timing. Results are cached for 24 hours per contest.

**Q: How does the Google Calendar integration work?**
A: Users authenticate via OAuth2 to grant calendar access. They can manually add individual contests to their Google Calendar (with 30min popup and 60min email reminders) or subscribe to entire platforms for automatic event creation whenever new contests are fetched.

**Q: What role does AWS S3 play?**
A: S3 stores contest question files and reference solution files. The upload middleware (multer-s3) handles file uploads with 10MB limits, private ACL, and timestamped naming. The Gemini service retrieves file content from S3 to provide context for AI tutoring sessions.

**Q: What platforms are supported?**
A: Codeforces (Div 1, 2, 3, Educational, Global rounds), LeetCode (Weekly, Biweekly contests), CodeChef (Starters, Cook-off, Lunchtime, Long), and AtCoder (ABC, ARC, AGC).

---

## What Makes This Impressive

1. **Multi-API Orchestration**: Integrates 5 external APIs (clist.by, YouTube, Google Calendar, Google Gemini, AWS S3) into a cohesive product -- each with different auth patterns (API keys, OAuth2, AWS credentials)

2. **Intelligent AI Tutoring Design**: The Gemini integration goes beyond simple Q&A -- it uses a carefully crafted system prompt for Socratic teaching, maintains persistent chat sessions with TTL-based cleanup, loads both question and reference solution context, supports language switching (Hinglish), and has graceful fallback from chat mode to single-shot generation

3. **Production-Minded Architecture**: Cron-based data freshness, 24-hour video caching with manual refresh, upsert-based contest updates that preserve linked data, compound unique indexes, session garbage collection, and comprehensive error handling with user-friendly messages

4. **Real-World Problem Solving**: Addresses an actual pain point for competitive programmers -- finding solution videos, remembering contest times, and learning from problems after contests end. The platform subscription + auto-calendar feature is a practical quality-of-life improvement

5. **Full-Stack Depth**: Custom React hooks for state management (`useContests`), S3 streaming for file retrieval, OAuth2 token exchange flow, JWT auth, multer middleware chaining, and Mongoose schema design with validation and indexing
