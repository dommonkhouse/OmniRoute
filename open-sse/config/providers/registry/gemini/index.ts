import type { RegistryEntry } from "../../shared.ts";
import { buildGeminiGenerateContentUrl, resolvePublicCred } from "../../shared.ts";

export const geminiProvider: RegistryEntry = {
  id: "gemini",
  alias: "gemini",
  format: "gemini",
  executor: "default",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  urlBuilder: buildGeminiGenerateContentUrl,
  authType: "apikey",
  authHeader: "x-goog-api-key",
  defaultContextLength: 1048576,
  oauth: {
    clientIdEnv: "GEMINI_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("gemini_id"),
    clientSecretEnv: "GEMINI_OAUTH_CLIENT_SECRET",
    clientSecretDefault: resolvePublicCred("gemini_alt"),
  },
  models: [
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      toolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      // Gemini 3.x steers thinking via thinkingConfig.thinkingLevel (low|medium|high).
      // Declaring the tiers admits `<base>-{effort}` variants through the live-catalog
      // gate; the suffix is pinned before translation so the wire body carries the tier.
      supportedThinkingEfforts: ["low", "medium", "high"],
    },
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      toolCalling: true,
      supportsVision: true,
    },
    {
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      toolCalling: true,
      supportsVision: true,
    },
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      toolCalling: true,
      supportsVision: true,
    },
    {
      id: "gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      toolCalling: true,
      supportsVision: true,
    },
    {
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
      toolCalling: true,
      supportsVision: true,
    },
    { id: "gemini-3.1-flash-tts-preview", name: "Gemini 3.1 Flash TTS" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", toolCalling: true, supportsVision: true },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      toolCalling: true,
      supportsVision: true,
    },
    {
      id: "gemini-2.5-flash-lite",
      name: "Gemini 2.5 Flash Lite",
      toolCalling: true,
      supportsVision: true,
    },
  ],
};
