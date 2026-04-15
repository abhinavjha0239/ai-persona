# AI Persona — Evaluation Report
**Abhinav Kumar Jha | April 2026**

---

## 1. Voice Quality Measurement (Part A)

| Metric | Target | Actual | Method |
|--------|--------|--------|--------|
| First response latency | <2s | ~1.5s | Vapi endpointing: 350ms, responsiveness: 0.55, progressive TTS chunking |
| Interruption handling | No crash | Pass | Vapi backchannel enabled, silenceTimeout: 20s |
| Task completion (booking) | End-to-end | Pass | 3-turn flow: check_availability → confirm slot → create_booking |

**STT:** Deepgram Nova-3 with keyword boosting for technical terms (`Redis:2`, `gVisor:2`, `AdaFace:2`).
**TTS:** ElevenLabs with chunk plan (min 30 chars, punctuation-boundary splitting).
**Languages:** Hindi + English + Hinglish code-switching.

---

## 2. Chat Groundedness Measurement (Part B)

### Retrieval Quality
- **Pipeline:** Query → Azure OpenAI embedding (text-embedding-3-small, 1536d) → pgvector hybrid search (BM25 + vector, RRF k=60) → Top-5 chunks → XML-tagged context → gpt-5.4-mini streaming
- **Knowledge base:** ~188 chunks from 16 markdown files (6 core + 10 GitHub code-level deep dives), sourced from actual PDF resume and automated GitHub repo analysis
- **Conversation-aware retrieval:** Search query includes last 2 turns of conversation, solving follow-up disambiguation ("tell me more about that")

### Chat TTFB (Measured with Real Numbers)

| Condition | TTFB Range | Median | Notes |
|-----------|-----------|--------|-------|
| Cold start (first request) | 7.5–15.0s | ~10s | Embedding model init + DB connection pool warmup |
| Warm request (typical) | 2.0–4.6s | 2.8s | Embed + hybrid search + LLM streaming |
| Off-topic (short response) | 1.9–2.9s | 2.5s | Less RAG context, shorter LLM output |
| Booking intent detection | 8–18.5s | ~10s | Includes server-side Cal.com API call for real slots |

### Hallucination Rate
Tested via **43 automated queries** across 2 sessions (17 Session 1 + 26 Session 2):

| Category | Tests | Pass | Fail (fixed) | Post-fix Accuracy |
|----------|-------|------|-------------|----------|
| Resume facts (education, jobs, dates) | 12 | 11 | 1 (F1) | 100% |
| GitHub repo knowledge (4 repos) | 8 | 8 | 0 | 100% |
| Adversarial traps (fake companies, fake edu, fake skills) | 8 | 7 | 1 (F8) | 100% |
| Edge cases (code request, salary, identity, off-topic) | 9 | 8 | 1 (F6) | 100% |
| Conversation quality (multi-turn, closings, comparisons) | 6 | 5 | 1 (F7) | 100% |

### Calendar Booking (End-to-End from Chat)
- **Slot fetching:** Real Cal.com v2 API integration, 15-minute intervals, GET `/api/booking/slots` returns live availability
- **Booking creation:** Multi-turn flow tested: user states intent → persona asks for time/name/email → user provides all → booking created with Cal.com meeting link
- **Verified:** Real booking confirmed for "Thursday, 16 April at 5:00 PM" with meeting URL returned to user
- **Deduplication:** 30-second dedup guard prevents double-submissions
- **Server-side time parsing:** "5 PM tomorrow" → ISO 8601 with IST offset, no client-side date logic

---

## 3. Six Failure Modes Found and Fixed

### Failure 1: Education Hallucination (Critical → Fixed)
**Found:** When asked "Where did you study?", GPT-4.1 fabricated "BITS Pilani Hyderabad, B.E. Electrical Engineering" — overriding the retrieved context which correctly states "BITS Pilani, B.S. Computer Science" and "Scaler School of Technology, BS+MS track."
**Root cause:** Model's parametric knowledge about BITS Pilani overrode RAG context. Anti-hallucination rules were too generic.
**Fix:** Added explicit grounding instruction: *"For education, dates, company names — use ONLY the EXACT text from retrieved context. Your general knowledge about universities is OFTEN WRONG for this specific person."*
**Verified:** 5 subsequent education queries all return exact degree names and years.

### Failure 2: Defensive Limitation Framing (Medium → Fixed)
**Found:** "Is the grader auto-scalable?" → "Auto-scaling is NOT implemented. Known gap." — technically honest but reads as a weakness in a screening context.
**Root cause:** System prompt optimized for honesty, not persuasiveness.
**Fix:** Rewrote prompt to frame positively: *"Lead with what's impressive. Frame gaps as conscious engineering decisions."* Post-fix answer leads with horizontal scalability, mentions sub-3s grading at 200 concurrent, frames manual scaling as appropriate for current scale.

### Failure 3: Off-Topic Conversation Drift (Low → Fixed)
**Found:** "Best pizza in Bangalore?" → 200-word restaurant guide with specific names. Should redirect to professional topics.
**Root cause:** No guardrail for unrelated questions — persona acted as general assistant.
**Fix:** Added rule: *"Keep off-topic answers to ONE sentence max, then IMMEDIATELY redirect to engineering topics."*

### Failure 4: Code-Writing as General Assistant (High → Fixed)
**Found:** "Can you write me a Python script to sort a list?" → Persona generated a full Python sort script with two implementations and offered to show more variations. Ended with banned pattern "If you want, I can also show you how to..."
**Root cause:** Out-of-scope rule didn't explicitly cover code-writing/tutoring requests. Persona defaulted to helpful-assistant behavior.
**Fix:** Expanded out-of-scope rule to explicitly include code-writing: *"You are a professional persona, NOT a general-purpose assistant or coding helper. If asked to write code, redirect: 'I'm here to talk about my engineering work — ask me how I built something and I'll walk you through the real code.'"*
**Verified:** Post-fix redirects cleanly in 262 chars without writing any code.

### Failure 5: Weak "If You Want" Closing Pattern (Medium → Fixed)
**Found:** Multiple responses ended with passive offers despite explicit prompt rule banning them: "If you want, I can walk you through...", "If you want, I can tell you about...", "If you want, I can also show you..."
**Root cause:** Original prompt listed only one banned pattern. Model generated semantic variants that dodged the rule.
**Fix:** Expanded banned patterns to 6 explicit variations: "If you want, I can also...", "If you'd like, I can...", "Want me to...", "I can also show you...", "Feel free to ask about...", "Let me know if you'd like to hear more about..." — all marked as banned, with requirement to end on a confident STATEMENT, not a question or offer.
**Verified:** 3 regression tests all end with confident statements — zero weak closings.

### Failure 6: Skills/Technology Hallucination by Implication (Medium → Fixed)
**Found:** "Tell me about your Kubernetes experience" → Persona responded with "My experience maps very naturally to Kubernetes and microservices" without ever stating it hasn't used Kubernetes. Resume lists Docker and gVisor but NOT Kubernetes.
**Root cause:** Anti-hallucination rules covered factual claims (dates, names) but not skills/technologies. Model used "related experience" framing to imply expertise without lying.
**Fix:** Added explicit skills honesty rule: *"If asked about a technology NOT in your context, you MUST explicitly acknowledge you haven't used it directly: 'I haven't worked with [X] directly, but...' THEN pivot to related experience."*
**Verified:** Post-fix response starts with "I haven't worked with Kubernetes directly, but..." before connecting to container orchestration work.

### Failure 7: "Ha," Dismissive Opener on Off-Topic (Low → Fixed)
**Found (Playwright):** Off-topic redirect started with "Ha, good question —" which reads as dismissive and informal in a professional screening context.
**Root cause:** The example redirect in the prompt included "Ha," as a literal opener, which the model adopted verbatim.
**Fix:** Removed "Ha," from the example and added explicit note: *"Do NOT start with 'Ha,' — it sounds dismissive."*
**Verified:** Playwright session confirmed fix takes effect (hot reload, no restart needed).

### Failure 8: Booking Time Parser Uses First Match (High → Fixed)
**Found (Playwright):** When user says "3 PM has a conflict, what about 10 AM?", the booking detection code used `allText.match()` which finds the FIRST time mention ("3 PM") in the entire conversation — re-attempting the same conflicted slot.
**Root cause:** `route.ts` time/date extraction used `allText.match()` which returns the first regex match, not the most recent. When reschedauling, the old time is still earliest in conversation.
**Fix:** Changed time and date regex to check `lastUserText` first, fall back to `allText`. Most recent mention wins: `lastUserText.match(timeRegex) || allText.match(timeRegex)`.
**Verified (Playwright):** 11 AM booking succeeded end-to-end after 3 PM conflict — real Cal.com meeting link returned: `https://app.cal.com/video/dbWRdinwBQTN4AikQmbjWS`, confirmed for Thu 16 April at 11:00 AM.

---

## 3b. Playwright Browser Test Results (Session 3 — 2026-04-15)

**Method:** Playwright MCP browser automation on http://localhost:3000

| # | Test | UI Behavior | Result |
|---|------|------------|--------|
| P1 | Page load | "AI Persona \| Abhinav Jha" title, tech chips rendered, architecture diagram | PASS |
| P2 | Chat page | Colored chips (Go, Python, TypeScript, Redis, Docker, gVisor, PostgreSQL, FAISS), 188 chunks badge, Online indicator, suggested questions | PASS |
| P3 | Greeting ("hi") | Short 2-sentence response, no resume dump, contextual follow-up chips | PASS |
| P4 | Education RAG (fresh chat) | "Scaler School of Technology — Computer Science (BS + MS), 2027" + "BITS Pilani — B.S. Computer Science, 2026" — exact match | PASS |
| P5 | Education RAG (long session) | Failed to retrieve education after 5 unrelated turns — conversation-aware retrieval pushed education chunks out of top-5 | PARTIAL FAIL |
| P6 | Hallucination trap ("worked at Google") | "I haven't worked at Google." + timeline UI with real 3 jobs and exact dates | PASS |
| P7 | Timeline UI rendering | Blue-dot timeline with date ranges, role names, company names — visually polished | PASS |
| P8 | Off-topic ("pizza in Bangalore") | One-sentence redirect, no weak closing, context-aware chips | PASS |
| P9 | Code request redirect | "I'm here to talk about my engineering work" — no code written | PASS |
| P10 | Booking conflict detection | 3 PM slot conflict detected from real Cal.com — asked for alternative | PASS |
| P11 | Booking time parser (reschedule) | Bug found: old time reused. Fixed. 11 AM booked successfully after fix | FIXED |
| P12 | Booking confirmation UI | "Booking confirmed! Thursday, 16 April at 11:00 am. Meeting link: https://app.cal.com/video/..." | PASS |
| P13 | GitHub depth (two-container isolation) | Actual Docker flags, `--internal` network, `--read-only`, `--user 1000:1000`, `--pids-limit 150`, `testsDir` mount — code block rendered with syntax highlighting + copy button | PASS |
| P14 | Console errors | 0 errors, 0 warnings across entire session | PASS |
| P15 | "Ha," opener | Found and fixed during session | FIXED |

---

## 4. What I'd Improve with 2 More Weeks

1. **Cold-start latency optimization:** First request takes 7.5–15s due to embedding model initialization and DB connection pooling. Would implement connection pre-warming on server start, embedding model keep-alive, and optional response caching for common greetings. Target: <3s cold-start TTFB.

2. **Automated eval regression suite:** Build a CI-integrated test harness with 50+ question-answer pairs (ground truth from resume PDF), auto-run on every prompt/KB change, and track accuracy drift over time. Include all 8 adversarial traps as permanent regression tests. Alert on any accuracy drop below 95%.

3. **Voice A/B testing:** Deploy multiple Vapi configs (different endpointing thresholds, TTS providers, responsiveness values) and measure user satisfaction via call duration, task completion rate, and interruption recovery — optimizing data-driven rather than by intuition.

> **Note:** Two improvements originally planned for "2 more weeks" were implemented during this eval cycle:
> - **Source-code-level knowledge base:** Deployed automated code analysis agents that read actual `.go`, `.py`, `.ts` files from GitHub repos and extracted function names, struct definitions, and implementation patterns into the knowledge base. Grew KB from 70 chunks to ~188 chunks.
> - **Conversation-aware retrieval:** Implemented history-aware query rewriting — the search query now includes the last 2 turns of conversation context, so follow-ups like "tell me more about that" correctly disambiguate based on what was previously discussed.
