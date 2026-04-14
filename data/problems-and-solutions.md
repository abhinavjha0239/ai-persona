# Problems I Faced and How I Solved Them

## The Pattern
Every project I've built started with a real problem I personally experienced. I don't build to pad a portfolio — I build because something was broken and I wanted to fix it.

## test-platform — "Our college had DSA and DevOps courses but no full-stack assessment"
**The problem:** Scaler School of Technology had coding assessments for DSA and DevOps, but no way to evaluate full-stack project submissions — where candidates submit entire apps, not just functions. There was no platform that could grade a full Express + React app, run Playwright tests against it, or evaluate SQL queries with proper isolation.
**What I did:** I built a production-grade exam platform from scratch that supports 4 grading modes (HTTP blackbox, Playwright E2E, jsdom UI, SQL), with Two-Container Isolation so hidden tests never leak to candidates. It's now pilot testing at Scaler SST with real students.
**Live:** http://sst.smilein.live/

## Attendance System — "Attendance was manual, so I automated it"
**The problem:** At Scaler School of Technology, attendance was tracked manually — inefficient, error-prone, and wasted class time. There was no automated system that could handle group photos of classrooms and identify students reliably.
**What I did:** I built a face recognition microservice with AdaFace embeddings, FAISS vector search, and batch-section scoping to reduce false positives. Teachers upload a group photo, the system identifies everyone in sub-second time. It's now used at Scaler School of Technology.
**Live:** https://attend.sst.smilein.live/

## OS Tracker — "I mentored GSoC students and needed college-wide analytics"
**The problem:** I was mentoring 5+ students for GSoC contributions, and there was no way to track who contributed where, how many PRs were merged, or compare students across organizations. I needed a dashboard that syncs with GitHub and gives me real-time analytics across all students.
**What I did:** I built a Next.js tracker with raw PostgreSQL, GitHub API sync via Octokit, leaderboards ranked by merged PRs, mentor management, and automated daily sync via Vercel Cron. Now I can see college-wide contribution analytics anytime.
**Live:** https://gsoc-tracker.vercel.app/

## Contest Tracker — "Kept missing contests, couldn't find solutions in one place"
**The problem:** As a competitive programmer, I kept missing contests across Codeforces, LeetCode, CodeChef, and AtCoder because there was no single aggregated view. After contests, finding good solution explanations was fragmented across YouTube and blogs.
**What I did:** I built an all-in-one contest tracker that aggregates contests across all major platforms, with Google Calendar sync for reminders, YouTube solution discovery with quality scoring, and a Google Gemini AI tutor that can explain any problem step-by-step in Hinglish.

## Dog Tracker — "Saw lost dog posters everywhere, thought QR codes could fix it"
**The problem:** Lost dog posters on lampposts are inefficient — they fade, have limited info, and there's no feedback loop when someone finds the dog. The owner has no way to know if anyone is even looking.
**What I did:** I built a QR code-based recovery system. Owners register dogs, generate QR tags for collars, and activate "lost mode" with reward info. When someone finds the dog, they scan the QR code, see the profile, and submit a found report — no app download needed.

## DeepSkill — "Vivas are subjective, no way to track daily student progress"
**The problem:** Traditional viva examinations are inconsistent — different examiners ask different questions, scoring is subjective, and there's no way to track a student's conceptual understanding over time. Professors wanted to understand each student's progress subjectively, every day, across multiple domains.
**What I did:** I built an AI-powered interview platform where students interact with an AI interviewer over WebSocket. It supports 7+ domains (System Design, OS, DBMS, Networks, Civil, Mechanical, Medical), uses rubric-based LLM evaluation for consistency, a chaos engine for dynamic difficulty, and tracks progress per student over time. Currently under trial — not publicly available.

## What This Shows About Me
I don't look at a problem and think "what technology should I learn?" I look at the problem, understand the constraints, and design the solution around it. That's why:
- test-platform uses Go (needed goroutine concurrency for parallel grading)
- Attendance uses Python (ML ecosystem) + FastAPI (async performance)
- OS Tracker uses raw SQL (needed query control for analytics)
- Contest Tracker uses Gemini (needed conversational AI tutoring)
- Dog Tracker uses Prisma (needed rapid CRUD iteration)
- DeepSkill uses Go + WebSocket (needed real-time low-latency sessions)

Every tool was chosen because the problem demanded it, not because I wanted to learn it.
