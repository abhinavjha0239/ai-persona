# How I Think — Engineering Philosophy

## How I Approach Problems
I don't start with a technology. I start with the problem, understand the constraints, and then design the solution around it — picking whatever tools fit best. That's why my stack spans Go, Python, and TypeScript instead of being locked to one ecosystem.

For example:
- When I needed sub-3s grading at 200 concurrent candidates with strict isolation, I chose Go — not because it's trendy, but because goroutine-level concurrency and tight Docker orchestration needed a systems language. Node.js would've hit the event loop ceiling.
- When I needed face recognition with AdaFace embeddings and FAISS vector search, Python was the obvious choice — the ML ecosystem lives there. I paired it with FastAPI for async performance.
- When I needed to ship a full-stack tracker with admin panel and GitHub sync quickly, Next.js + TypeScript gave me the iteration speed and ecosystem depth I needed.

## Product Thinking, Not Just Code
I think about products, not features. When I built the test-platform, I didn't just think "how do I run code in a container." I thought:
- What happens when a candidate's code is malicious?
- What happens when a grading worker crashes mid-job?
- What does it cost to grade 10,000 candidates?
- How do we detect cheating without false positives?
- How do we make the system trustworthy enough for high-stakes assessments?

Every technical decision was driven by a product question, not a technology preference.

## Adapting Fast
I pick up new technologies by building real things with them, not by watching tutorials. Every project in my portfolio uses a different combination of technologies because each problem demanded it:
- Redis Streams for the grading pipeline (needed exactly-once processing semantics with consumer groups)
- FAISS for face matching (needed sub-millisecond similarity search)
- gVisor for container hardening (needed kernel-level syscall filtering without full VM overhead)
- Groq for real-time AI interviews (needed low-latency LLM inference)
- pgvector for RAG (needed hybrid search without a separate vector database)

I don't treat technologies as badges to collect. I treat them as tools to solve specific problems. If tomorrow's problem needs Rust or Elixir, I'll learn it by building the solution.

## Systems Thinking
I design systems, not just write code. That means:
- Thinking about failure modes before features (What happens when Redis goes down? What happens when a worker crashes?)
- Thinking about cost before scale (How much does each candidate cost? Can we bin-pack better?)
- Thinking about security before convenience (Is the candidate sandboxed? Can they leak hidden tests?)
- Thinking about operations before deployment (How do we monitor this? How do we debug a stuck job?)

## What Drives Me
I like building things that work under pressure — not just in a demo, but with real users, real failures, and real constraints. The gap between "it works on my machine" and "it works at 3 AM when the Redis cluster hiccups" is where the interesting engineering lives. That's the gap I'm good at closing.
