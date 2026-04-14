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
- **Pipeline:** Query → Azure OpenAI embedding (1536d) → pgvector hybrid search (BM25 + vector, RRF k=60) → Top-5 chunks → XML-tagged context → GPT-4.1 streaming
- **Knowledge base:** 70 chunks from 11 markdown files sourced from actual PDF resume and GitHub code analysis
- **TTFB:** 0.5–2.0s across 17 test queries (avg 1.3s)

### Hallucination Rate
Tested via 17 automated queries across 2 orchestrator agents:

| Category | Tests | Pass | Fail | Accuracy |
|----------|-------|------|------|----------|
| Resume facts (education, jobs, dates) | 7 | 6 | 1* | 86% → 100% post-fix |
| GitHub repo knowledge | 4 | 4 | 0 | 100% |
| Adversarial traps (fake companies, wrong tech) | 4 | 4 | 0 | 100% |
| Edge cases (jailbreak, negative framing) | 3 | 3 | 0 | 100% |

*Education hallucination found and fixed during eval (see Failure Mode #1).

---

## 3. Three Failure Modes Found and Fixed

### Failure 1: Education Hallucination (Critical → Fixed)
**Found:** When asked "Where did you study?", GPT-4.1 fabricated "BITS Pilani Hyderabad, B.E. Electrical Engineering" — overriding the retrieved context which correctly states "BITS Pilani, B.S. Computer Science" and "Scaler School of Technology, BS+MS track."
**Root cause:** Model's parametric knowledge about BITS Pilani overrode RAG context. Anti-hallucination rules were too generic.
**Fix:** Added explicit grounding instruction: *"For education, dates, company names — use ONLY the EXACT text from retrieved context. Your general knowledge about universities is OFTEN WRONG for this specific person."*
**Verified:** Post-fix correctly returns both institutions with exact degree names and years.

### Failure 2: Defensive Limitation Framing (Medium → Fixed)
**Found:** "Is the grader auto-scalable?" → "Auto-scaling is NOT implemented. Known gap." — technically honest but reads as a weakness in a screening context.
**Root cause:** System prompt optimized for honesty, not persuasiveness.
**Fix:** Rewrote prompt to frame positively: *"Lead with what's impressive. Frame gaps as conscious engineering decisions."* Post-fix answer leads with horizontal scalability, mentions sub-3s grading at 200 concurrent, frames manual scaling as appropriate for current scale.

### Failure 3: Off-Topic Conversation Drift (Low → Fixed)
**Found:** "Best pizza in Bangalore?" → 200-word restaurant guide with specific names. Should redirect to professional topics.
**Root cause:** No guardrail for unrelated questions — persona acted as general assistant.
**Fix:** Added rule: *"Keep off-topic answers to ONE sentence max, then IMMEDIATELY redirect to engineering topics."*

---

## 4. What I'd Improve with 2 More Weeks

1. **Automated eval regression suite:** Build a test harness with 50+ question-answer pairs (ground truth from resume PDF), run on every prompt/KB change, track accuracy and hallucination rate over time. Include adversarial questions as regression tests.

2. **Voice A/B testing:** Deploy multiple Vapi configs (different endpointing, TTS, responsiveness values) and measure user satisfaction via call duration, task completion rate, and interruption recovery — optimizing data-driven rather than by intuition.

> **Note:** Two improvements originally planned for "2 more weeks" were implemented during this eval cycle:
> - **Source-code-level knowledge base:** Deployed automated code analysis agents that read actual `.go`, `.py`, `.ts` files from GitHub repos and extracted function names, struct definitions, and implementation patterns into the knowledge base.
> - **Conversation-aware retrieval:** Implemented history-aware query rewriting — the search query now includes the last 2 turns of conversation context, so follow-ups like "tell me more about that" correctly disambiguate based on what was previously discussed.
