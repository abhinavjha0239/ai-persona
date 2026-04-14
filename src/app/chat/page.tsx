import { ChatWindow } from "@/components/chat/ChatWindow";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

// ============================================================
// Chat Page — /chat
// ============================================================
// Full-screen chat interface with the AI persona.
// RAG-grounded over resume, GitHub repos, and projects.
// Supports booking via tool calling.
// ============================================================

export const metadata = {
  title: "Chat | AI Persona — Abhinav Jha",
  description: "Chat with Abhinav Jha's AI persona. RAG-grounded over real resume and GitHub.",
};

export default function ChatPage() {
  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white">
        <Link
          href="/"
          className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
            AJ
          </div>
          <div>
            <h1 className="text-sm font-semibold text-gray-900">
              Abhinav Jha — AI Persona
            </h1>
            <p className="text-xs text-gray-500">
              RAG-grounded chat · Ask anything
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-xs text-gray-500">Online</span>
        </div>
      </header>

      {/* Chat */}
      <main className="flex-1 overflow-hidden">
        <ChatWindow />
      </main>
    </div>
  );
}
