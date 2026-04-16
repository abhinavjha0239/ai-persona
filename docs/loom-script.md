# Loom Walkthrough Script (~3 min)

**Screen: abhinav.smilein.live (landing page)**

> Hey — this is a quick walkthrough of my AI persona project. Two interfaces — voice and chat — both grounded by the same RAG pipeline, both capable of real calendar booking through tool calling.

**Screen: scroll down to architecture diagram**

> Here's the architecture. At the top, two clients — a voice call powered by Vapi with Deepgram for STT and Cartesia for TTS, and a chat UI built in Next.js with React. Both hit Next.js API routes — `/api/voice/webhook` for voice, `/api/chat` for chat, `/api/booking` for calendar operations.

> The core intelligence is the RAG pipeline. User queries go through query augmentation — I detect the topic, like education or work experience, and append domain keywords to boost retrieval. Then it embeds with Azure OpenAI text-embedding-3-small, runs a hybrid search — BM25 full-text combined with vector similarity using Reciprocal Rank Fusion — against pgvector on Azure PostgreSQL. Top chunks get injected as XML-tagged context into GPT-5.4-mini.

> The knowledge base is about 188 chunks, ingested from my actual resume, 8 GitHub repos analyzed at source-code level — real function signatures, struct definitions, Docker flags — plus project writeups. No hardcoded answers.

**Screen: open /chat, type "Where did you study?"**

> Let me show grounding in action. "Where did you study?" — this triggers the education keyword boost, retrieves the right chunks, and you can see: exact institution names, exact degrees, exact years. All from RAG context, not the model's parametric knowledge.

**Screen: type "Tell me about your Kubernetes experience"**

> Now an adversarial trap. I haven't used Kubernetes — my resume has Docker and gVisor. Watch the response — it opens with "I haven't worked with Kubernetes directly" before pivoting to related container experience. That's a deliberate anti-hallucination rule — the model must acknowledge gaps before connecting to what it does know.

**Screen: type "Can we schedule a call?"**

> Booking is real tool calling, not regex heuristics. The AI asks for a preferred time, calls `check_availability` against Cal.com's live API, confirms the slot, collects name and email, then calls `create_booking`. Real meeting link, real calendar invite.

**Screen: show eval report (scroll through briefly)**

> On eval — I ran 43 test queries across two sessions and found 9 failure modes. The most interesting was education hallucination. It wasn't just a prompt issue — I traced it to three compounding bugs: the regex patterns in query augmentation used word boundaries that silently failed on words like "education", then the conversation context injection overwrote the keyword boost, and finally the anti-hallucination rules were too generic. Fixing all three layers got it to 100% accuracy on factual claims.

> The hardest unsolved problem is voice email collection — about 30% first-attempt accuracy. STT models just aren't built for alphanumeric strings. I've partially mitigated it with NATO phonetic confirmation, but this is the problem I'd dig into next given more time.

**Screen: back to landing page**

> That's the system — RAG-grounded, real tool calling, real booking, honest about what works and what doesn't. The code's on GitHub, the demo's live. Thanks for watching.
