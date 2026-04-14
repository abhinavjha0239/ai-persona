"use client";

import { MermaidDiagram } from "./chat/MermaidDiagram";

// Pre-validated, static diagram — NOT LLM-generated
const ARCHITECTURE_CHART = `flowchart TB
  subgraph Client["Client Layer"]
    Voice["Voice Call<br/>(Vapi + Deepgram)"]
    Chat["Chat UI<br/>(Next.js React)"]
  end

  subgraph API["API Layer (Next.js)"]
    VoiceAPI["/api/voice/webhook"]
    ChatAPI["/api/chat"]
    BookAPI["/api/booking"]
  end

  subgraph RAG["RAG Pipeline"]
    Embed["Azure OpenAI<br/>Embeddings (1536d)"]
    Search["Hybrid Search<br/>BM25 + Vector (RRF)"]
    PG[("Azure PostgreSQL<br/>pgvector")]
  end

  subgraph LLM["LLM Layer"]
    GPT["GPT-4.1<br/>(Azure OpenAI)"]
  end

  subgraph KB["Knowledge Base (188 chunks)"]
    Resume["Resume PDF"]
    Code["Source Code<br/>(Go, Python, TS)"]
    Docs["Project Docs<br/>(Architecture, FAQ)"]
  end

  Voice --> VoiceAPI
  Chat --> ChatAPI
  ChatAPI --> Embed
  Embed --> Search
  Search --> PG
  PG --> GPT
  ChatAPI --> GPT
  ChatAPI --> BookAPI
  BookAPI --> Cal["Cal.com"]
  KB -.->|"ingested"| PG

  style Client fill:#eff6ff,stroke:#3b82f6
  style RAG fill:#f0fdf4,stroke:#22c55e
  style LLM fill:#fefce8,stroke:#eab308
  style KB fill:#faf5ff,stroke:#a855f7`;

export function ArchitectureDiagram() {
  return (
    <div className="w-full max-w-3xl mx-auto">
      <h3 className="text-sm font-semibold text-gray-700 text-center mb-4">System Architecture</h3>
      <div className="bg-white rounded-xl border border-gray-100 p-4 overflow-x-auto">
        <MermaidDiagram chart={ARCHITECTURE_CHART} className="flex justify-center [&_svg]:max-w-full" />
      </div>
    </div>
  );
}
