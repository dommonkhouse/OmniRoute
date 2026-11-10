import test from "node:test";
import assert from "node:assert/strict";

const networkFetch = globalThis.fetch;

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("watch-vision-effort-tiers");
const { handleChat, buildRequest, seedConnection, combosDb } = harness;
const { persistDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");
const { resolveModelOrError } = await import("../../src/sse/handlers/chatHelpers.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { applyResolvedSuffixClaudeEffort, applyResolvedSuffixGeminiLevel } =
  await import("../../open-sse/services/defaultReasoningEffort.ts");

const HAIKU = "claude-haiku-5-5";
const GEMINI = "gemini-3.8-flash";
const TERRA = "gpt-6.1-terra";
const HAIKU_ROUTE = `claude/${HAIKU}-xhigh`;
const GEMINI_ROUTE = `gemini/${GEMINI}-high`;
const TERRA_ROUTE = `codex/${TERRA}-high`;

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const claudeResponse = () =>
  jsonResponse({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: HAIKU,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
const geminiResponse = () =>
  jsonResponse({
    candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
const responsesResponse = () =>
  jsonResponse({
    id: "resp_test",
    object: "response",
    created_at: 0,
    status: "completed",
    model: TERRA,
    output: [
      {
        type: "message",
        id: "msg",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
const upstreamFailure = () => new Response("upstream unavailable", { status: 500 });

type CapturedCall = { url: string; body: Record<string, unknown> };

function captureFetch(
  fail: (url: string, body: Record<string, unknown>) => boolean,
  respond: (url: string) => Response
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    if (fail(url, body)) return upstreamFailure();
    return respond(url);
  }) as typeof fetch;
  return calls;
}

async function seedBaseModels() {
  await harness.resetStorage();
  const claude = await seedConnection("claude");
  await persistDiscoveredModels("claude", claude.id, [{ id: HAIKU }]);
  const gemini = await seedConnection("gemini");
  await persistDiscoveredModels("gemini", gemini.id, [{ id: GEMINI }]);
  const codex = await seedConnection("codex");
  // Terra's suffix tiers come from Codex discovery (reasoning.supported_efforts),
  // not the static registry — mirror the live synced row shape.
  await persistDiscoveredModels("codex", codex.id, [
    {
      id: TERRA,
      reasoning: { supported_efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
    },
  ]);
}

test.after(async () => {
  globalThis.fetch = networkFetch;
  await harness.cleanup();
});

// ── Registry declarations ─────────────────────────────────────────────────────

test("claude registry declares Haiku 5.5 tiers low..xhigh (no max)", () => {
  const entry = REGISTRY.claude.models.find((model) => model.id === HAIKU);
  assert.ok(entry, "claude-haiku-5-5 registry entry must exist");
  assert.deepEqual(entry.supportedThinkingEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(entry.supportsXHighEffort, true);
});

test("gemini registry declares 3.8 Flash tiers low..high", () => {
  const entry = REGISTRY.gemini.models.find((model) => model.id === GEMINI);
  assert.ok(entry, "gemini-3.8-flash registry entry must exist");
  assert.deepEqual(entry.supportedThinkingEfforts, ["low", "medium", "high"]);
});

// ── applyResolvedSuffixEffort unit behaviour ──────────────────────────────────

test("shape helpers pin the tier without touching explicit client choices", () => {
  const claude = applyResolvedSuffixClaudeEffort({ messages: [] }, "xhigh");
  assert.deepEqual(claude.output_config, { effort: "xhigh" });
  const explicitClaude = { output_config: { effort: "low" } };
  assert.equal(applyResolvedSuffixClaudeEffort(explicitClaude, "xhigh"), explicitClaude);

  const gemini = applyResolvedSuffixGeminiLevel(
    { generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: "low" } } },
    "high"
  );
  const geminiConfig = gemini.generationConfig as Record<string, unknown>;
  assert.equal((geminiConfig.thinkingConfig as Record<string, unknown>).thinkingLevel, "high");
  assert.equal(geminiConfig.maxOutputTokens, 64);
  const budget = applyResolvedSuffixGeminiLevel(
    { generationConfig: { thinkingBudget: 512, thinkingConfig: { includeThoughts: true } } },
    "medium"
  );
  const budgetConfig = (budget.generationConfig as Record<string, unknown>)
    .thinkingConfig as Record<string, unknown>;
  assert.equal(budgetConfig.thinkingLevel, "medium");
  assert.equal(budgetConfig.includeThoughts, true);
  assert.equal(budgetConfig.thinkingBudget, undefined);
});

// ── Resolution: suffixed variants resolve to base + tier ─────────────────────

test("suffixed Haiku xhigh resolves to the base model with resolvedThinkingEffort", async () => {
  await seedBaseModels();
  const result = await resolveModelOrError(HAIKU_ROUTE, {
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(result.model, HAIKU);
  assert.equal(result.resolvedThinkingEffort, "xhigh");
});

test("suffixed Gemini high resolves to the base model with resolvedThinkingEffort", async () => {
  await seedBaseModels();
  const result = await resolveModelOrError(GEMINI_ROUTE, {
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(result.model, GEMINI);
  assert.equal(result.resolvedThinkingEffort, "high");
});

// ── Final wire bodies through the real dispatcher ─────────────────────────────

test("Haiku -xhigh (no client effort) sends output_config.effort xhigh upstream", async () => {
  await seedBaseModels();
  const calls = captureFetch(
    () => false,
    (url) => (url.includes("googleapis") ? geminiResponse() : claudeResponse())
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: HAIKU_ROUTE,
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  assert.ok(calls.length >= 1);
  const claudeCall = calls.find((call) => call.url.includes("anthropic"));
  assert.ok(claudeCall, "must reach the Anthropic upstream");
  assert.equal(claudeCall.body.model, HAIKU);
  assert.equal(
    (claudeCall.body.output_config as Record<string, unknown> | undefined)?.effort,
    "xhigh"
  );
});

test("plain base Haiku (no suffix) still sends no injected effort", async () => {
  await seedBaseModels();
  const calls = captureFetch(
    () => false,
    () => claudeResponse()
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: `claude/${HAIKU}`,
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const claudeCall = calls.find((call) => call.url.includes("anthropic"));
  assert.ok(claudeCall);
  assert.equal(claudeCall.body.output_config, undefined);
});

test("Gemini -high (no client effort) sends thinkingLevel high upstream", async () => {
  await seedBaseModels();
  const calls = captureFetch(
    () => false,
    (url) => (url.includes("googleapis") ? geminiResponse() : claudeResponse())
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: GEMINI_ROUTE,
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const geminiCall = calls.find((call) => call.url.includes("googleapis"));
  assert.ok(geminiCall, "must reach the Gemini upstream");
  const thinkingConfig = (geminiCall.body.generationConfig as Record<string, unknown> | undefined)
    ?.thinkingConfig as Record<string, unknown> | undefined;
  assert.equal(thinkingConfig?.thinkingLevel, "high");
});

test("plain base Gemini keeps the pre-existing default level (pristine baseline: low)", async () => {
  // Pristine v3.8.52 control run (same harness, before the patch) captured
  // thinkingLevel "low" for an unsuffixed gemini-3.8-flash request. The live app
  // currently resolves "medium" through its own settings. The regression invariant
  // is that the patch must not change the unsuffixed base default, not which level
  // the default resolver picks in each environment.
  await seedBaseModels();
  const calls = captureFetch(
    () => false,
    () => geminiResponse()
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: `gemini/${GEMINI}`,
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const geminiCall = calls.find((call) => call.url.includes("googleapis"));
  assert.ok(geminiCall);
  const thinkingConfig = (geminiCall.body.generationConfig as Record<string, unknown> | undefined)
    ?.thinkingConfig as Record<string, unknown> | undefined;
  assert.equal(thinkingConfig?.thinkingLevel, "low");
});

test("explicit client effort beats the Gemini suffix tier", async () => {
  await seedBaseModels();
  const calls = captureFetch(
    () => false,
    () => geminiResponse()
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: GEMINI_ROUTE,
        stream: false,
        max_tokens: 64,
        reasoning_effort: "low",
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const geminiCall = calls.find((call) => call.url.includes("googleapis"));
  assert.ok(geminiCall);
  const thinkingConfig = (geminiCall.body.generationConfig as Record<string, unknown> | undefined)
    ?.thinkingConfig as Record<string, unknown> | undefined;
  assert.equal(thinkingConfig?.thinkingLevel, "low");
});

test("Terra -high keeps reasoning.effort high upstream", async () => {
  await seedBaseModels();
  const calls = captureFetch(
    () => false,
    () => responsesResponse()
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: TERRA_ROUTE,
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  assert.ok(calls.length >= 1);
  const terraCall = calls[calls.length - 1];
  assert.equal((terraCall.body.reasoning as Record<string, unknown> | undefined)?.effort, "high");
});

// ── Priority fallback through the real dispatcher (mocked availability) ──────

async function createWatchVisionCombo() {
  await combosDb.createCombo({
    name: "watch-vision-test",
    strategy: "priority",
    models: [HAIKU_ROUTE, GEMINI_ROUTE, TERRA_ROUTE],
  });
}

test("priority lane: healthy Haiku serves without later members", async () => {
  await seedBaseModels();
  await createWatchVisionCombo();
  const calls = captureFetch(
    () => false,
    (url) => (url.includes("googleapis") ? geminiResponse() : claudeResponse())
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: "watch-vision-test",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  assert.ok(calls.some((call) => call.url.includes("anthropic")));
  assert.equal(
    calls.some((call) => call.url.includes("googleapis")),
    false
  );
});

test("priority lane: Haiku down falls to Gemini high", async () => {
  await seedBaseModels();
  await createWatchVisionCombo();
  const calls = captureFetch(
    (url) => url.includes("anthropic"),
    (url) => (url.includes("googleapis") ? geminiResponse() : responsesResponse())
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: "watch-vision-test",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const geminiCall = calls.find((call) => call.url.includes("googleapis"));
  assert.ok(geminiCall, "must fall back to Gemini");
  const thinkingConfig = (geminiCall.body.generationConfig as Record<string, unknown> | undefined)
    ?.thinkingConfig as Record<string, unknown> | undefined;
  assert.equal(thinkingConfig?.thinkingLevel, "high");
});

test("priority lane: suffixed Gemini failing falls to base Gemini without the tier", async () => {
  await seedBaseModels();
  await combosDb.createCombo({
    name: "watch-vision-gemini-strip",
    strategy: "priority",
    models: [GEMINI_ROUTE, `gemini/${GEMINI}`],
  });
  const calls = captureFetch(
    (_url, body) =>
      (
        (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig as
          Record<string, unknown> | undefined
      )?.thinkingLevel === "high",
    () => geminiResponse()
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: "watch-vision-gemini-strip",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const geminiCalls = calls.filter((call) => call.url.includes("googleapis"));
  assert.ok(geminiCalls.length >= 2, "must retry on the base model after the suffixed failure");
  const fallbackCall = geminiCalls[geminiCalls.length - 1];
  const thinkingConfig = (fallbackCall.body.generationConfig as Record<string, unknown> | undefined)
    ?.thinkingConfig as Record<string, unknown> | undefined;
  assert.notEqual(thinkingConfig?.thinkingLevel, "high");
});

test("priority lane: Haiku and Gemini down fall to Terra high", async () => {
  await seedBaseModels();
  await createWatchVisionCombo();
  const calls = captureFetch(
    (url) => url.includes("anthropic") || url.includes("googleapis"),
    () => responsesResponse()
  );
  const response = await handleChat(
    buildRequest({
      body: {
        model: "watch-vision-test",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: "Transcribe the heading." }],
      },
    })
  );
  assert.equal(response.status, 200, await response.text());
  const terraCall = calls.find(
    (call) => !call.url.includes("anthropic") && !call.url.includes("googleapis")
  );
  assert.ok(terraCall, "must fall back to Terra");
  assert.equal((terraCall.body.reasoning as Record<string, unknown> | undefined)?.effort, "high");
});
