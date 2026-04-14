# GitHub Projects

## AI Persona (This Project)
**Repo:** ai-persona
**Tech Stack:** Next.js 16, TypeScript, Vapi Web SDK, Vercel AI SDK, Supabase pgvector, Cal.com API, Zod, Tailwind CSS
**Purpose:** A full-stack AI persona that represents me. Supports voice calling (Hindi + English), text chat with RAG grounding, and live interview booking via Cal.com.
**Architecture:**
- Provider pattern: swap voice/LLM/calendar/embedding/vector-store providers by changing one env var
- Voice pipeline: Vapi (Deepgram STT → GPT-4o-mini → ElevenLabs TTS)
- Chat pipeline: RAG retrieval → Google Gemini → streaming response
- Security: webhook HMAC verification, rate limiting, input sanitization, Zod validation
**Tradeoffs:**
- Chose Vapi over building raw WebRTC for faster iteration and phone number support
- Used pgvector over Pinecone because Supabase free tier includes it — no extra cost
- Provider abstraction adds indirection but makes switching services a 1-line env change
**What I learned:** Production voice AI needs aggressive latency optimization — ElevenLabs turbo model + Deepgram nova-2 were critical for sub-500ms response times.

<!-- Add your other GitHub repos below. Follow this format: -->

## [Project Name]
**Repo:** [repo-name]
**Tech Stack:** [languages, frameworks, databases]
**Purpose:** [1-2 sentences on what it does and why]
**Architecture:** [key design decisions]
**Tradeoffs:** [what you chose and why]
**What I learned:** [key takeaway]
