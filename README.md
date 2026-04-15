# AI Persona — Abhinav Jha

An AI-powered digital representative that can answer questions about my background via **voice calls** and **RAG-grounded chat**, and **book real calendar meetings** end-to-end.

**Live:** [smilein.live](https://smilein.live) &nbsp;|&nbsp; **Phone:** Call via the web interface or the Vapi-powered number

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│  ┌─────────────────────┐     ┌─────────────────────────────┐   │
│  │  Voice Call (Vapi)   │     │  Chat UI (Next.js + React)  │   │
│  │  Deepgram STT        │     │  Streaming + Rich Markdown  │   │
│  │  ElevenLabs TTS      │     │  Project Cards, Tech Chips  │   │
│  └────────┬────────────┘     └──────────┬──────────────────┘   │
└───────────┼──────────────────────────────┼─────────────────────┘
            │                              │
            ▼                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Layer (Next.js)                          │
│  /api/voice/webhook    /api/chat    /api/booking/{slots,create} │
└───────┬──────────────────┬──────────────────┬──────────────────┘
        │                  │                  │
        │                  ▼                  │
        │   ┌──────────────────────────┐      │
        │   │     RAG Pipeline         │      │
        │   │  ┌──────────────────┐    │      │
        │   │  │ Azure OpenAI     │    │      │
        │   │  │ Embeddings(1536d)│    │      │
        │   │  └───────┬──────────┘    │      │
        │   │          ▼               │      │
        │   │  ┌──────────────────┐    │      │
        │   │  │ Hybrid Search    │    │      │
        │   │  │ BM25+Vector(RRF) │    │      │
        │   │  └───────┬──────────┘    │      │
        │   │          ▼               │      │
        │   │  ┌──────────────────┐    │      │
        │   │  │ Azure PostgreSQL │    │      │
        │   │  │ pgvector (188    │    │      │
        │   │  │ chunks)          │    │      │
        │   │  └──────────────────┘    │      │
        │   └──────────────────────────┘      │
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│ Azure OpenAI │  │ Azure OpenAI     │  │  Cal.com      │
│ GPT-4.1-mini │  │ GPT-4.1-mini     │  │  Calendar API │
│ (Voice LLM)  │  │ (Chat LLM)       │  │  Real Booking │
└──────────────┘  └──────────────────┘  └──────────────┘
```

### Knowledge Base (188 chunks)

The RAG pipeline ingests real data — no hardcoded answers:

| Source | Content |
|--------|---------|
| `data/resume.md` | Education, work experience, skills, achievements |
| `data/github/*.md` | 8 repos: architecture docs, source code analysis, tradeoffs |
| `data/projects.md` | Detailed project writeups with engineering decisions |
| `data/role-fit.md` | Why I'm suited for the Scaler AI Engineer role |
| `data/engineering-philosophy.md` | How I approach technical decisions |

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 | Streaming UI, server components, fast iteration |
| **Voice** | Vapi (orchestration) + Deepgram (STT) + ElevenLabs (TTS) | Low-latency voice with interruption handling |
| **LLM** | Azure OpenAI GPT-4.1-mini | Tool calling, structured output, cost-efficient |
| **RAG** | pgvector on Azure PostgreSQL | Hybrid search: BM25 full-text + vector similarity with RRF fusion |
| **Embeddings** | Azure OpenAI text-embedding-3-small (1536d) | High quality, native Azure integration |
| **Calendar** | Cal.com API v2 | Free tier, full API, real booking confirmation |
| **Deployment** | Vercel (frontend) + Azure (DB + LLM) | Zero-config Next.js deploys, Azure credits for infra |

### Provider Architecture

Every service is **swappable via environment variables** — zero code changes:

```
VOICE_PROVIDER=vapi          # vapi | retell | bolna
LLM_PROVIDER=azure-openai    # azure-openai | openai | anthropic | groq | google | bedrock
CALENDAR_PROVIDER=calcom     # calcom | calendly | google
EMBEDDING_PROVIDER=azure-openai  # azure-openai | openai | google | cohere | voyage
VECTOR_STORE_PROVIDER=azure-pg   # azure-pg | supabase | pinecone | qdrant | chroma
```

---

## Features

### Voice Agent
- Browser-based calling via Vapi Web SDK
- Hindi + English bilingual (auto-detects caller's language)
- Interruption handling (barge-in sensitivity: 0.8)
- First response latency < 2 seconds
- Real calendar booking with phonetic email confirmation (NATO alphabet)
- Graceful error recovery (tool failures, silence, unclear intent)

### Chat Interface
- Streaming responses with RAG grounding (XML-tagged context injection)
- AI SDK v6 tool calling: `check_availability` + `create_booking`
- Rich UI: project cards, tech chips, metrics bars, experience timelines, code blocks
- Smart follow-up suggestions (context-aware, non-repetitive)
- Anti-hallucination: strict factual grounding from retrieved context
- Out-of-scope redirection (not a general assistant)

### Calendar Booking (End-to-End)
- Real Cal.com integration with live availability
- Deduplication guard (30s window prevents double-booking)
- Input sanitization on all user-supplied fields
- Timezone-aware (IST default)

### Security
- HMAC-SHA256 webhook signature verification
- Per-route rate limiting (sliding window)
- Zod validation on all API inputs
- Input sanitization (HTML stripping, control char removal)
- Security headers (HSTS, X-Frame-Options, CSP)
- Origin verification in production

---

## Local Setup

### Prerequisites
- Node.js 20+
- An Azure OpenAI resource (or OpenAI API key)
- A PostgreSQL database with pgvector extension
- A Cal.com account with an event type
- A Vapi account (for voice)

### Steps

```bash
# 1. Clone and install
git clone https://github.com/abhinavjha0239/ai-persona.git
cd ai-persona
npm install

# 2. Configure environment
cp .env.example .env.local
# Fill in required keys (see .env.example for docs)

# 3. Set up the database
# Run the SQL in scripts/setup-supabase.sql against your PostgreSQL instance

# 4. Ingest knowledge base
npx tsx scripts/ingest.ts
npx tsx scripts/ingest-github.ts

# 5. Start dev server
npm run dev
# Open http://localhost:3000
```

### Docker

```bash
docker build -t ai-persona .
docker run -p 3000:3000 --env-file .env.local ai-persona
```

---

## Project Structure

```
ai-persona/
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Landing page (voice + navigation)
│   │   ├── chat/page.tsx            # Chat interface
│   │   └── api/
│   │       ├── chat/route.ts        # Streaming chat with tool calling
│   │       ├── booking/
│   │       │   ├── slots/route.ts   # GET available slots
│   │       │   └── create/route.ts  # POST create booking
│   │       └── voice/
│   │           ├── token/route.ts   # Voice SDK initialization
│   │           └── webhook/route.ts # Voice platform webhook handler
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ChatWindow.tsx       # Main chat UI with streaming
│   │   │   ├── RichComponents.tsx   # Project cards, tech chips, etc.
│   │   │   └── MermaidDiagram.tsx   # Architecture diagram renderer
│   │   ├── voice/VoiceButton.tsx    # Voice call button with transcript
│   │   └── ArchitectureDiagram.tsx  # Static architecture visualization
│   ├── hooks/useVoice.ts           # Vapi Web SDK React hook
│   └── lib/
│       ├── ai/
│       │   ├── model.ts            # LLM provider factory
│       │   └── chat-tools.ts       # Tool definitions (availability + booking)
│       ├── booking/service.ts      # Booking business logic
│       ├── config/env.ts           # Zod-validated environment config
│       ├── persona/
│       │   ├── prompts.ts          # System prompts (voice + chat)
│       │   └── config.ts           # Tool definitions + slot formatting
│       ├── providers/
│       │   ├── registry.ts         # Service locator (singleton cache)
│       │   ├── types.ts            # Provider interfaces
│       │   ├── calendar/           # Cal.com, Calendly, Google Calendar
│       │   ├── embedding/          # Azure, OpenAI, Google, Cohere, Voyage
│       │   ├── llm/                # Azure, OpenAI, Anthropic, Groq, Google
│       │   ├── vector-store/       # Azure PG, Supabase, Pinecone, Qdrant, Chroma
│       │   ├── voice/              # Vapi, Retell, Bolna
│       │   ├── tts/                # ElevenLabs, Azure, Deepgram, PlayHT
│       │   └── stt/                # Deepgram, Azure, AssemblyAI
│       ├── rag/
│       │   ├── retriever.ts        # Hybrid search + XML context formatting
│       │   └── ingest.ts           # Document chunking + embedding
│       └── security/
│           ├── rate-limit.ts       # Sliding window rate limiter
│           ├── sanitize.ts         # Input sanitization
│           └── webhook.ts          # HMAC signature verification
├── data/                           # Knowledge base source files
│   ├── resume.md
│   ├── projects.md
│   ├── github/                     # Per-repo docs + code analysis
│   ├── role-fit.md
│   └── engineering-philosophy.md
├── scripts/
│   ├── ingest.ts                   # Main ingestion script
│   ├── ingest-github.ts            # GitHub repo ingestion
│   ├── setup-supabase.sql          # Database schema + functions
│   └── setup-vapi.ts               # Vapi assistant configuration
└── docs/eval/                      # Eval report and test logs
```

---

## Evaluation Metrics

See the full [eval report](docs/eval/eval-report.md) for detailed measurements.

| Metric | Target | Measured |
|--------|--------|----------|
| Voice first response latency | < 2s | ~1.4s |
| Voice interruption handling | No crash | Handled (sensitivity 0.8) |
| Chat RAG groundedness | No hallucination on facts | Verified on 15+ test queries |
| Calendar booking (chat) | End-to-end | Working (Cal.com v2) |
| Calendar booking (voice) | End-to-end | Working (NATO phonetic email) |
| Knowledge base coverage | Resume + GitHub | 188 chunks across 8 repos |

---

## License

MIT
