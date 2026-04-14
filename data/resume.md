# Abhinav Kumar Jha — Resume

## Contact
- Location: Bangalore, India
- Phone: +91-9934732847
- Email: abhinavjha0239@gmail.com
- GitHub: github.com/abhinavjha0239

## Summary
Backend / systems engineer building secure, high-concurrency platforms in Go, Node.js/TypeScript, and Python. Experience with distributed job processing, container sandboxing, real-time WebSockets, and cloud-native deployments. Winner — Scaler AI Labs Hackathon (Rs.1.5L prize); open-source mentor with 5+ students contributing to GSoC orgs.

## Education

### Scaler School of Technology — Bangalore, India
Computer Science (BS + MS track), Expected 2027

### BITS Pilani — Pilani, India
B.S. Computer Science, Expected 2026

## Experience

### Backend Engineer (Independent) — Bangalore / Remote
**Secure Coding Assessment Platform (Pilot testing @ Scaler School of Technology)**
**Jan 2026 – Present**

- Currently running pilot deployments with Scaler School of Technology (SST) to validate grading reliability, proctoring flow, and end-to-end candidate experience.
- Built a production-grade coding assessment platform for full-project submissions (any language / any tech stack) with real-time proctoring and deterministic scoring.
- Designed a Two-Container Isolation model (candidate container + tester container) over a private Docker bridge to prevent hidden-test leakage; hardened runtime via gVisor, read-only FS, no-internet, and strict CPU/memory/PID limits.
- Implemented a Go-based distributed grading engine orchestrated via Redis Streams consumer groups (at-least-once delivery, retries/backoff, idempotent result writes).
- Reduced cold-start latency using proactive container warming/pooling and network bridge pooling; achieved sub-3s median grading in load tests at 200 concurrent candidates.
- Optimized unit economics to ~$1-3 per candidate (spot compute + bin-packing) while keeping state in managed PostgreSQL/Redis; architecture designed to scale to 10k+ concurrent candidates by adding grader VMs.
- System Resilience & Concurrency Control: Redis-backed rate limiting (per-IP/per-user) for login, run, and submission endpoints + distributed locks to prevent duplicate grading/timer auto-submissions across horizontally scaled APIs.

### Backend Intern — Kugelblitz (Remote)
**Feb 2025 – Jan 2026**

- Built and maintained Golang services for Payments, KYC verification, and OTP/Auth flows; implemented timeouts, retries, and idempotency for reliability.
- Wrote Python + SQL migration tooling and automated validation to ensure consistency across legacy and new databases; helped add monitoring for ETL jobs and service health checks.

### Software Engineer Intern — Scaler Innovation Lab (Remote)
**Dec 2024 – Dec 2025**

- Shipped a College ERP dashboard (React) and integrated REST APIs; implemented backend services in Express with MongoDB; containerized with Docker and deployed to Google Cloud Run.
- Built an Automated Attendance Platform powered by face recognition: a production-ready FastAPI microservice for enrollment (face embeddings) and group-photo recognition (identified IDs + bounding boxes).
- Implemented AdaFace (IR-50) embeddings with multi-face detection, accelerated matching using FAISS indexing + caching, and shipped auth token, structured logging, and OpenAPI docs.

## Projects

### 1. Secure Coding Assessment Platform (test-platform)
**Stack:** Go, TypeScript, React, PostgreSQL, Redis Streams, Docker, gVisor
**Live:** http://sst.smilein.live/
**What:** Production-grade exam platform for full-project code submissions with real-time proctoring and deterministic scoring. Currently pilot testing at Scaler School of Technology. Built because SST had DSA and DevOps assessments but no full-stack project evaluation.
**Key Engineering:**
- Two-Container Isolation: candidate container + tester container over private Docker bridge prevents hidden-test leakage
- Go distributed grading engine via Redis Streams consumer groups with at-least-once delivery, retries, backoff, and idempotent writes
- Container warming/pooling for sub-3s median grading at 200 concurrent candidates
- Unit economics: ~$1-3 per candidate using spot compute + bin-packing
- Architecture designed to scale to 10k+ concurrent candidates by adding grader VMs
- 8-layer security: gVisor sandboxing, read-only FS, no-internet, CPU/memory/PID limits, anti-tab-switch, paste blocking
- Redis-backed rate limiting + distributed locks across horizontally scaled APIs

### 2. DeepSkill — AI-Powered Interview Platform
**Stack:** Go, Gin, gorilla/websocket, Groq LLM, React, ReactFlow
**Status:** Under trial, not publicly available
**What:** Built to solve subjective viva evaluation — professors wanted to track each student's conceptual understanding daily across multiple domains. AI interviewer via WebSocket with rubric-based evaluation for consistency, chaos engine for dynamic difficulty. Supports 7+ domains.
**Key Engineering:** Agent Graph Builder for non-linear interview flows, rubric-based LLM evaluation, chaos engine for dynamic difficulty.

### 3. Automated Attendance Platform (Face Recognition)
**Stack:** Python, FastAPI, AdaFace (IR-50), FAISS, Docker
**Live:** https://attend.sst.smilein.live/
**What:** Attendance was manual at Scaler School of Technology — inefficient and wasted class time. Built a face recognition microservice where teachers upload a group photo and the system identifies everyone. Now used at SST.
**Key Engineering:** AdaFace embeddings with multi-face detection, FAISS indexing + caching for accelerated matching, auth tokens, structured logging, OpenAPI docs.

### 4. Contest Tracker with AI Tutor
**Stack:** Node.js, React, MongoDB, AWS S3, Google Gemini
**What:** Aggregates contests across Codeforces, LeetCode, CodeChef, AtCoder with bookmarking, filters, and OAuth2-based Google Calendar sync + reminders.
**Key Engineering:** YouTube solution discovery with caching, AI tutoring flow using Google Gemini, user code storage on AWS S3, JWT route guards + rate limiting.

### 5. OS Tracker — Open Source Contribution Tracker
**Stack:** Next.js, TypeScript, PostgreSQL (raw SQL), GitHub API (Octokit)
**Live:** https://gsoc-tracker.vercel.app/
**What:** Built because I was mentoring 5+ GSoC students and needed college-wide analytics on who contributed where. Tracks merged PRs across GitHub organizations with leaderboards, mentor management, and automated daily sync.

### 6. Dog Tracker — Lost Dog QR Code System
**Stack:** Next.js, TypeScript, Prisma, PostgreSQL, Cloudinary, JWT auth
**What:** Saw lost dog posters everywhere and thought QR codes could fix the feedback loop. Owners register dogs, generate QR tags for collars, activate "lost mode" with reward info. Finders scan QR code and submit found reports — no app needed.

### 7. AI Persona (This Project)
**Stack:** Next.js, TypeScript, Vapi, Azure OpenAI (GPT-5.4-mini), pgvector, Deepgram, ElevenLabs
**What:** AI persona with voice calls and RAG-grounded chat. Swappable provider architecture. Hybrid search (BM25 + vector, RRF fusion). Hindi + English bilingual voice.

## Achievements & Leadership

- **Winner, Scaler AI Labs Hackathon (1st Prize Rs.1.5L):** Built web-based RL task environments (MS Teams-like UI + task graders) and generated 2,000+ validated tasks for model training/evaluation.
- **Open Source Mentorship:** Mentored 5+ students contributing to GSoC orgs; one recognized as Star Contributor and one became an Org Maintainer.

## Skills
- **Languages:** Go, Python, JavaScript/TypeScript, SQL
- **Backend:** Node.js, Express, FastAPI, Flask
- **Databases/Cache:** PostgreSQL, MongoDB, Redis
- **Infra:** Docker, gVisor, Google Cloud Run, AWS (S3)
- **Systems:** Redis Streams queues, distributed locks, WebSockets (Socket.IO)
- **ML/AI:** AdaFace, FAISS, Gemini API

## Languages
- English (professional)
- Hindi (native)
- Hinglish (code-switching, natural in conversation)

## Availability
Based in Bangalore. Open to roles. Available for calls — book directly through the chat interface.
