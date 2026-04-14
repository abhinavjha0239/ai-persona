import { VoiceButton } from "@/components/voice/VoiceButton";
import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { Phone, MessageSquare, Code2, FileText } from "lucide-react";

// ============================================================
// Landing Page — AI Persona Hub
// ============================================================

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-gray-50 to-white px-4">
      {/* Hero */}
      <section className="text-center max-w-2xl mx-auto pt-16 pb-12">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 mx-auto mb-6 flex items-center justify-center text-white text-2xl font-bold">
          AJ
        </div>
        <h1 className="text-4xl font-bold text-gray-900 mb-3">
          Abhinav Jha
        </h1>
        <p className="text-lg text-gray-600 mb-1">Backend / Systems Engineer</p>
        <p className="text-sm text-gray-400 mb-4">
          Talk to my AI representative — voice or chat
        </p>
        <div className="flex flex-wrap gap-2 justify-center text-xs">
          <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded-full">Go</span>
          <span className="px-2 py-1 bg-green-50 text-green-600 rounded-full">Python</span>
          <span className="px-2 py-1 bg-yellow-50 text-yellow-700 rounded-full">TypeScript</span>
          <span className="px-2 py-1 bg-purple-50 text-purple-600 rounded-full">Redis Streams</span>
          <span className="px-2 py-1 bg-red-50 text-red-600 rounded-full">Docker/gVisor</span>
          <span className="px-2 py-1 bg-gray-100 text-gray-600 rounded-full">BITS Pilani + Scaler SST</span>
        </div>
      </section>

      {/* Voice Call Section */}
      <section className="w-full max-w-md mx-auto mb-12">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          <div className="flex items-center gap-2 mb-6 justify-center">
            <Phone className="w-5 h-5 text-green-500" />
            <h2 className="text-lg font-semibold text-gray-800">
              Voice Call
            </h2>
          </div>
          <p className="text-sm text-gray-500 text-center mb-6">
            Click to start a voice conversation. Ask about my background,
            skills, or schedule an interview — in Hindi or English.
          </p>
          <VoiceButton />
        </div>
      </section>

      {/* Navigation Cards */}
      <section className="w-full max-w-2xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4 mb-16">
        <NavCard
          href="/chat"
          icon={<MessageSquare className="w-5 h-5" />}
          title="Chat"
          description="Text-based conversation with RAG-grounded answers"
        />
        <NavCard
          href="https://github.com/abhinavjha0239"
          icon={<Code2 className="w-5 h-5" />}
          title="GitHub"
          description="View the source code and architecture"
          external
        />
        <NavCard
          href="/docs/eval-report.pdf"
          icon={<FileText className="w-5 h-5" />}
          title="Eval Report"
          description="Voice quality, chat groundedness, failure modes"
        />
      </section>

      {/* Architecture Diagram */}
      <section className="w-full max-w-3xl mx-auto mb-16 px-4">
        <ArchitectureDiagram />
      </section>

      {/* Footer */}
      <footer className="text-center text-xs text-gray-400 pb-8">
        Built with Next.js, Vapi, Azure OpenAI (GPT-4.1), and pgvector | 188 knowledge chunks
      </footer>
    </main>
  );
}

function NavCard({
  href,
  icon,
  title,
  description,
  external,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="group flex flex-col items-center text-center p-6 rounded-xl border border-gray-100 bg-white hover:border-blue-200 hover:shadow-md transition-all"
    >
      <div className="w-10 h-10 rounded-lg bg-gray-50 group-hover:bg-blue-50 flex items-center justify-center text-gray-500 group-hover:text-blue-600 mb-3 transition-colors">
        {icon}
      </div>
      <h3 className="font-medium text-gray-900 mb-1">{title}</h3>
      <p className="text-xs text-gray-500">{description}</p>
    </a>
  );
}
