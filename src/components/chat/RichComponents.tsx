"use client";

import { useState } from "react";
import { Copy, Check, ExternalLink, GitBranch } from "lucide-react";

// ============================================================
// Rich inline components for chat messages
// ============================================================

// 1. Project Card
export function ProjectCard({ name, stack, metric, repo }: {
  name: string; stack: string[]; metric?: string; repo?: string;
}) {
  return (
    <div className="my-3 rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50/50 to-purple-50/30 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold text-gray-900 text-sm">{name}</h4>
          {metric && <p className="text-xs text-blue-600 font-medium mt-0.5">{metric}</p>}
        </div>
        {repo && (
          <a href={repo} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition-colors flex-shrink-0">
            <GitBranch className="w-3 h-3" /> GitHub
          </a>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {stack.map(t => <TechChip key={t} name={t} />)}
      </div>
    </div>
  );
}

// 4. Metrics Bar
export function MetricsBar({ metrics }: { metrics: { label: string; value: string }[] }) {
  return (
    <div className="my-3 flex flex-wrap gap-3">
      {metrics.map((m, i) => (
        <div key={i} className="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
          <span className="text-lg font-bold text-blue-600">{m.value}</span>
          <span className="text-xs text-gray-500">{m.label}</span>
        </div>
      ))}
    </div>
  );
}

// 5. Tech Chip
const TECH_COLORS: Record<string, string> = {
  go: "bg-cyan-50 text-cyan-700 border-cyan-200",
  python: "bg-yellow-50 text-yellow-700 border-yellow-200",
  typescript: "bg-blue-50 text-blue-700 border-blue-200",
  javascript: "bg-yellow-50 text-yellow-700 border-yellow-200",
  react: "bg-sky-50 text-sky-700 border-sky-200",
  "next.js": "bg-gray-100 text-gray-800 border-gray-300",
  redis: "bg-red-50 text-red-700 border-red-200",
  docker: "bg-blue-50 text-blue-600 border-blue-200",
  gvisor: "bg-orange-50 text-orange-700 border-orange-200",
  postgresql: "bg-indigo-50 text-indigo-700 border-indigo-200",
  mongodb: "bg-green-50 text-green-700 border-green-200",
  fastapi: "bg-emerald-50 text-emerald-700 border-emerald-200",
  faiss: "bg-purple-50 text-purple-700 border-purple-200",
  adaface: "bg-pink-50 text-pink-700 border-pink-200",
  "socket.io": "bg-gray-100 text-gray-700 border-gray-300",
  aws: "bg-orange-50 text-orange-600 border-orange-200",
  groq: "bg-violet-50 text-violet-700 border-violet-200",
  vapi: "bg-teal-50 text-teal-700 border-teal-200",
  sql: "bg-indigo-50 text-indigo-600 border-indigo-200",
};

export function TechChip({ name }: { name: string }) {
  const color = TECH_COLORS[name.toLowerCase()] || "bg-gray-50 text-gray-600 border-gray-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${color}`}>
      {name}
    </span>
  );
}

// 6. Timeline
export function Timeline({ items }: { items: { date: string; title: string; subtitle: string }[] }) {
  return (
    <div className="my-3 relative pl-6 border-l-2 border-blue-200 space-y-4">
      {items.map((item, i) => (
        <div key={i} className="relative">
          <div className="absolute -left-[25px] w-3 h-3 rounded-full bg-blue-500 border-2 border-white" />
          <p className="text-xs text-blue-600 font-medium">{item.date}</p>
          <p className="text-sm font-semibold text-gray-900">{item.title}</p>
          <p className="text-xs text-gray-500">{item.subtitle}</p>
        </div>
      ))}
    </div>
  );
}

// 8. Link Card (GitHub repo)
export function RepoLinkCard({ name, description, url }: {
  name: string; description: string; url: string;
}) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="my-2 flex items-center gap-3 rounded-lg border border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm transition-all p-3 group">
      <div className="w-9 h-9 rounded-lg bg-gray-900 flex items-center justify-center flex-shrink-0">
        <GitBranch className="w-4 h-4 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900 group-hover:text-blue-600 truncate">{name}</p>
        <p className="text-xs text-gray-500 truncate">{description}</p>
      </div>
      <ExternalLink className="w-4 h-4 text-gray-300 group-hover:text-blue-400 flex-shrink-0" />
    </a>
  );
}

// 3. Code Block with syntax highlighting
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden border border-gray-200 bg-gray-900">
      {language && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 text-gray-400 text-[10px] border-b border-gray-700">
          <span className="font-mono">{language}</span>
          <button onClick={handleCopy}
            className="flex items-center gap-1 hover:text-white transition-colors">
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <pre className="p-3 overflow-x-auto text-xs leading-relaxed">
        <code className="text-gray-100 font-mono">
          <SyntaxColorize code={code} language={language} />
        </code>
      </pre>
      {!language && (
        <button onClick={handleCopy}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded bg-gray-700 text-gray-300 hover:text-white transition-all">
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
        </button>
      )}
    </div>
  );
}

// Basic syntax colorization (no external lib needed)
function SyntaxColorize({ code, language }: { code: string; language: string }) {
  if (!language) return <>{code}</>;

  const lines = code.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {colorizeLine(line, language)}
          {i < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </>
  );
}

function colorizeLine(line: string, lang: string): React.ReactNode {
  // Comments
  if (line.trimStart().startsWith("//") || line.trimStart().startsWith("#")) {
    return <span className="text-gray-500 italic">{line}</span>;
  }

  // Apply basic keyword highlighting
  const keywords = lang === "go"
    ? ["func", "return", "if", "else", "for", "range", "select", "case", "switch", "go", "defer", "chan", "struct", "type", "package", "import", "var", "const"]
    : lang === "python"
    ? ["def", "class", "return", "if", "else", "for", "in", "import", "from", "async", "await", "with", "try", "except", "raise", "self"]
    : lang === "typescript" || lang === "javascript" || lang === "ts" || lang === "js"
    ? ["const", "let", "var", "function", "return", "if", "else", "for", "of", "in", "async", "await", "import", "export", "from", "class", "new", "throw", "try", "catch"]
    : lang === "sql"
    ? ["SELECT", "FROM", "WHERE", "JOIN", "LEFT", "ON", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "INDEX", "GROUP", "BY", "ORDER", "HAVING", "AND", "OR", "NOT", "NULL", "AS", "CONFLICT", "DO", "UNIQUE", "PRIMARY", "KEY", "REFERENCES", "CASCADE", "DEFAULT", "CHECK", "IN", "INTEGER", "TEXT", "VARCHAR", "BOOLEAN", "TIMESTAMP", "SERIAL", "JSONB"]
    : [];

  if (keywords.length === 0) return <>{line}</>;

  // Split by word boundaries and colorize keywords
  const parts = line.split(/(\b\w+\b|"[^"]*"|'[^']*'|`[^`]*`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (keywords.includes(part)) return <span key={i} className="text-purple-400 font-medium">{part}</span>;
        if (part.match(/^["'`].*["'`]$/)) return <span key={i} className="text-green-400">{part}</span>;
        if (part.match(/^\d+$/)) return <span key={i} className="text-orange-400">{part}</span>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
