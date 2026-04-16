# AI Persona — Evaluation Report
**Abhinav Kumar Jha | April 2026**
**Live:** abhinav.smilein.live | **Repo:** github.com/abhinavjha0239/ai-persona

---

## 1. Voice Quality (Part A)

Measured across **6 test calls** — 3 booking flows, 2 Q&A conversations, 1 bilingual (Hinglish).

| Metric | Result | How I measured |
|--------|--------|----------------|
| First-token latency | **~1.5s** | Vapi dashboard. Deepgram Nova-3 STT (300ms endpointing) → Azure OpenAI GPT-5.4-mini (tool calling + reasoning) → Cartesia TTS (progressive chunking — speech starts before full response). |
| Interruption handling | **Pass** | Manual barge-in mid-response. Agent stops, acknowledges ("Go ahead"), and resumes cleanly. Vapi silence timeout 30s. |
| Booking task completion | **Pass** | Full end-to-end: intent detection → real Cal.com slot check → name/email collection → booking confirmed with meeting link. |
| Data capture (first attempt) | Name: **~85%** / Time: **~90%** / Email: **~30%** | Per-field accuracy across 6 calls. Email is the bottleneck — see Failure Mode 3. |

---

## 2. Chat Groundedness (Part B)

**Pipeline:** Query augmentation (topic-specific keyword boosting) → text-embedding-3-small (1536d) → pgvector hybrid search (BM25 + vector, RRF k=60) → Top-5 XML-tagged chunks → GPT-5.4-mini streaming.

**Knowledge base:** ~188 chunks from 16 markdown files — actual resume, 8 GitHub repos analyzed at source-code level (function signatures, struct definitions, architecture), project writeups, and role-fit narrative.

### Hallucination Rate — 43 queries, 2 sessions, 9 failure modes found

| Category | Tests | Result |
|----------|-------|--------|
| Resume facts (education, jobs, dates, numbers) | 12 | **100%** post-fix — 1 critical failure found and fixed (F1) |
| GitHub repo technical depth (4 repos) | 8 | **100%** — correct function names, Docker flags, Redis commands |
| Adversarial traps (fake companies, fake skills, fake education) | 8 | **100%** post-fix — correctly denies Google/Amazon/K8s experience |
| Edge cases (code requests, salary, identity, off-topic) | 9 | **100%** post-fix — redirects without acting as general assistant |
| Conversation quality (multi-turn, closings, comparisons) | 6 | **100%** post-fix — no weak "if you want" patterns |

### Retrieval Quality
Validated with **Playwright browser automation** (15 UI-level tests). Key finding: education retrieval failed after 5+ unrelated turns — conversation context diluted the education signal. Root cause was 3 compounding bugs in query augmentation (see F1). Fixed and regression-tested.

### Booking (E2E)
Real Cal.com v2 API. Confirmed booking: *"Thursday, 16 April at 11:00 AM"* — meeting link `cal.com/video/dbWRdinwBQTN4AikQmbjWS` returned to user. Conflict detection, time rescheduling, and deduplication all tested.

---

## 3. Three Failure Modes

### F1: Education Hallucination — Critical, Fixed
**Symptom:** "Where did you study?" → GPT fabricated *"BITS Pilani Hyderabad, B.E. Electrical Engineering"* despite retrieved context correctly stating "BITS Pilani, B.S. Computer Science."

**Root cause (3 compounding bugs):**
1. **Prompt-level:** Anti-hallucination rules were too generic — model's parametric knowledge overrode RAG context for well-known universities.
2. **Retrieval-level:** Query augmentation regexes used `\beducat\b` — the trailing word boundary doesn't match mid-word, so "education" never triggered the keyword boost. Same bug for "study", "student", "graduate".
3. **Pipeline-level:** Even when the boost matched (e.g., "college"), the conversation-context injection block overwrote `searchQuery` with `lastUserText`, discarding the boost entirely.

**Fix:** (1) Added strict grounding rule: *"For education, dates, company names — use ONLY the EXACT text from retrieved context."* (2) Changed regexes to full words (`education|study|student|degree|college`). (3) Skip conversation context when a topic boost already matched. Verified across 5 education queries — exact institution names and years every time.

### F2: Skills Hallucination by Implication — Medium, Fixed
**Symptom:** "Tell me about your Kubernetes experience" → *"My experience maps naturally to Kubernetes"* — implying expertise with a technology not in the resume (Docker and gVisor are listed, not Kubernetes).

**Root cause:** Anti-hallucination rules covered factual claims (dates, names) but not skills. The model found a framing loophole — "related experience" language that implies competence without technically lying.

**Fix:** Explicit skills honesty rule: *"If asked about a technology NOT in your context, you MUST say 'I haven't worked with [X] directly, but...' THEN pivot."* Post-fix: response opens with "I haven't worked with Kubernetes directly" before connecting to container experience.

### F3: Voice Email Collection — High, Partially Mitigated
**Symptom:** 0/6 emails captured correctly on first attempt. "abhinavjha0239@gmail.com" transcribed as *"abhinov ja zero two three nine at g mail dot com"*.

**Root cause:** STT models are trained on natural speech, not alphanumeric strings. Email addresses combine proper nouns + numbers + symbols — each individually challenging for acoustic models. Indian-accented English adds a further recognition layer.

**Partial fix:** NATO phonetic confirmation flow in voice prompt + Deepgram keyword boosting for common domains (`@gmail.com:3`, `@scaler.com:3`). Improved repeat-attempt accuracy but first-attempt capture remains the primary bottleneck for voice booking.

---

## 4. What I'd Improve with 2 More Weeks

**1. Voice data collection — accurate capture and user verification.** This is the hardest unsolved problem. If you can reliably collect structured data (name, email, time) over voice and verify it with the user, every other voice feature becomes straightforward — booking, follow-ups, CRM integration all depend on getting this right. I'd research STT-level solutions (custom vocabulary, spelling mode, phonetic decoding) and experiment with different confirmation strategies (read-back, character-by-character, SMS fallback as escape hatch). I haven't cracked this in the assignment timeframe, but I believe it's solvable — it's the kind of problem I'd want to dig into given more time.

**2. Automated eval regression suite.** CI-integrated harness with 50+ QA pairs (ground truth from resume PDF), RAGAS metrics (faithfulness, relevance, recall), auto-run on every prompt or KB change. Current evals are manual — this would catch regressions before deployment.

**3. Real-time voice RAG.** Voice currently uses a single prompt-injected knowledge blob. Deep technical questions hit context limits. Would add per-turn retrieval: caller asks about a project → server-side chunk fetch → inject into next LLM call via custom Vapi server URL endpoint.

**4. In-chat slot picker.** Replace text-based slot negotiation (3-4 back-and-forth turns) with interactive clickable time chips rendered inline when `check_availability` returns. User clicks a slot instead of typing. Design spec written, ready to implement.
