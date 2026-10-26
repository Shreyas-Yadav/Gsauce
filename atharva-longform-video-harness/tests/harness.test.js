const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Workspace, PROJECT } = require("../src/harness/workspace");
const { makeTools } = require("../src/harness/tools");
const { GeminiSession } = require("../src/harness/gemini");
const { runAgent } = require("../src/harness/agent");
const { brief, source } = require("../src/harness/demo");
const { validateBrief, applyResumeLimits } = require("../tools/lit");

const workspace = () => new Workspace(`test-${randomUUID().slice(0, 8)}`, { create: true, base: join(PROJECT, "build/test-runs"), brief, limits: { maxCalls: 8, maxOutputTokens: 8192 } });
const call = (name, args = {}) => ({ type: "function_call", id: randomUUID(), name, arguments: args });

test("workspace blocks traversal, unauthorized reads and symlinks", () => {
  assert.throws(() => new Workspace("../outside"), /Invalid/);
  const ws = workspace();
  assert.throws(() => ws.read(".env"), /allowlisted/);
  assert.throws(() => ws.write("../scene.js", "bad"), /allowlisted/);
  const link = join(ws.root, "scene.js");
  fs.symlinkSync(join(PROJECT, "package.json"), link);
  try { assert.throws(() => ws.writeScene(source), /Symbolic/); }
  finally { fs.unlinkSync(link); }
});

test("one process at a time owns a run", () => {
  const ws = workspace();
  const release = ws.acquire();
  try { assert.throws(() => new Workspace(ws.id, { base: ws.base }).acquire(), /locked/); }
  finally { release(); }
  ws.acquire()();
});

test("a new scene invalidates verification, rendering and review", () => {
  const ws = workspace();
  ws.writeScene(source);
  const hash = ws.sceneHash();
  ws.state.verification = { hash, passed: true };
  ws.state.preview = { hash };
  ws.state.review = { hash, findings: [] };
  fs.writeFileSync(join(ws.artifactDir(), "preview.mp4"), "fixture");
  assert.equal(ws.gate().passed, true);
  ws.writeScene(source + "\n// revision");
  assert.equal(ws.gate().passed, false);
  assert.equal(ws.state.review, null);
});

test("major reviewer findings block completion, minor findings remain visible", () => {
  const ws = workspace();
  ws.writeScene(source);
  const hash = ws.sceneHash();
  ws.state.verification = { hash, passed: true };
  ws.state.preview = { hash };
  ws.state.review = { hash, findings: [{ severity: "major" }] };
  fs.writeFileSync(join(ws.artifactDir(), "preview.mp4"), "fixture");
  assert.equal(ws.gate().passed, false);
  ws.state.review.findings[0].severity = "minor";
  assert.equal(ws.gate().status, "ready_for_human_review");
});

test("tool registry rejects shell access, extra arguments and repair loops", async () => {
  const ws = workspace();
  const tools = makeTools(ws);
  for (const request of [call("shell", { command: "pwd" }), call("read_scene", { path: ".env" })]) {
    const result = await tools.execute(request);
    assert.equal(JSON.parse(result.result[0].text).ok, false);
  }
  for (let i = 0; i < 4; i++) assert.equal(JSON.parse((await tools.execute(call("write_scene", { source: source + `\n// revision ${i}` }))).result[0].text).ok, true);
  assert.equal(JSON.parse((await tools.execute(call("write_scene", { source }))).result[0].text).ok, false);
});

test("full mocked lead/tool/reviewer loop reaches only the human-review gate", async () => {
  const ws = workspace();
  const actions = [call("write_scene", { source }), call("verify_scene"), call("render_preview"), call("review_preview")];
  let turn = 0;
  const session = {
    async create(model, _input, tools, system) {
      if (model === "gemini-3.8-flash") return { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: '{"findings":[]}' }] }] };
      assert.ok(system.includes("You alone plan"));
      assert.ok(tools.length > 0);
      return turn < actions.length ? { status: "requires_action", steps: [actions[turn++]] } :
        { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Ready for review." }] }] };
    }
  };
  const tools = makeTools(ws, { session,
    verifier: async () => { ws.state.verification = { hash: ws.sceneHash(), passed: true }; return ws.state.verification; },
    renderer: async () => {
      ws.state.preview = { hash: ws.sceneHash() };
      for (const name of ["preview.mp4", "still-0.png", "still-1.png", "still-2.png", "still-3.png"]) fs.writeFileSync(join(ws.artifactDir(), name), "fixture");
      return ws.state.preview;
    }
  });
  const result = await runAgent(ws, session, { tools, autoPipeline: true });
  assert.equal(result.passed, true);
  assert.equal(ws.state.status, "ready_for_human_review");
  assert.equal(ws.state.tool_calls, 4);
  assert.equal(turn, 1);
  assert.equal(JSON.parse(ws.read("history.json")).filter((step) => step.type === "function_result").length, 1);
  const originalTurns = turn;
  await runAgent(ws, session, { tools });
  assert.equal(turn, originalTurns);
});

test("replaying the same scene write is idempotent", () => {
  const ws = workspace();
  ws.writeScene(source);
  const result = ws.writeScene(source);
  assert.equal(result.unchanged, true);
  assert.equal(ws.state.revisions, 1);
});

test("resume executes a pending tool call without regenerating it", async () => {
  const ws = workspace();
  const pending = call("write_scene", { source });
  ws.write("history.json", JSON.stringify([pending]));
  const session = { async create() { throw new Error("deliberate stop after tool execution"); } };
  await assert.rejects(runAgent(ws, session), /deliberate stop/);
  assert.equal(ws.read("scene.js"), source);
  const history = JSON.parse(ws.read("history.json"));
  assert.equal(history.at(-1).call_id, pending.id);
  await assert.rejects(runAgent(ws, session), /deliberate stop/);
  assert.equal(ws.state.revisions, 1);
});

test("request budgets survive resumed sessions and incomplete work cannot pass", async () => {
  const ws = workspace();
  let dispatched = false;
  const session = new GeminiSession({ client: { interactions: { create: async () => { dispatched = true; } } }, maxCalls: 2, initialCalls: 2, maxOutputTokens: 8192 });
  await assert.rejects(runAgent(ws, session), /limit/);
  assert.equal(dispatched, false);
  assert.equal(ws.state.status, "paused");
  assert.equal(ws.gate().passed, false);
});

test("CLI cannot enter paid generation without explicit limits", () => {
  const result = spawnSync(process.execPath, [join(PROJECT, "tools/lit.js"), "generate"], { cwd: PROJECT, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires explicit/);
  assert.equal(result.stdout.includes("request_started"), false);
  assert.throws(() => validateBrief({ ...brief, style: "unknown-style" }), /Invalid brief/);
});

test("approved output increase preserves spent calls and reviewer limits", () => {
  const ws = workspace();
  ws.state.api_calls = 6;
  const limits = { maxCalls: 8, maxOutputTokens: 65536, reviewerMaxOutputTokens: 8192 };
  assert.throws(() => applyResumeLimits(ws, limits, false), /requires/);
  assert.throws(() => applyResumeLimits(ws, { ...limits, maxCalls: 10 }, true), /requires/);
  applyResumeLimits(ws, limits, true);
  assert.equal(ws.state.api_calls, 6);
  assert.equal(ws.state.limits.maxCalls, 8);
  assert.equal(ws.state.limit_changes.length, 1);
  assert.equal(ws.state.limits.reviewerMaxOutputTokens, 8192);
  applyResumeLimits(ws, { ...limits, maxCalls: 10 }, false, true);
  assert.equal(ws.state.api_calls, 6);
  assert.equal(ws.state.limits.maxCalls, 10);
});
