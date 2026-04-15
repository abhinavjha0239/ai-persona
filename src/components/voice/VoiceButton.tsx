"use client";

import { useVoice, type CallStatus } from "@/hooks/useVoice";
import { cn } from "@/lib/utils/cn";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";

// ============================================================
// VoiceButton — The call-to-action for voice interaction
// ============================================================
// Renders a pulsing call button that triggers browser-based
// voice calling via Vapi Web SDK. Shows live transcript
// during calls.
// ============================================================

export function VoiceButton() {
  const {
    status,
    isMuted,
    volumeLevel,
    transcript,
    error,
    startCall,
    endCall,
    toggleMute,
  } = useVoice();

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Main call button */}
      <button
        onClick={status === "idle" || status === "error" ? startCall : endCall}
        className={cn(
          "relative flex items-center justify-center rounded-full transition-all duration-300",
          "w-20 h-20 text-white shadow-lg",
          status === "idle" && "bg-green-500 hover:bg-green-600 hover:scale-105",
          status === "connecting" && "bg-yellow-500 animate-pulse",
          status === "active" && "bg-red-500 hover:bg-red-600",
          status === "ending" && "bg-gray-400",
          status === "error" && "bg-red-700 hover:bg-red-600"
        )}
        disabled={status === "ending" || status === "connecting"}
        aria-label={status === "active" ? "End call" : "Start call"}
      >
        {/* Pulse ring for active calls */}
        {status === "active" && (
          <span
            className="absolute inset-0 rounded-full bg-red-400 animate-ping opacity-25"
            style={{
              transform: `scale(${1 + volumeLevel * 0.5})`,
            }}
          />
        )}

        {status === "active" || status === "ending" ? (
          <PhoneOff className="w-8 h-8 relative z-10" />
        ) : (
          <Phone className="w-8 h-8 relative z-10" />
        )}
      </button>

      {/* Status text */}
      <StatusLabel status={status} />

      {/* Mute button (visible during call) */}
      {status === "active" && (
        <button
          onClick={toggleMute}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-colors",
            isMuted
              ? "bg-red-100 text-red-700 hover:bg-red-200"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          )}
        >
          {isMuted ? (
            <>
              <MicOff className="w-4 h-4" /> Unmute
            </>
          ) : (
            <>
              <Mic className="w-4 h-4" /> Mute
            </>
          )}
        </button>
      )}

      {/* Error message with guidance */}
      {error && (
        <div className="text-center max-w-xs">
          <p className="text-sm text-red-500">{error}</p>
          {error.toLowerCase().includes("microphone") || error.toLowerCase().includes("permission") || error.toLowerCase().includes("notallowed") ? (
            <p className="text-xs text-gray-500 mt-1">
              Please allow microphone access in your browser settings and try again.
            </p>
          ) : error.toLowerCase().includes("network") || error.toLowerCase().includes("connect") ? (
            <p className="text-xs text-gray-500 mt-1">
              Check your internet connection and try again.
            </p>
          ) : null}
        </div>
      )}

      {/* Live transcript */}
      {transcript.length > 0 && (
        <div className="w-full max-w-md mt-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Live Transcript
          </h3>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {transcript.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "text-sm px-3 py-2 rounded-lg",
                  msg.role === "user"
                    ? "bg-blue-50 text-blue-900 ml-8"
                    : "bg-gray-50 text-gray-900 mr-8"
                )}
              >
                <span className="font-medium text-xs text-gray-400 block mb-0.5">
                  {msg.role === "user" ? "You" : "AI Persona"}
                </span>
                {msg.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusLabel({ status }: { status: CallStatus }) {
  const labels: Record<CallStatus, string> = {
    idle: "Tap to call",
    connecting: "Connecting...",
    active: "Call in progress",
    ending: "Ending call...",
    error: "Tap to retry",
  };

  return (
    <p
      className={cn(
        "text-sm font-medium",
        status === "active" && "text-green-600",
        status === "connecting" && "text-yellow-600",
        status === "error" && "text-red-600",
        (status === "idle" || status === "ending") && "text-gray-500"
      )}
    >
      {labels[status]}
    </p>
  );
}
