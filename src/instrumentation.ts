// ============================================================
// Next.js Instrumentation — Server Boot Warm-Up
// ============================================================
// Runs once at `next start` before the first request hits.
// Pre-initializes the three slow resources so every request
// (including the very first) responds in < 1.5 s:
//
//   Resource              Cold-start cost  Why it's slow
//   ──────────────────────────────────────────────────────
//   PostgreSQL pool       ~250 ms          TLS handshake to Azure PG
//   Embedding provider    ~300 ms          Dynamic import + TLS to Azure AOAI
//   Azure AOAI SDK        ~50–100 ms       Module parse + TLS pre-connect
//
// All three run in parallel via Promise.allSettled so a
// failure in one doesn't block the others.
// ============================================================

export async function register() {
  // Only run on the Node.js runtime (not Edge/middleware)
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const start = Date.now();

  const results = await Promise.allSettled([
    // 1. Open PG pool and verify connectivity
    import("@/lib/rag/retriever").then((m) => m.warmPool()),

    // 2. Initialize embedding provider (dynamic import + TLS)
    import("@/lib/providers/registry").then((m) => m.getEmbeddingProvider()),

    // 3. Pre-load the Azure AI SDK module cache
    import("@ai-sdk/azure"),
  ]);

  const ms = Date.now() - start;

  const statuses = results.map((r, i) => {
    const label = ["pg-pool", "embedder", "azure-sdk"][i];
    return r.status === "fulfilled" ? `${label}:ok` : `${label}:fail`;
  });

  console.log(`[Boot] Warm-up complete in ${ms}ms — ${statuses.join(", ")}`);
}
