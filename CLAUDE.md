# AI Persona — Project Context

## What This Is
A Scaler screening assignment: an AI persona of Abhinav Kumar Jha with voice (Part A), chat (Part B), and eval report (Part C). The persona must be RAG-grounded over real resume + GitHub repos. No hardcoded answers.

## Architecture
- **Framework:** Next.js 16 (TypeScript), deployed on Vercel
- **Chat LLM:** Azure OpenAI `gpt-5.4-mini` (GlobalStandard, capacity 50) — also have `gpt-4.1` (Standard, capacity 50). Switch via `AZURE_OPENAI_CHAT_DEPLOYMENT` in `.env.local`
- **Voice:** Vapi + Cartesia "Indian Customer Service" voice + Deepgram Nova-3 STT (endpointing 250ms) + gpt-4o-mini for voice LLM
- **Booking:** Cal.com v2 API — slots pre-fetched server-side and injected into system prompt (no tool calls — works with all models)
- **Embeddings:** Azure OpenAI `text-embedding-3-small` (1536d, capacity 50)
- **Vector Store:** Azure PostgreSQL + pgvector (server: `ai-persona-pgvector` in `rg-abhinavjha07-6994`)
- **Search:** Hybrid BM25 + vector with RRF fusion (k=60), top-5 results
- **Voice:** Vapi + Deepgram Nova-3 (STT) + ElevenLabs (TTS)
- **Booking:** Cal.com integration via tool calling
- **Provider Pattern:** All services are swappable via env vars (LLM, embedding, vector store, voice, TTS, STT, calendar)

## Key Files
- `src/lib/persona/prompts.ts` — System prompts (voice + chat). The chat prompt has compelling framing + anti-hallucination rules
- `src/lib/rag/retriever.ts` — RAG pipeline (embed → hybrid search → XML context)
- `src/lib/rag/ingest.ts` — Ingestion pipeline (markdown → chunk → embed → upsert)
- `src/lib/ai/model.ts` — LLM factory (azure-openai, bedrock, openai, google, anthropic, groq)
- `src/app/api/chat/route.ts` — Chat API with streaming + tool calling
- `src/lib/config/env.ts` — Zod-validated env config
- `data/` — Knowledge base markdown files (resume, GitHub repos, role-fit)
- `data/github/` — Per-repo knowledge base files
- `scripts/ingest.ts` — Run `npx tsx scripts/ingest.ts` to re-ingest after KB changes
- `scripts/setup-supabase.sql` — PostgreSQL schema (works for Azure PG too)
- `docs/eval/eval-report.md` — Eval report (Part C) — THIS SHOULD EVOLVE WITH TESTING

## Real Resume (Source of Truth)
- PDF at: `/Users/abhinavjha/Documents/agent/Abhinav_Jha_10045_SST.pdf`
- **Education:** Scaler School of Technology (BS+MS, 2027) + BITS Pilani (B.S. CS, 2026)
- **Experience:** Backend Engineer Independent @ test-platform (Jan 2026-Present), Backend Intern @ Kugelblitz (Feb 2025-Jan 2026), SWE Intern @ Scaler Innovation Lab (Dec 2024-Dec 2025)
- **Achievement:** Winner Scaler AI Labs Hackathon (Rs.1.5L), Open Source Mentor (5+ GSoC students)

## Eval Report Status
The eval report at `docs/eval/eval-report.md` should be kept up-to-date as testing continues. Current findings:
- **17 automated tests run** (7 Part B compliance + 10 adversarial)
- **3 failure modes found and fixed:** education hallucination, defensive framing, off-topic drift
- **Test results log:** Keep adding new test results to `docs/eval/test-log.md`

## Live Deployed Links
- test-platform: http://sst.smilein.live/
- Attendance System: https://attend.sst.smilein.live/ (used at Scaler SST)
- OS Tracker / GSoC Tracker: https://gsoc-tracker.vercel.app/
- Contest Tracker: not deployed
- DeepSkill: under trial, not publicly available
- Dog Tracker: deployed but downgraded

## Recently Implemented
- **Conversation-aware retrieval:** `src/app/api/chat/route.ts` now builds search queries from last 2 turns of conversation, not just the latest message. This fixes "tell me more about that" disambiguation.
- **Source-code-level KB:** Research agents read actual source code from GitHub repos and write knowledge base files with function names, struct definitions, and code snippets.

## Important Decisions Made
- Removed LLM-as-reranker from retriever — overkill for 70 docs, saves 3-5s latency
- System prompt uses positive/compelling framing, not defensive "honest limitations" style
- Anti-hallucination rules are STRICT for factual claims (education, dates, companies) — model must use EXACT text from context
- AWS Bedrock is wired up but user's account has payment instrument issue — switch `LLM_PROVIDER=bedrock` when resolved
- AWS budget guard: $20 cap with Lambda auto-kill (DenyBedrockOnBudgetExceeded policy)

## How to Re-ingest Knowledge Base
```bash
cd /Users/abhinavjha/Documents/agent/ai-persona
npx tsx scripts/ingest.ts
```
This reads all `.md` files from `data/` (including `data/github/`), chunks by ## headings, embeds via Azure OpenAI, and upserts to Azure PG.

## How to Test Chat
```bash
curl -s http://localhost:3001/api/chat -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"YOUR QUESTION"}]}]}' \
  --max-time 30 | grep 'text-delta' | sed 's/.*"delta":"//;s/"}$//' | tr -d '\n'
```

## Azure Resources (don't touch exam-platform-rg)
- `rg-abhinavjha07-6994`: Azure OpenAI + AI Persona PG server (THIS PROJECT)
- `exam-platform-rg`: exam VMs, Redis, PG (SEPARATE PROJECT — DO NOT MODIFY)
