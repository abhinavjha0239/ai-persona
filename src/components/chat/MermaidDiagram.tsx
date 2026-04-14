"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders a pre-validated Mermaid diagram.
 * Only used for STATIC, pre-tested diagrams — never for LLM output.
 */
export function MermaidDiagram({ chart, className }: { chart: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          fontFamily: "system-ui, sans-serif",
          flowchart: { htmlLabels: true, curve: "basis" },
        });
        const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: rendered } = await mermaid.render(id, chart);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [chart]);

  if (error) return null; // Silent fail — never show broken diagram
  if (!svg) return null;

  return (
    <div
      ref={ref}
      className={className}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
