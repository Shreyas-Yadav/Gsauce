const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { MODELS, credentials, safeFailure, GeminiProbe, executeProbeTool, toolRoundTrip, validateReview } = require("../src/harness/gemini");

const makeProbe = (create, options = {}) => new GeminiProbe({ client: { interactions: { create } }, maxCalls: 4, maxOutputTokens: 4096, ...options });

test("credentials support custom casing, process precedence, and missing files", () => {
  assert.equal(credentials({ Gemini_API_KEY: " test-value " }, "/nonexistent/probe.env"), "test-value");
  assert.equal(credentials({}, "/nonexistent/probe.env"), null);
  assert.throws(() => credentials({ GEMINI_API_KEY: "one", Gemini_API_KEY: "two" }, "/nonexistent/probe.env"), /Conflicting/);
});

test("local .env accepts whitespace around the custom key name", () => {
  const root = resolve(__dirname, "../build/test-workspaces");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "credentials-"));
  const path = join(dir, ".env");
  try {
    writeFileSync(path, "Gemini_API_KEY = local-test-value\n");
    assert.equal(credentials({}, path), "local-test-value");
    assert.equal(credentials({ GEMINI_API_KEY: "process-test-value" }, path), "process-test-value");
  } finally {
    unlinkSync(path);
    rmdirSync(dir);
  }
});

test("tool execution rejects unauthorized tools, extra fields, and invalid numbers", () => {
  for (const step of [
    { type: "function_call", name: "shell", id: "x", arguments: { a: 1, b: 2 } },
    { type: "function_call", name: "sum_probe", id: "x", arguments: { a: "1", b: 2 } },
    { type: "function_call", name: "sum_probe", id: "x", arguments: { a: 1, b: 2, cmd: "bad" } }
  ]) assert.throws(() => executeProbeTool(step), /Rejected/);
});

test("stateless continuation preserves signatures and re-sends tools", async () => {
  const requests = [];
  const thought = { type: "thought", signature: "opaque-signature" };
  const probe = makeProbe(async (body, options) => {
    requests.push(body);
    assert.equal(body.store, false);
    assert.equal(options.maxRetries, 0);
    assert.equal(body.generation_config.max_output_tokens, 4096);
    if (requests.length === 1) return { status: "requires_action", steps: [thought,
      { type: "function_call", name: "sum_probe", id: "call-1", arguments: { a: 19, b: 23 } }] };
    assert.strictEqual(body.input[1], thought);
    assert.equal(body.input.at(-1).call_id, "call-1");
    return { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "42" }] }] };
  });
  assert.deepEqual(await toolRoundTrip(probe), { tool_round_trip: "passed" });
  assert.deepEqual(requests[1].tools, requests[0].tools);
});

test("request caps and model restrictions are enforced before network access", async () => {
  let calls = 0;
  const probe = makeProbe(async () => { calls++; return { status: "completed" }; }, { maxCalls: 1 });
  await assert.rejects(probe.create("gemini-nano-banana-2.1", "test"), /not allowed/);
  await probe.create(MODELS.lead, "test");
  await assert.rejects(probe.create(MODELS.lead, "test"), /limit/);
  assert.equal(calls, 1);
});

test("pinned SDK serializes interactions and disables transport retries offline", async () => {
  const { GoogleGenAI } = require("@google/genai");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    const request = new Request(input, init);
    const body = await request.json();
    assert.equal(new URL(request.url).hostname, "generativelanguage.googleapis.com");
    assert.equal(body.store, false);
    assert.equal(body.model, MODELS.lead);
    assert.equal(body.generation_config.max_output_tokens, 4096);
    return new Response(JSON.stringify({ error: { code: 429, message: "offline-rate-limit" } }), {
      status: 429, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const probe = new GeminiProbe({ client: new GoogleGenAI({ apiKey: "offline-test-value" }), maxCalls: 1, maxOutputTokens: 4096 });
    await assert.rejects(probe.create(MODELS.lead, "test"), /no automatic retry/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rate limits are not retried and provider secrets are not logged", async () => {
  const events = [];
  const probe = makeProbe(async () => { throw Object.assign(new Error("private-provider-details"), { status: 429 }); }, { onEvent: (event) => events.push(event) });
  await assert.rejects(probe.create(MODELS.lead, "test"), /no automatic retry/);
  assert.equal(probe.calls, 1);
  assert.ok(!JSON.stringify(events).includes("private-provider-details"));
  assert.ok(!safeFailure(new Error("private-provider-details")).includes("private-provider-details"));
});

test("cancellation before dispatch consumes no API requests", async () => {
  const controller = new AbortController();
  controller.abort();
  const probe = makeProbe(async () => assert.fail("network must not run"), { signal: controller.signal });
  await assert.rejects(probe.create(MODELS.lead, "test"), /cancelled/);
  assert.equal(probe.calls, 0);
});

test("request deadline propagates abort to the transport", async () => {
  const probe = makeProbe(async (_body, options) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("deadline not propagated")), 200);
    options.fetchOptions.signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  }), { timeoutMs: 10 });
  await assert.rejects(probe.create(MODELS.lead, "test"), /timed out/);
});

test("review findings require bounded timestamps and evidence", () => {
  const finding = { severity: "major", timestamp_seconds: 0.5, evidence: "2+2=5", expected: "2+2=4" };
  assert.equal(validateReview(JSON.stringify({ findings: [finding] })).findings.length, 1);
  assert.equal(validateReview("```json\n" + JSON.stringify({ findings: [finding] }) + "\n```").findings.length, 1);
  assert.throws(() => validateReview("Explanation first\n" + JSON.stringify({ findings: [finding] })), /malformed/);
  assert.throws(() => validateReview("```json\n{}\n```\ntrailing text"), /malformed/);
  for (const bad of [null, { ...finding, timestamp_seconds: 3 }, { ...finding, evidence: "" }, { ...finding, severity: "maybe" }]) {
    assert.throws(() => validateReview(JSON.stringify({ findings: [bad] })), /invalid/);
  }
  assert.throws(() => validateReview('{"passed":true}'), /findings/);
});

test("incomplete and unavailable-model responses fail closed", async () => {
  await assert.rejects(makeProbe(async () => ({ status: "incomplete" })).create(MODELS.lead, "test"), /failed/);
  await assert.rejects(makeProbe(async () => { throw { status: 404 }; }).create(MODELS.lead, "test"), /unavailable/);
});

test("incomplete responses retain safe status and usage diagnostics", async () => {
  const events = [];
  const probe = makeProbe(async () => ({ status: "incomplete", usage: { total_output_tokens: 4096, private_field: "do-not-log" } }), { onEvent: (event) => events.push(event) });
  await assert.rejects(probe.create(MODELS.lead, "test"), /failed/);
  assert.equal(events.find((event) => event.type === "request_incomplete").usage.total_output_tokens, 4096);
  assert.equal(events.at(-1).interaction_status, "incomplete");
  assert.ok(!JSON.stringify(events).includes("do-not-log"));
});

test("live CLI refuses API dispatch without explicit request and token limits", () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, "../tools/gemini_smoke.js"), "--live"], {
    cwd: resolve(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, GEMINI_API_KEY: "offline-test-value", Gemini_API_KEY: "", GOOGLE_API_KEY: "" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --max-calls/);
  assert.ok(!result.stdout.includes("request_started"));
  assert.ok(!result.stdout.includes("offline-test-value"));
});

test("large lead budgets do not raise reviewer budgets or enable storage", async () => {
  const { GeminiSession } = require("../src/harness/gemini");
  const limits = [];
  const session = new GeminiSession({ client: { interactions: { create: async (body) => {
    limits.push(body.generation_config.max_output_tokens);
    assert.equal(body.store, false);
    assert.equal(body.background, undefined);
    return { status: "completed", steps: [] };
  } } }, maxCalls: 2, maxOutputTokens: 65536, reviewerMaxOutputTokens: 8192 });
  await session.create(MODELS.lead, "test");
  await session.create(MODELS.reviewer, "test");
  assert.deepEqual(limits, [65536, 8192]);
});

test("the lead cannot consume the final reserved Flash request", async () => {
  const { GeminiSession } = require("../src/harness/gemini");
  let calls = 0;
  const session = new GeminiSession({ client: { interactions: { create: async () => { calls++; return { status: "completed" }; } } },
    maxCalls: 2, initialCalls: 1, maxOutputTokens: 65536, reserveReviewer: true });
  await assert.rejects(session.create(MODELS.lead, "test"), /reserved/);
  await session.create(MODELS.reviewer, "test");
  assert.equal(calls, 1);
});
