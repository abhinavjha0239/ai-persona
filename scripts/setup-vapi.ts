#!/usr/bin/env npx tsx
/**
 * ============================================================
 * Vapi Assistant Setup Script
 * ============================================================
 * Run: npx tsx scripts/setup-vapi.ts
 *
 * Creates or updates the Vapi assistant with your persona
 * configuration, tools, and knowledge base.
 * ============================================================
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const PERSONA_NAME = process.env.PERSONA_NAME || "Abhinav Jha";
const PERSONA_ROLE = process.env.PERSONA_ROLE || "AI/ML Engineer";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";

if (!VAPI_API_KEY) {
  console.error("Error: VAPI_API_KEY is required in .env.local");
  process.exit(1);
}

const systemPrompt = `You are the AI representative of ${PERSONA_NAME}, a ${PERSONA_ROLE}. You are speaking on a phone call on behalf of ${PERSONA_NAME}.

## CORE IDENTITY
- You ARE ${PERSONA_NAME}'s AI persona. Speak in first person.
- Say "I" when referring to ${PERSONA_NAME}'s experiences and skills.

## LANGUAGE
- Fluent in Hindi and English. Match the caller's language.
- Handle Hinglish (code-switching) naturally.
- Keep responses concise: 2-3 sentences per turn for voice.

## CONVERSATION STYLE
- Warm, confident, professional. Like a real phone screen.
- Never fabricate facts. Only share what's in your knowledge base.
- If unsure, pivot to something you DO know.

## CALENDAR BOOKING
When scheduling:
1. Ask what dates work
2. Use check_availability to get slots
3. Offer 3-4 specific times
4. Get name + email
5. Use create_booking to confirm
6. Read back the confirmation

## RULES
- Keep voice responses SHORT
- Don't say "As an AI" — you are ${PERSONA_NAME}'s representative
- Handle interruptions gracefully
- Thank the caller at the end`;

const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check available meeting slots. Call when user wants to schedule.",
      parameters: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "Start date ISO 8601. Default tomorrow.",
          },
          endDate: {
            type: "string",
            description: "End date ISO 8601. Default 5 days from start.",
          },
        },
        required: ["startDate", "endDate"],
      },
    },
    server: { url: `${APP_URL}/api/voice/webhook` },
  },
  {
    type: "function",
    function: {
      name: "create_booking",
      description: "Book a meeting. Only after confirming time, name, and email.",
      parameters: {
        type: "object",
        properties: {
          startTime: { type: "string", description: "Selected slot ISO 8601" },
          attendeeName: { type: "string", description: "Full name" },
          attendeeEmail: { type: "string", description: "Email for invite" },
          attendeeTimezone: { type: "string", description: "Timezone, default Asia/Kolkata" },
          notes: { type: "string", description: "Optional meeting notes" },
        },
        required: ["startTime", "attendeeName", "attendeeEmail"],
      },
    },
    server: { url: `${APP_URL}/api/voice/webhook` },
  },
];

const assistantPayload = {
  name: `${PERSONA_NAME} AI Persona`,
  model: {
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: systemPrompt }],
    tools,
    temperature: 0.7,
    maxTokens: 500,
  },
  voice: {
    provider: "11labs",
    voiceId: ELEVENLABS_VOICE_ID,
    stability: 0.5,
    similarityBoost: 0.75,
    model: "eleven_turbo_v2_5",
  },
  transcriber: {
    provider: "deepgram",
    model: "nova-2",
    language: "multi",
    smartFormat: true,
  },
  firstMessage: `Hi! Namaste! I'm ${PERSONA_NAME}'s AI representative. You can ask me about my background, skills, and projects, or we can schedule a meeting. How can I help you today?`,
  silenceTimeoutSeconds: 30,
  maxDurationSeconds: 600,
  backgroundSound: "off",
  backchannelingEnabled: true,
  endCallMessage: "Thank you for calling. Goodbye!",
  endCallPhrases: ["goodbye", "bye", "end call", "alvida"],
  clientMessages: [
    "transcript",
    "hang",
    "function-call",
    "speech-update",
    "status-update",
    "end-of-call-report",
  ],
  serverMessages: [
    "end-of-call-report",
    "status-update",
    "function-call",
    "tool-calls",
  ],
};

async function main() {
  console.log("🎙️  Setting up Vapi Assistant...\n");

  const method = VAPI_ASSISTANT_ID ? "PATCH" : "POST";
  const url = VAPI_ASSISTANT_ID
    ? `https://api.vapi.ai/assistant/${VAPI_ASSISTANT_ID}`
    : "https://api.vapi.ai/assistant";

  console.log(`${method === "PATCH" ? "Updating" : "Creating"} assistant...`);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(assistantPayload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Vapi API error (${res.status}):`, body);
    process.exit(1);
  }

  const data = await res.json();

  console.log("\n✅ Assistant ready!");
  console.log(`   ID: ${data.id}`);
  console.log(`   Name: ${data.name}`);
  console.log(`\n📋 Add this to your .env.local:`);
  console.log(`   VAPI_ASSISTANT_ID=${data.id}`);
  console.log(`   NEXT_PUBLIC_VAPI_ASSISTANT_ID=${data.id}`);

  if (data.phoneNumber) {
    console.log(`\n📞 Phone: ${data.phoneNumber}`);
  }

  console.log("\n🔗 Webhook URL:", `${APP_URL}/api/voice/webhook`);
  console.log("   Make sure this URL is publicly accessible (use ngrok for local dev)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
