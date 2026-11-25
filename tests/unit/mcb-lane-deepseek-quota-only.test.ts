/**
 * Gate test (not for upstream): does a quota-only flag on the Scout/Build/Deep
 * primary combo-ref keep DeepSeek emergency-only, and does DeepSeek still serve
 * when every member is out of allowance? Lane shapes copied from mcp-setup
 * config/omniroute-mcb14-lanes.json (policy v20, origin/main c638da7).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mcb-deepseek-gate-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const LANES = {
  scout: {
    members: [
      "cc/claude-sonnet-5-5-medium",
      "codex/gpt-6.1-terra-high",
      "agy/gemini-4-hydrogen-medium",
      "zai/glm-5.3-flash",
    ],
    deepseek: "deepseek/deepseek-flash",
  },
  build: {
    members: [
      "cc/claude-opus-5-5-high",
      "codex/gpt-6.2-sol-high",
      "agy/gemini-4-argon-high",
      "kimi-coding/k3.1-pro",
      "zai/glm-5.3-flash",
      "grok-cli/grok-4.7-xhigh",
    ],
    deepseek: "deepseek/deepseek-flash-max",
  },
  deep: {
    members: [
      "cc/claude-opus-5-5-high",
      "codex/gpt-6.2-sol-high",
      "agy/gemini-4-neon-high",
      "kimi-coding/k3.1-pro",
      "zai/glm-5.3-flash",
    ],
    deepseek: "deepseek/deepseek-flash-max",
  },
} as const;

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const quota429 = () =>
  Response.json({ error: { message: "Payment required", code: "insufficient_quota" } }, { status: 429 });
const outage503 = () => Response.json({ error: "Service unavailable" }, { status: 503 });

let caseNo = 0;
function shapes(lane: keyof typeof LANES) {
  caseNo += 1;
  const { members, deepseek } = LANES[lane];
  const child = {
    name: `gate-${lane}-${caseNo}-primary`,
    strategy: "round-robin",
    models: members.map((model) => ({ kind: "model", model })),
    config: { maxRetries: 0, stickyRoundRobinLimit: 1, disableSessionStickiness: false },
  };
  const parent = {
    name: `gate-${lane}-${caseNo}`,
    strategy: "priority",
    models: [
      { kind: "combo-ref", comboName: child.name, fallbackOnlyOnQuotaExhaustion: true },
      { kind: "model", model: deepseek },
    ],
    config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
  };
  return { members, deepseek, child, parent };
}

async function run(
  lane: keyof typeof LANES,
  respond: (model: string, callIndex: number) => Response,
  available: (model: string) => boolean = () => true
) {
  const s = shapes(lane);
  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: s.parent,
    allCombos: [s.parent, s.child],
    log,
    settings: null,
    isModelAvailable: async (model: string) => available(model),
    handleSingleModel: async (_body: unknown, model: string) => {
      calls.push(model);
      return respond(model, calls.length - 1);
    },
  } as never);
  return { ...s, calls, result };
}

test("control (e) with today's placement: flag on DeepSeek, not on the group", async () => {
  const s = shapes("scout");
  s.parent.models = [
    { kind: "combo-ref", comboName: s.child.name } as never,
    { kind: "model", model: s.deepseek, fallbackOnlyOnQuotaExhaustion: true } as never,
  ];
  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: s.parent,
    allCombos: [s.parent, s.child],
    log,
    settings: null,
    isModelAvailable: async (model: string) => model === s.deepseek,
    handleSingleModel: async (_body: unknown, model: string) => {
      calls.push(model);
      return ok();
    },
  } as never);
  assert.deepEqual(calls, [s.deepseek]);
  assert.equal(result.ok, true);
});

for (const lane of Object.keys(LANES) as Array<keyof typeof LANES>) {
  test(`${lane} (a): every member quota 429 -> DeepSeek serves last`, async () => {
    const r = await run(lane, (m) => (m === LANES[lane].deepseek ? ok() : quota429()));
    assert.equal(r.result.ok, true);
    assert.equal(r.calls.at(-1), r.deepseek);
    assert.deepEqual([...r.calls.slice(0, -1)].sort(), [...r.members].sort());
  });

  test(`${lane} (b): every member 503 -> DeepSeek never called`, async () => {
    const r = await run(lane, (m) => (m === LANES[lane].deepseek ? ok() : outage503()));
    assert.equal(r.result.ok, false);
    assert.ok(!r.calls.includes(r.deepseek), `DeepSeek called: ${r.calls.join(",")}`);
    assert.deepEqual([...r.calls].sort(), [...r.members].sort());
  });

  test(`${lane} (c): first member succeeds -> only it is called`, async () => {
    const r = await run(lane, () => ok());
    assert.equal(r.result.ok, true);
    assert.equal(r.calls.length, 1);
    assert.ok(r.members.includes(r.calls[0] as never));
  });

  test(`${lane} (d): one member 503, the rest quota 429 -> DeepSeek never called`, async () => {
    const r = await run(lane, (m, i) =>
      m === LANES[lane].deepseek ? ok() : i === 0 ? outage503() : quota429()
    );
    assert.equal(r.result.ok, false);
    assert.ok(!r.calls.includes(r.deepseek), `DeepSeek called: ${r.calls.join(",")}`);
    assert.deepEqual([...r.calls].sort(), [...r.members].sort());
  });

  test(`${lane} (e): every member quota_exhausted before dispatch -> DeepSeek serves`, async () => {
    const r = await run(
      lane,
      (m) => (m === LANES[lane].deepseek ? ok() : ok()),
      (m) =>
        m === LANES[lane].deepseek
          ? true
          : { available: false as const, reason: "quota_exhausted" as const, retryAfterMs: 60_000 }
    );
    const body = r.result.ok ? "" : await r.result.clone().text();
    assert.deepEqual(r.calls, [r.deepseek], `calls=${r.calls.join(",")} status=${r.result.status} body=${body.slice(0, 300)}`);
    assert.equal(r.result.ok, true);
  });

  test(`${lane} (f): every member plain-false before dispatch -> DeepSeek never called`, async () => {
    const r = await run(
      lane,
      (m) => (m === LANES[lane].deepseek ? ok() : ok()),
      (m) => m === LANES[lane].deepseek
    );
    assert.equal(r.result.ok, false);
    assert.ok(!r.calls.includes(r.deepseek), `DeepSeek called: ${r.calls.join(",")}`);
    assert.equal(r.result.status, 503);
  });

  test(`${lane} (g): mixed quota_exhausted and plain-false skips -> DeepSeek never called`, async () => {
    const r = await run(
      lane,
      (m) => (m === LANES[lane].deepseek ? ok() : ok()),
      (m) => {
        if (m === LANES[lane].deepseek) return true;
        const index = r_membersIndex(lane, m);
        return index === 0
          ? { available: false as const, reason: "quota_exhausted" as const, retryAfterMs: 60_000 }
          : false;
      }
    );
    assert.equal(r.result.ok, false);
    assert.ok(!r.calls.includes(r.deepseek), `DeepSeek called: ${r.calls.join(",")}`);
    assert.equal(r.result.status, 503);
  });
}

function r_membersIndex(lane: keyof typeof LANES, model: string): number {
  return LANES[lane].members.indexOf(model as (typeof LANES)[keyof typeof LANES]["members"][number]);
}

test("round-robin child only: all quota_exhausted skips -> 429 quota_exhausted", async () => {
  const s = shapes("deep");
  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: s.child,
    allCombos: [s.parent, s.child],
    log,
    settings: null,
    isModelAvailable: async () =>
      ({ available: false as const, reason: "quota_exhausted" as const, retryAfterMs: 60_000 }),
    handleSingleModel: async (_body: unknown, model: string) => {
      calls.push(model);
      return ok();
    },
  } as never);
  assert.deepEqual(calls, [], `unexpected dispatches: ${calls.join(",")}`);
  assert.equal(result.status, 429);
  const body = (await result.clone().json()) as { error?: { code?: string; type?: string } };
  assert.equal(body.error?.code, "quota_exhausted");
  assert.equal(body.error?.type, "rate_limit_error");
});

test("round-robin child only: mixed quota_exhausted and false skips -> 503 ALL_TARGETS_SKIPPED", async () => {
  const s = shapes("deep");
  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: s.child,
    allCombos: [s.parent, s.child],
    log,
    settings: null,
    isModelAvailable: async (model: string) =>
      r_membersIndex("deep", model) === 0
        ? ({ available: false as const, reason: "quota_exhausted" as const, retryAfterMs: 60_000 })
        : false,
    handleSingleModel: async (_body: unknown, model: string) => {
      calls.push(model);
      return ok();
    },
  } as never);
  assert.deepEqual(calls, [], `unexpected dispatches: ${calls.join(",")}`);
  assert.equal(result.status, 503);
  const body = (await result.clone().json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "ALL_TARGETS_SKIPPED");
});
