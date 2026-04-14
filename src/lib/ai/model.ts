import { env } from "@/lib/config/env";

// ============================================================
// Chat Model Factory
// ============================================================
// Returns the AI SDK model object for the configured LLM provider.
// Used by the chat API route with streamText() + tool calling.
//
// This is separate from the LLMProvider interface because AI SDK's
// streamText needs a model object, not a ReadableStream wrapper.
// ============================================================

/**
 * Get the AI SDK model for chat streaming based on LLM_PROVIDER env.
 * Supports tool calling, structured output, and UIMessageStream.
 */
export async function getChatModel() {
  const provider = env.LLM_PROVIDER;

  switch (provider) {
    case "azure-openai": {
      const { createAzure } = await import("@ai-sdk/azure");
      const azure = createAzure({
        resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
      });
      return azure(process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "gpt-4.1-mini");
    }
    case "openai": {
      const { openai } = await import("@ai-sdk/openai");
      return openai("gpt-4o-mini");
    }
    case "google": {
      const { google } = await import("@ai-sdk/google");
      return google("gemini-2.5-flash");
    }
    case "anthropic": {
      const { anthropic } = await import("@ai-sdk/anthropic");
      return anthropic("claude-sonnet-4-5-20250929");
    }
    case "groq": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const groq = createOpenAI({
        baseURL: "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY,
      });
      return groq("llama-3.3-70b-versatile");
    }
    case "bedrock": {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const bedrock = createAmazonBedrock({
        region: process.env.AWS_REGION || "ap-south-1",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      });
      return bedrock(process.env.BEDROCK_MODEL_ID || "anthropic.claude-haiku-4-5-20251001-v1:0");
    }
    default:
      throw new Error(`Unsupported LLM_PROVIDER for chat: "${provider}"`);
  }
}
