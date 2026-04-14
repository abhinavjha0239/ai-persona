"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// useVoice Hook — Client-side voice call management
// ============================================================
// Wraps the Vapi Web SDK with React state management.
// Handles call lifecycle, transcript, and status updates.
// ============================================================

export type CallStatus =
  | "idle"
  | "connecting"
  | "active"
  | "ending"
  | "error";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface UseVoiceReturn {
  status: CallStatus;
  isMuted: boolean;
  volumeLevel: number;
  transcript: TranscriptMessage[];
  error: string | null;
  startCall: () => Promise<void>;
  endCall: () => void;
  toggleMute: () => void;
}

export function useVoice(): UseVoiceReturn {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vapiRef = useRef<any>(null);

  // Dynamically import Vapi Web SDK (client-side only)
  const getVapi = useCallback(async () => {
    if (vapiRef.current) return vapiRef.current;

    const { default: Vapi } = await import("@vapi-ai/web");
    const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;

    if (!publicKey) {
      throw new Error("NEXT_PUBLIC_VAPI_PUBLIC_KEY is not set");
    }

    const vapi = new Vapi(publicKey);

    // Wire up event listeners
    vapi.on("call-start", () => {
      setStatus("active");
      setError(null);
    });

    vapi.on("call-end", () => {
      setStatus("idle");
      setVolumeLevel(0);
    });

    vapi.on("speech-start", () => {
      // Assistant started speaking
    });

    vapi.on("speech-end", () => {
      // Assistant stopped speaking
    });

    vapi.on("volume-level", (level: number) => {
      setVolumeLevel(level);
    });

    vapi.on("message", (message: Record<string, unknown>) => {
      if (message.type === "transcript") {
        const msg = message as {
          type: string;
          role: string;
          transcript: string;
          transcriptType: string;
        };

        // Only add final transcripts, not partials
        if (msg.transcriptType === "final") {
          setTranscript((prev) => {
            const next = [
              ...prev,
              {
                role: msg.role as "user" | "assistant",
                text: msg.transcript,
                timestamp: Date.now(),
              },
            ];
            // Keep last 100 messages to prevent unbounded memory growth
            return next.length > 100 ? next.slice(-100) : next;
          });
        }
      }
    });

    vapi.on("error", (err: Error) => {
      console.error("[Voice] Vapi error:", err);
      setError(err.message || "An error occurred during the call");
      setStatus("error");
    });

    vapiRef.current = vapi;
    return vapi;
  }, []);

  // Start a voice call
  const startCall = useCallback(async () => {
    try {
      setStatus("connecting");
      setError(null);
      setTranscript([]);

      const vapi = await getVapi();

      const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
      if (!assistantId) {
        // Fetch from our API
        const res = await fetch("/api/voice/token");
        const data = await res.json();

        if (data.assistantId) {
          await vapi.start(data.assistantId);
        } else {
          throw new Error("No assistant ID configured");
        }
      } else {
        await vapi.start(assistantId);
      }
    } catch (err) {
      console.error("[Voice] Start call error:", err);
      setError(err instanceof Error ? err.message : "Failed to start call");
      setStatus("error");
    }
  }, [getVapi]);

  // End the current call
  const endCall = useCallback(async () => {
    if (!vapiRef.current) return;
    setStatus("ending");
    try {
      await vapiRef.current.stop();
    } catch (err) {
      console.error("[Voice] End call error:", err);
    }
    // Status will be set to "idle" by the "call-end" event listener.
    // Fallback in case the event doesn't fire within 3 seconds.
    setTimeout(() => {
      setStatus((prev) => (prev === "ending" ? "idle" : prev));
    }, 3000);
  }, []);

  // Toggle microphone mute
  const toggleMute = useCallback(() => {
    const vapi = vapiRef.current;
    if (!vapi) return;

    const newMuted = !isMuted;
    vapi.setMuted(newMuted);
    setIsMuted(newMuted);
  }, [isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      vapiRef.current?.stop();
    };
  }, []);

  return {
    status,
    isMuted,
    volumeLevel,
    transcript,
    error,
    startCall,
    endCall,
    toggleMute,
  };
}
