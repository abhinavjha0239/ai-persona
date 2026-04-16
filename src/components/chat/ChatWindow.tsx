"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils/cn";
import { Send, Loader2, Bot, User, RotateCcw, Search, Sparkles, Database, Trash2, CheckCircle2, Calendar, Mail, Video, Clock } from "lucide-react";
import { ProjectCard, MetricsBar, TechChip, Timeline, CodeBlock } from "./RichComponents";
import { ErrorBoundary } from "./ErrorBoundary";

// ============================================================
// ChatWindow — Rich chat with streaming + visual components
// ============================================================

const SUGGESTED_QUESTIONS = [
  "Why are you the right person for this role?",
  "Tell me about your test-platform architecture",
  "What's your tech stack and experience?",
  "Can we schedule an interview?",
];

// Dynamic follow-up pool — topic + priority drive suggestion trajectory
// priority: lower = more lucrative/impressive. CTA always last.
const ALL_FOLLOW_UPS: { keywords: string[]; q: string; topic: string; priority: number }[] = [
  // test-platform (crown jewel — priority 1)
  { keywords: ["container", "isolation", "docker", "gvisor"], q: "How does Two-Container Isolation prevent test leakage?", topic: "test-platform", priority: 1 },
  { keywords: ["security", "cheating", "proctoring", "anti-cheat"], q: "How do you detect suspicious behavior during exams?", topic: "test-platform", priority: 1 },
  { keywords: ["scale", "concurrent", "grading", "redis streams"], q: "How does grading handle 200+ concurrent candidates?", topic: "test-platform", priority: 1 },
  { keywords: ["redis", "streams", "consumer", "worker", "crash"], q: "Walk me through Redis Streams failure recovery", topic: "test-platform", priority: 1 },
  { keywords: ["cost", "economics", "spot", "dollar"], q: "How did you optimize to $1-3 per candidate?", topic: "test-platform", priority: 1 },
  // achievements (standout differentiators — priority 2)
  { keywords: ["hackathon", "winner", "1.5l", "rl task"], q: "How did you win the Scaler AI Labs Hackathon?", topic: "achievements", priority: 2 },
  { keywords: ["open source", "mentor", "gsoc"], q: "Tell me about your open source mentorship", topic: "achievements", priority: 2 },
  // attendance — ML/CV depth (priority 3)
  { keywords: ["adaface", "embedding", "face recognition", "attendance"], q: "Why AdaFace over ArcFace for embeddings?", topic: "attendance", priority: 3 },
  { keywords: ["faiss", "index", "similarity", "search"], q: "How does FAISS batch-section scoping work?", topic: "attendance", priority: 3 },
  { keywords: ["websocket", "real-time", "camera", "live"], q: "How does WebSocket real-time recognition work?", topic: "attendance", priority: 3 },
  // deepskill — AI product depth (priority 4)
  { keywords: ["deepskill", "graph", "interview", "agent"], q: "How does the Agent Graph Builder work?", topic: "deepskill", priority: 4 },
  { keywords: ["rubric", "evaluation", "chaos", "llm eval"], q: "How does rubric-based evaluation work in DeepSkill?", topic: "deepskill", priority: 4 },
  // professional experience (priority 5)
  { keywords: ["kugelblitz", "payments", "kyc", "otp"], q: "What did you build at Kugelblitz?", topic: "experience", priority: 5 },
  { keywords: ["scaler innovation", "erp", "cloud run"], q: "Tell me about Scaler Innovation Lab", topic: "experience", priority: 5 },
  // education (priority 6)
  { keywords: ["education", "bits", "pilani", "degree"], q: "Tell me about your education", topic: "education", priority: 6 },
  // other projects (priority 7)
  { keywords: ["circuit breaker", "codeforces", "cp-tracker"], q: "How does the circuit breaker in cp-tracker work?", topic: "other", priority: 7 },
  { keywords: ["dog", "tracker", "qr", "lost"], q: "How does the QR code lost-dog system work?", topic: "other", priority: 7 },
  { keywords: ["sql", "raw", "postgresql", "os_tracker"], q: "Why raw SQL over an ORM in Os_Tracker?", topic: "other", priority: 7 },
  // CTA — always available but low priority (priority 8)
  { keywords: ["schedule", "call", "meeting", "book"], q: "Can we schedule an interview call?", topic: "cta", priority: 8 },
  { keywords: ["right person", "hire", "fit", "candidate"], q: "What's the most impressive thing you've built?", topic: "cta", priority: 8 },
];

// Topic entry questions — the best first question to open each new topic
const TOPIC_OPENERS: Record<string, string> = {
  "test-platform": "Tell me about your test-platform architecture",
  "achievements": "How did you win the Scaler AI Labs Hackathon?",
  "attendance": "Tell me about the face recognition attendance system",
  "deepskill": "How does the Agent Graph Builder work?",
  "experience": "What did you build at Kugelblitz?",
  "education": "Tell me about your education",
};

// Broad opening questions — used when conversation just started (≤2 messages)
const OPENING_FOLLOW_UPS = [
  "Why are you the right person for this role?",
  "Walk me through your strongest project",
  "What's your work experience?",
];

function getFollowUps(lastText: string, allTexts: string[], messageCount: number): string[] {
  // Early conversation — suggest broad discovery, not deep dives
  if (messageCount <= 2) {
    const discussed = allTexts.join(" ").toLowerCase();
    return OPENING_FOLLOW_UPS.filter(q => !discussed.includes(q.toLowerCase().slice(0, 20))).slice(0, 2);
  }

  const discussed = allTexts.join(" ").toLowerCase();
  const last = lastText.toLowerCase();

  const available = ALL_FOLLOW_UPS.filter(f => !discussed.includes(f.q.toLowerCase().slice(0, 25)));

  const scored = available.map(f => ({
    ...f,
    rel: f.keywords.filter(k => last.includes(k)).length,
    ctxRel: f.keywords.filter(k => discussed.includes(k)).length,
  }));

  // 1. Best deep-dive for current thread (highest rel, then lowest priority number)
  const related = scored
    .filter(s => s.rel > 0)
    .sort((a, b) => b.rel - a.rel || a.priority - b.priority)[0];

  const currentTopic = related?.topic;

  // Count how many items per topic have been explored (keywords in full context)
  const exploredCountByTopic: Record<string, number> = {};
  for (const f of ALL_FOLLOW_UPS) {
    const hits = f.keywords.filter(k => discussed.includes(k)).length;
    if (hits > 0) exploredCountByTopic[f.topic] = (exploredCountByTopic[f.topic] ?? 0) + 1;
  }

  // Topic is "saturated" when ≥2 of its follow-ups have been explored
  const currentTopicSaturated = (exploredCountByTopic[currentTopic ?? ""] ?? 0) >= 2;

  // 2. "Lucrative" fresh pick — navigate toward next high-value unexplored topic
  //    a) If current topic is saturated: pivot to the highest-priority unexplored topic
  //    b) Otherwise: another angle on the current topic (ctxRel > 0, not the same as related)
  let fresh: (typeof scored)[0] | undefined;

  if (currentTopicSaturated || !currentTopic) {
    // Find highest-priority topic not yet explored, excluding cta
    const unexploredTopics = Object.keys(TOPIC_OPENERS).filter(
      t => t !== currentTopic && (exploredCountByTopic[t] ?? 0) === 0
    );
    const nextTopic = unexploredTopics.sort((a, b) => {
      const pa = ALL_FOLLOW_UPS.find(f => f.topic === a)?.priority ?? 99;
      const pb = ALL_FOLLOW_UPS.find(f => f.topic === b)?.priority ?? 99;
      return pa - pb;
    })[0];

    if (nextTopic) {
      // Use the opener question if it hasn't been asked, else best available from that topic
      const openerQ = TOPIC_OPENERS[nextTopic];
      const openerAsked = discussed.includes((openerQ ?? "").toLowerCase().slice(0, 25));
      if (openerQ && !openerAsked) {
        // Return a synthetic entry — wrap as a pseudo follow-up
        fresh = { keywords: [], q: openerQ, topic: nextTopic, priority: 0, rel: 0, ctxRel: 0 };
      } else {
        fresh = scored.filter(s => s.topic === nextTopic).sort((a, b) => a.priority - b.priority)[0];
      }
    }
  }

  // Same-topic angle: if not pivoting, dig deeper into current topic
  if (!fresh) {
    fresh = scored
      .filter(s => s.ctxRel > 0 && s.rel === 0 && s.topic !== "cta" && s !== related)
      .sort((a, b) => a.priority - b.priority)[0]
      ?? scored.filter(s => s.rel === 0 && s.topic !== "cta" && s !== related)
          .sort((a, b) => a.priority - b.priority)[0];
  }

  const results: string[] = [];
  if (related) results.push(related.q);
  if (fresh && fresh.q !== related?.q) results.push(fresh.q);
  if (results.length === 0) results.push("What makes you different?", "Can we schedule a call?");
  return results;
}

function getMessageText(parts: { type: string; text?: string }[]): string {
  return parts.filter((p) => p.type === "text").map((p) => p.text || "").join("");
}

const transport = new DefaultChatTransport({ api: "/api/chat" });

// ============================================================
// Known projects data for rich cards
// ============================================================
const PROJECTS: Record<string, { name: string; stack: string[]; metric: string; repo: string }> = {
  "test-platform": { name: "Secure Coding Assessment Platform", stack: ["Go", "Redis", "Docker", "gVisor", "PostgreSQL", "React"], metric: "sub-3s grading · 200 concurrent · $1-3/candidate", repo: "https://github.com/abhinavjha0239/test-platform" },
  "deepskill": { name: "DeepSkill — AI Interview Platform", stack: ["Go", "Gin", "WebSocket", "Groq", "React", "ReactFlow"], metric: "7+ domains · Real-time AI evaluation", repo: "https://github.com/abhinavjha0239/DeepSkill" },
  "attendance": { name: "Automated Attendance Platform", stack: ["Python", "FastAPI", "AdaFace", "FAISS", "Docker"], metric: "512-D embeddings · Multi-face detection", repo: "https://github.com/abhinavjha0239/Attendace_System" },
  "cp-tracker": { name: "CP Tracker — Codeforces Progress", stack: ["Node.js", "Express", "MongoDB", "React"], metric: "Circuit breaker · Daily sync · Email alerts", repo: "https://github.com/abhinavjha0239/cp-tracker" },
  "os-tracker": { name: "OS Tracker — Open Source Contributions", stack: ["Next.js", "TypeScript", "PostgreSQL", "GitHub API"], metric: "Raw SQL · Vercel Cron · Leaderboard", repo: "https://github.com/abhinavjha0239/Os_Tracker" },
  "dog-tracker": { name: "Dog Tracker — QR Lost & Found", stack: ["Next.js", "Prisma", "PostgreSQL", "Cloudinary"], metric: "QR codes · Found reports · Audit log", repo: "https://github.com/abhinavjha0239/dog-tracker" },
};

const EXPERIENCE_TIMELINE = [
  { date: "Jan 2026 – Present", title: "Backend Engineer (Independent)", subtitle: "Secure Coding Assessment Platform — pilot @ Scaler SST" },
  { date: "Feb 2025 – Jan 2026", title: "Backend Intern — Kugelblitz", subtitle: "Go services: Payments, KYC, OTP/Auth flows" },
  { date: "Dec 2024 – Dec 2025", title: "SWE Intern — Scaler Innovation Lab", subtitle: "College ERP + Face Recognition Attendance Platform" },
];

// ============================================================
// Detect rich content patterns in response text
// ============================================================
function detectProjectMentions(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  if (lower.includes("test-platform") || lower.includes("coding assessment") || lower.includes("grading engine")) found.push("test-platform");
  if (lower.includes("deepskill") || lower.includes("ai interview")) found.push("deepskill");
  if ((lower.includes("attendance") || lower.includes("face recognition")) && lower.includes("adaface")) found.push("attendance");
  if (lower.includes("cp-tracker") || lower.includes("cp tracker") || (lower.includes("codeforces") && lower.includes("tracker"))) found.push("cp-tracker");
  if (lower.includes("os_tracker") || lower.includes("os tracker") || lower.includes("contribution tracker")) found.push("os-tracker");
  if (lower.includes("dog tracker") || lower.includes("dog-tracker") || (lower.includes("qr code") && lower.includes("lost"))) found.push("dog-tracker");
  return found;
}

function detectMetrics(text: string): { label: string; value: string }[] {
  const metrics: { label: string; value: string }[] = [];
  if (text.includes("sub-3s")) metrics.push({ value: "<3s", label: "grading latency" });
  if (text.includes("200 concurrent") || text.includes("200+")) metrics.push({ value: "200+", label: "concurrent candidates" });
  if (text.includes("$1-3") || text.includes("$1–3")) metrics.push({ value: "$1-3", label: "per candidate" });
  if (text.includes("500+")) metrics.push({ value: "500+", label: "concurrent supported" });
  if (text.includes("512-d") || text.includes("512-dim")) metrics.push({ value: "512-D", label: "embeddings" });
  if (text.includes("2,000+") || text.includes("2000+")) metrics.push({ value: "2,000+", label: "validated tasks" });
  if (text.includes("Rs.1.5L") || text.includes("1.5L")) metrics.push({ value: "Rs.1.5L", label: "hackathon prize" });
  return metrics;
}

function shouldShowTimeline(text: string): boolean {
  const lower = text.toLowerCase();
  return (lower.includes("kugelblitz") && lower.includes("scaler")) ||
    (lower.includes("experience") && lower.includes("jan 2026")) ||
    (lower.includes("worked") && lower.includes("intern"));
}

// ============================================================
// Main ChatWindow (exported with error boundary)
// ============================================================
export function ChatWindow() {
  return (
    <ErrorBoundary>
      <ChatWindowInner />
    </ErrorBoundary>
  );
}

function ChatWindowInner() {
  const { messages, sendMessage, status, error, regenerate, setMessages } = useChat({ transport });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [streamStage, setStreamStage] = useState<"idle" | "searching" | "generating">("idle");

  const isStreaming = status === "streaming";
  const isBusy = status === "submitted" || status === "streaming";

  // Track streaming stage
  useEffect(() => {
    if (status === "submitted") setStreamStage("searching");
    else if (status === "streaming") setStreamStage("generating");
    else setStreamStage("idle");
  }, [status]);

  // Safety valve: auto-focus input when status returns to ready
  useEffect(() => {
    if (status === "ready" || status === "error") {
      inputRef.current?.focus();
    }
  }, [status]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isStreaming]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "44px";
    sendMessage({ text: trimmed });
  }, [isBusy, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  const handleClearChat = useCallback(() => {
    setMessages([]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "44px";
  }, [setMessages]);

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "44px";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, []);

  const allTexts = useMemo(() =>
    messages.map(m => getMessageText(m.parts as { type: string; text?: string }[])),
    [messages]
  );

  const lastAssistantText = messages.length > 0 && messages[messages.length - 1].role === "assistant"
    ? getMessageText(messages[messages.length - 1].parts as { type: string; text?: string }[])
    : "";

  return (
    <div className="flex flex-col h-full bg-white">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {/* Welcome screen — single consolidated section */}
        {messages.length === 0 && !isBusy && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-5 text-center animate-fade-in px-2">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-blue-500/20">
              AJ
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">Abhinav Kumar Jha</h2>
              <p className="text-sm text-gray-500 max-w-md">
                AI / ML Engineer — RAG-grounded over real resume, GitHub repos, and source code.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center max-w-sm">
              {["Go", "Python", "TypeScript", "Redis", "Docker", "gVisor", "PostgreSQL", "FAISS"].map(t =>
                <TechChip key={t} name={t} />
              )}
            </div>
            <div className="flex items-center gap-4 text-[11px] text-gray-400">
              <span className="flex items-center gap-1"><Database className="w-3 h-3" /> 188 chunks</span>
              <span className="flex items-center gap-1"><Sparkles className="w-3 h-3" /> RAG-grounded</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-green-400 rounded-full" /> Live</span>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-lg mt-2">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} onClick={() => handleSend(q)}
                  className="text-xs px-3 py-2 rounded-full border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-all duration-200">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        {messages.map((message, msgIdx) => {
          const text = getMessageText(message.parts as { type: string; text?: string }[]);
          const toolParts = message.parts.filter((p) => p.type === "tool-invocation");
          const isLastAssistant = message.role === "assistant" && msgIdx === messages.length - 1;

          const isCurrentlyStreaming = isLastAssistant && isStreaming;

          // Detect rich content for assistant messages (only when done streaming)
          const projectMentions = message.role === "assistant" && !isCurrentlyStreaming ? detectProjectMentions(text) : [];
          const metrics = message.role === "assistant" && !isCurrentlyStreaming ? detectMetrics(text) : [];
          const showTimeline = message.role === "assistant" && !isCurrentlyStreaming && shouldShowTimeline(text);

          return (
            <div key={message.id} className="animate-fade-in">
              <div className="max-w-2xl mx-auto">
              {/* Sender label */}
              <div className={cn("flex items-center gap-2 mb-1.5", message.role === "user" && "justify-end")}>
                {message.role !== "user" && (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-white flex items-center justify-center flex-shrink-0">
                    <Bot className="w-3 h-3" />
                  </div>
                )}
                <span className="text-xs font-medium text-gray-500">
                  {message.role === "user" ? "You" : "Abhinav's AI"}
                </span>
                {message.role === "user" && (
                  <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center flex-shrink-0">
                    <User className="w-3 h-3" />
                  </div>
                )}
              </div>

              <div className={cn("flex flex-col gap-2", message.role === "user" ? "mr-8 text-right" : "ml-8")}>
                <div className="text-sm leading-relaxed text-gray-900">
                  {text ? (
                    message.role === "assistant"
                      ? <EnhancedMarkdown content={text} streaming={isCurrentlyStreaming} />
                      : <span className="whitespace-pre-wrap">{text}</span>
                  ) : null}

                  {toolParts.map((part, idx) => {
                    const ti = (part as { type: string; toolInvocation: { toolCallId: string; toolName: string; state: string; result?: unknown; output?: unknown } }).toolInvocation;
                    const result = ti?.result || ti?.output;
                    const isDone = ti?.state === "result" || ti?.state === "output" || result != null;

                    // Rich booking card for confirmed bookings
                    if (isDone && result && ti?.toolName === "create_booking") {
                      const booking = parseBookingData(String(result));
                      if (booking) {
                        return <BookingCard key={ti?.toolCallId || idx} {...booking} />;
                      }
                    }

                    return (
                      <div key={ti?.toolCallId || idx} className="mt-2 text-sm">
                        {isDone && result ? (
                          <EnhancedMarkdown content={String(result).replace(/\[BOOKING\|[^\]]*\]/g, "").trim()} />
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {ti?.toolName === "check_availability" ? "Checking calendar..." : "Creating booking..."}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Rich components — show at most ONE type to avoid clutter */}
                {(() => {
                  if (message.role !== "assistant" || isCurrentlyStreaming) return null;

                  // Booking confirmation → rich card with countdown
                  const booking = detectBookingFromText(text);
                  if (booking) {
                    return (
                      <BookingCard
                        startTime={booking.startDate?.toISOString() ?? ""}
                        name=""
                        email={booking.email}
                        meetingUrl={booking.meetingUrl}
                        dateLabel={booking.dateStr}
                      />
                    );
                  }

                  // Available slots → clickable time chips
                  const slotTimes = detectSlotTimes(text);
                  if (slotTimes.length > 0) {
                    return (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {slotTimes.map((t) => (
                          <button key={t} onClick={() => handleSend(t)}
                            className="text-xs px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300 font-medium transition-all duration-150 cursor-pointer">
                            {t}
                          </button>
                        ))}
                      </div>
                    );
                  }

                  // Priority: metrics > project cards > timeline
                  const isOverview = text.length > 1200 || projectMentions.length > 2;
                  if (!isOverview && metrics.length >= 2 && metrics.length <= 4) {
                    return <MetricsBar metrics={metrics} />;
                  }
                  if (!isOverview && projectMentions.length === 1 && PROJECTS[projectMentions[0]]) {
                    return <ProjectCard {...PROJECTS[projectMentions[0]]} />;
                  }
                  if (showTimeline) {
                    return <Timeline items={EXPERIENCE_TIMELINE} />;
                  }
                  return null;
                })()}
              </div>
              </div>{/* close mx-auto */}
            </div>
          );
        })}

        {/* 9. Streaming indicator with stages */}
        {isBusy && (messages.length === 0 || messages[messages.length - 1]?.role === "user") && (
          <div className="animate-fade-in">
            <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-white flex items-center justify-center">
                <Bot className="w-3 h-3" />
              </div>
              <span className="text-xs font-medium text-gray-500">Abhinav&apos;s AI</span>
            </div>
            <div className="ml-8">
              <div className="flex items-center gap-2 text-xs py-2">
                {streamStage === "searching" ? (
                  <>
                    <Search className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
                    <span className="text-blue-600 font-medium">Searching 188 knowledge chunks...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-purple-500 animate-pulse" />
                    <span className="text-purple-600 font-medium">Generating response...</span>
                  </>
                )}
              </div>
            </div>
            </div>{/* close mx-auto */}
          </div>
        )}

        {/* Follow-up suggestions */}
        {messages.length > 0 && !isBusy && messages[messages.length - 1]?.role === "assistant" && (
          <div className="max-w-2xl mx-auto">
          <div className="flex flex-wrap gap-2 pl-8 animate-fade-in">
            {getFollowUps(lastAssistantText, allTexts, messages.length).map((q) => (
              <button key={q} onClick={() => handleSend(q)}
                className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-all duration-200">
                {q}
              </button>
            ))}
          </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 rounded-lg px-4 py-3 max-w-2xl mx-auto">
            <span>Something went wrong.</span>
            <button onClick={() => regenerate()} className="flex items-center gap-1 text-red-600 hover:text-red-700 font-medium">
              <RotateCcw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-gray-100 bg-white px-4 py-3">
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="flex items-end gap-2 max-w-2xl mx-auto">
          {messages.length > 0 && (
            <button type="button" onClick={handleClearChat} title="New conversation"
              className="flex items-center justify-center w-10 h-10 rounded-xl text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <textarea ref={inputRef} value={input}
            onChange={handleTextareaChange} onKeyDown={handleKeyDown}
            placeholder="Ask me anything..." rows={1}
            className={cn("flex-1 resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              "placeholder:text-gray-400 max-h-32")}
            style={{ minHeight: "44px" }} disabled={isBusy} />
          <button type="submit" disabled={isBusy || !input.trim()}
            className={cn("flex items-center justify-center w-10 h-10 rounded-xl transition-colors flex-shrink-0",
              input.trim() && !isBusy ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-gray-100 text-gray-400")}>
            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Booking confirmation card with countdown
// ============================================================
function parseBookingData(result: string): { startTime: string; name: string; email: string; meetingUrl: string | null } | null {
  const match = result.match(/\[BOOKING\|([^|]+)\|([^|]+)\|([^|]+)\|([^\]]*)\]/);
  if (!match) return null;
  return { startTime: match[1], name: match[2], email: match[3], meetingUrl: match[4] || null };
}

function formatCountdown(startTime: string): string {
  const diff = new Date(startTime).getTime() - Date.now();
  if (diff <= 0) return "Starting now";
  const days = Math.floor(diff / (86400000));
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length ? `${parts.join(" ")} from now` : "Less than a minute";
}

function BookingCard({ startTime, name, email, meetingUrl, dateLabel }: { startTime: string; name: string; email: string; meetingUrl: string | null; dateLabel?: string }) {
  const hasValidTime = startTime && !isNaN(new Date(startTime).getTime());
  const date = hasValidTime ? new Date(startTime) : null;
  const fmtDate = date ? date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }) : "";
  const fmtTime = date ? date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }) : "";
  const countdown = hasValidTime ? formatCountdown(startTime) : null;

  return (
    <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl border border-green-200 p-5 my-3 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
          <CheckCircle2 className="w-5 h-5 text-white" />
        </div>
        <div>
          <p className="font-bold text-green-900 text-base">Interview Confirmed</p>
          {countdown && (
            <div className="flex items-center gap-1 text-xs text-green-600 font-medium">
              <Clock className="w-3 h-3" />
              <span>{countdown}</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2.5 text-sm">
        <div className="flex items-center gap-2.5 text-gray-800">
          <Calendar className="w-4 h-4 text-green-600 flex-shrink-0" />
          <span className="font-medium">{date ? `${fmtDate} at ${fmtTime} IST` : dateLabel || "Scheduled"}</span>
        </div>
        {name && (
          <div className="flex items-center gap-2.5 text-gray-700">
            <User className="w-4 h-4 text-green-600 flex-shrink-0" />
            <span>{name}</span>
          </div>
        )}
        <div className="flex items-center gap-2.5 text-gray-700">
          <Mail className="w-4 h-4 text-green-600 flex-shrink-0" />
          <span>{email}</span>
        </div>
        {meetingUrl && (
          <a href={meetingUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2.5 text-blue-600 hover:text-blue-800 font-medium transition-colors">
            <Video className="w-4 h-4 flex-shrink-0" />
            <span>Join Meeting Link</span>
          </a>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-green-200 text-xs text-green-600">
        Calendar invite sent — check your inbox
      </div>
    </div>
  );
}

// ============================================================
// Enhanced Markdown with code blocks + rich text
// ============================================================
function EnhancedMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  if (!content) return null;
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <div className={cn("space-y-1", streaming && "streaming-cursor")}>
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const inner = part.slice(3, -3);
          const nl = inner.indexOf("\n");
          const lang = nl > 0 ? inner.slice(0, nl).trim() : "";
          const code = nl > 0 ? inner.slice(nl + 1) : inner;
          return <CodeBlock key={i} code={code} language={lang} />;
        }
        return <TextBlock key={i} text={part} />;
      })}
    </div>
  );
}

// --- Skill line detector: "Languages: Go, Python, ..." ---
function isSkillLine(line: string): { label: string; items: string[] } | null {
  const match = line.replace(/\*\*/g, "").match(/^(?:Languages|Skills|Databases|Infra|Backend|Frontend|Systems|ML\/AI|Tools|Cache):\s*(.+)/i);
  if (match) {
    return { label: match[0].split(":")[0], items: match[1].split(/[,·•|]+/).map(t => t.trim()).filter(Boolean) };
  }
  return null;
}

// --- Date range detector for inline timeline ---
function isDateRole(line: string): { date: string; role: string } | null {
  const match = line.match(/^(?:\*\*)?([A-Z][a-z]{2}\s+\d{4}\s*[–-]\s*(?:[A-Z][a-z]{2}\s+\d{4}|Present))(?:\*\*)?\s*[–—:-]\s*(.+)/);
  if (match) return { date: match[1], role: match[2].replace(/\*\*/g, "") };
  return null;
}

function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  // Track if we're inside a bullet group to add spacing between groups
  let lastWasBullet = false;
  let lastWasHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- Skill/tech lines: "Languages: Go, Python, ..." → chip grid ---
    const skillInfo = isSkillLine(line);
    if (skillInfo) {
      elements.push(
        <div key={i} className="my-2">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{skillInfo.label}</span>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {skillInfo.items.map((t, j) => <TechChip key={j} name={t} />)}
          </div>
        </div>
      );
      lastWasBullet = false; lastWasHeading = false;
      continue;
    }

    // --- Date + Role lines: "Jan 2026 – Present — Backend Engineer" → timeline item ---
    const dateRole = isDateRole(line);
    if (dateRole) {
      elements.push(
        <div key={i} className="my-2 flex items-start gap-3 pl-2 border-l-2 border-blue-300">
          <div>
            <span className="text-xs font-medium text-blue-600">{dateRole.date}</span>
            <p className="text-sm font-semibold text-gray-900 -mt-0.5">{processInline(dateRole.role)}</p>
          </div>
        </div>
      );
      lastWasBullet = false; lastWasHeading = false;
      continue;
    }

    // --- Achievement line: contains "Winner", "1st Prize", "Rs." ---
    if (/(?:Winner|1st Prize|Won first|Rs\.\s*\d|hackathon.*prize)/i.test(line) && line.length > 30) {
      elements.push(
        <div key={i} className="my-3 bg-gradient-to-r from-amber-50 to-yellow-50/30 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-lg mt-0.5 flex-shrink-0">🏆</span>
          <div className="text-sm text-gray-800">{processInline(line)}</div>
        </div>
      );
      lastWasBullet = false; lastWasHeading = false;
      continue;
    }

    // --- Headings ---
    if (line.match(/^#### /)) {
      elements.push(<h5 key={i} className="font-medium text-gray-700 mt-3 mb-1 text-xs uppercase tracking-wide">{processInline(line.replace(/^#### /, ""))}</h5>);
      lastWasBullet = false; lastWasHeading = true;
      continue;
    }
    if (line.match(/^### /)) {
      elements.push(
        <div key={i} className="mt-4 mb-1.5 bg-gradient-to-r from-blue-50/60 to-transparent rounded-lg px-3 py-2 border-l-4 border-blue-400">
          <h4 className="font-semibold text-gray-900 text-[15px]">{processInline(line.replace(/^### /, ""))}</h4>
        </div>
      );
      lastWasBullet = false; lastWasHeading = true;
      continue;
    }
    if (line.match(/^## /)) {
      elements.push(<h3 key={i} className="font-bold text-gray-900 mt-4 mb-2 text-base">{processInline(line.replace(/^## /, ""))}</h3>);
      lastWasBullet = false; lastWasHeading = true;
      continue;
    }

    // --- "Stack:" or "Tech:" lines → render as colored tech chips ---
    const stackMatch = line.replace(/\*\*/g, "").match(/^(?:Stack|Tech|Technologies):\s*(.+)/i);
    if (stackMatch) {
      const techs = stackMatch[1].split(/[,·•|]+/).map(t => t.trim()).filter(Boolean);
      elements.push(
        <div key={i} className="flex flex-wrap gap-1.5 mt-1.5 mb-3">
          {techs.map((t, j) => <TechChip key={j} name={t} />)}
        </div>
      );
      lastWasBullet = false; lastWasHeading = false;
      continue;
    }

    // --- Horizontal rule ---
    if (line.match(/^-{3,}$/) || line.match(/^\*{3,}$/)) {
      elements.push(<div key={i} className="my-3 border-t border-gray-100" />);
      lastWasBullet = false; lastWasHeading = false;
      continue;
    }

    // --- Bullets ---
    const bulletMatch = line.match(/^(\s*)([-*•])\s+(.*)/);
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2);
      const content = bulletMatch[3];

      // Add spacing before a new top-level bullet group if previous was also a bullet (paragraph break)
      if (indent === 0 && !lastWasBullet && !lastWasHeading && elements.length > 0) {
        elements.push(<div key={`sp-${i}`} className="h-1" />);
      }

      // Check if bullet content is a bold title followed by description (e.g., "**Project Name** — description")
      const titleMatch = content.match(/^\*\*(.+?)\*\*\s*[—–-]\s*(.*)/);
      if (titleMatch && indent === 0) {
        // Render as a mini section header
        elements.push(
          <div key={i} className="mt-3 mb-0.5 ml-1">
            <div className="font-semibold text-gray-900 text-[13px]">{titleMatch[1]}</div>
            {titleMatch[2] && <div className="text-gray-600 text-[13px] mt-0.5">{processInline(titleMatch[2])}</div>}
          </div>
        );
      } else {
        const ml = indent === 0 ? "ml-1" : indent === 1 ? "ml-5" : "ml-9";
        elements.push(
          <div key={i} className={`flex gap-1.5 ${ml} py-0.5`}>
            <span className={`mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0 ${indent === 0 ? "bg-blue-400" : "bg-gray-300"}`} />
            <span className="text-gray-700">{processInline(content)}</span>
          </div>
        );
      }
      lastWasBullet = true; lastWasHeading = false;
      continue;
    }

    // --- Numbered list ---
    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (numMatch) {
      const indent = Math.floor(numMatch[1].length / 2);
      const ml = indent === 0 ? "ml-1" : "ml-5";
      elements.push(
        <div key={i} className={`flex gap-2 ${ml} py-0.5`}>
          <span className="text-blue-500 font-semibold text-xs mt-0.5 min-w-[18px] flex-shrink-0">{numMatch[2]}.</span>
          <span className="text-gray-700">{processInline(numMatch[3])}</span>
        </div>
      );
      lastWasBullet = true; lastWasHeading = false;
      continue;
    }

    // --- Empty line = paragraph break ---
    if (!line.trim()) {
      elements.push(<div key={i} className="h-3" />);
      lastWasBullet = false; lastWasHeading = false;
      continue;
    }

    // --- Regular paragraph ---
    elements.push(<p key={i} className="text-gray-800 leading-relaxed">{processInline(line)}</p>);
    lastWasBullet = false; lastWasHeading = false;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

function processInline(text: string): React.ReactNode {
  // Split on bold, inline code, markdown links, and bare URLs
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s,)]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[11px] font-mono border border-blue-100">
          {part.slice(1, -1)}
        </code>
      );
    }
    // Markdown links [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={i} href={linkMatch[2]} target="_blank" rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-700 underline underline-offset-2">
          {linkMatch[1]}
        </a>
      );
    }
    // Bare URLs → clickable links
    if (/^https?:\/\//.test(part)) {
      const clean = part.replace(/[.,;!?)]+$/, "");
      return (
        <a key={i} href={clean} target="_blank" rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-700 underline underline-offset-2 break-all">
          {clean}
        </a>
      );
    }
    return part;
  });
}

// ============================================================
// Detect booking confirmation from assistant text
// ============================================================
function detectBookingFromText(text: string): { dateStr: string; email: string; meetingUrl: string | null; startDate: Date | null } | null {
  if (!/\b(confirmed|booked)\b/i.test(text)) return null;
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
  // Must have email AND either a cal.com link or mention of "confirmation" to be a real booking
  if (!emailMatch) return null;

  const urlMatch = text.match(/https?:\/\/\S*cal\.com\S*/);
  const meetingUrl = urlMatch ? urlMatch[0].replace(/[.,;!?)]+$/, "") : null;

  // Parse "Friday, 17 April at 2:15 PM IST" or similar
  const dateMatch = text.match(/([A-Z][a-z]+day),?\s+(\d{1,2})\s+([A-Z][a-z]+)\s+at\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+IST/i);
  let startDate: Date | null = null;
  let dateStr = "";
  if (dateMatch) {
    dateStr = dateMatch[0];
    let h = parseInt(dateMatch[4]);
    if (dateMatch[6].toUpperCase() === "PM" && h !== 12) h += 12;
    if (dateMatch[6].toUpperCase() === "AM" && h === 12) h = 0;
    const year = new Date().getFullYear();
    const d = new Date(`${dateMatch[3]} ${dateMatch[2]}, ${year} ${String(h).padStart(2, "0")}:${dateMatch[5]}:00`);
    if (!isNaN(d.getTime())) startDate = d;
  }

  return { dateStr, email: emailMatch[0], meetingUrl, startDate };
}

// ============================================================
// Detect available slot times from assistant text
// ============================================================
function detectSlotTimes(text: string): string[] {
  // Don't show slot chips on booking confirmations
  if (/\b(confirmed|booked)\b/i.test(text)) return [];
  if (!/\b(available|open|slot|nearby|opening)/i.test(text)) return [];
  const times = text.match(/\d{1,2}:\d{2}\s+(?:AM|PM)/gi);
  if (!times) return [];
  // Deduplicate and sort chronologically
  const unique = [...new Set(times.map(t => t.toUpperCase()))];
  unique.sort((a, b) => {
    const parse = (s: string) => {
      const [time, period] = s.split(/\s+/);
      let [h, m] = time.split(":").map(Number);
      if (period === "PM" && h !== 12) h += 12;
      if (period === "AM" && h === 12) h = 0;
      return h * 60 + m;
    };
    return parse(a) - parse(b);
  });
  return unique;
}
