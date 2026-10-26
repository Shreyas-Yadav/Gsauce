const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { RUNS } = require("../src/harness/workspace");
const { createJobRunner } = require("../src/server/jobs");
const { createStudioServer } = require("../src/server/index");

function projectDir(t) {
  const id = `test-studio-${randomUUID().slice(0, 8)}`;
  const root = join(RUNS, "projects", id);
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { id, root };
}

function fakeScript(t, body) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "studio-job-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "lit.js");
  fs.writeFileSync(script, body);
  return script;
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

test("a background generation passes the create arguments and reports its log and exit", async (t) => {
  const { id, root } = projectDir(t);
  fs.writeFileSync(join(root, "state.json"), JSON.stringify({ status: "planned", api_calls: 2 }));
  const script = fakeScript(t, 'console.log(JSON.stringify(process.argv.slice(2))); console.error("Request 3: argon.");');
  const jobs = createJobRunner({ script });

  const started = jobs.start({ id, topic: "How tides work", duration: 60, style: "line" });
  assert.equal(started.running, true);
  assert.equal("child" in started, false);

  const done = await waitFor(() => { const s = jobs.status(id); return s.job.running ? null : s; });
  assert.equal(done.job.exitCode, 0);
  assert.equal(done.status, "planned");
  assert.equal(done.apiCalls, 2);
  assert.deepEqual(JSON.parse(done.log[0]), ["create", "How tides work", `--id=${id}`, "--duration=60", "--style=line"]);
  assert.equal(done.log[1], "Request 3: argon.");
});

test("cancelling a generation interrupts the CLI so it can mark the run cancelled", async (t) => {
  const { id } = projectDir(t);
  const script = fakeScript(t, 'process.on("SIGINT", () => { console.log("cancelled"); process.exit(130); }); console.log("ready"); setInterval(() => {}, 1000);');
  const jobs = createJobRunner({ script });

  jobs.start({ id, topic: "Slow topic", duration: 60 });
  await waitFor(() => jobs.status(id).log.includes("ready"));
  assert.equal(jobs.cancel(id), true);
  const done = await waitFor(() => { const s = jobs.status(id); return s.job.running ? null : s; });
  assert.equal(done.job.exitCode, 130);
  assert.ok(done.log.includes("cancelled"));
  assert.equal(jobs.cancel(id), false);
});

test("the runner refuses duplicate and excess concurrent generations", async (t) => {
  const first = projectDir(t);
  const second = projectDir(t);
  const script = fakeScript(t, 'process.on("SIGINT", () => process.exit(130)); setInterval(() => {}, 1000);');
  const jobs = createJobRunner({ script, maxConcurrent: 1 });

  jobs.start({ id: first.id, topic: "One", duration: 60 });
  t.after(() => jobs.cancel(first.id));
  assert.throws(() => jobs.start({ id: first.id, topic: "One", duration: 60 }), (error) => error.status === 409);
  assert.throws(() => jobs.start({ id: second.id, topic: "Two", duration: 60 }), (error) => error.status === 429);
  assert.equal(jobs.status(`test-studio-missing-${randomUUID().slice(0, 8)}`), null);
});

async function listen(t, options) {
  const server = createStudioServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("creating from the studio starts a background generation and exposes polling routes", async (t) => {
  const id = `test-studio-${randomUUID().slice(0, 8)}`;
  t.after(() => fs.rmSync(join(RUNS, "projects", id), { recursive: true, force: true }));
  const started = [];
  const cancelled = [];
  const jobs = {
    start(spec) { started.push(spec); return { id: spec.id, running: true }; },
    cancel(jobId) { cancelled.push(jobId); return true; },
    status(jobId) { return jobId === id ? { id, status: "research_pending", apiCalls: 0, job: { running: true }, log: [] } : null; }
  };
  const base = await listen(t, { jobs, hasCredentials: () => true });

  const res = await fetch(`${base}/api/creations`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, topic: "How tides work", style: "risograph", duration: 60 }) });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).job.running, true);
  assert.deepEqual(started, [{ id, topic: "How tides work", duration: 60, style: "risograph" }]);
  assert.ok(fs.existsSync(join(RUNS, "projects", id, "topic.json")));

  const status = await fetch(`${base}/api/creations/${id}/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status, "research_pending");
  assert.equal((await fetch(`${base}/api/creations/test-studio-missing/status`)).status, 404);

  assert.equal((await fetch(`${base}/api/creations/${id}/cancel`, { method: "POST" })).status, 202);
  assert.deepEqual(cancelled, [id]);
});

test("creating from the studio without Gemini credentials fails before writing a project", async (t) => {
  const id = `test-studio-${randomUUID().slice(0, 8)}`;
  const jobs = { start() { throw new Error("must not start"); }, cancel: () => false, status: () => null };
  const base = await listen(t, { jobs, hasCredentials: () => false });

  const res = await fetch(`${base}/api/creations`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, topic: "How tides work", duration: 60 }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /credentials/);
  assert.equal(fs.existsSync(join(RUNS, "projects", id)), false);
});

test("archiving hides a creation from the studio list until it is restored", async (t) => {
  // The studio list skips "test-" ids, so this fixture uses a different prefix.
  const id = `archivetest-${randomUUID().slice(0, 8)}`;
  const root = join(RUNS, "projects", id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, "topic.json"), JSON.stringify({ topic: "Archive fixture", duration: 30, style: "line" }));
  const archiveDir = fs.mkdtempSync(join(os.tmpdir(), "studio-archive-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(archiveDir, { recursive: true, force: true });
  });
  let running = false;
  const jobs = { start() {}, cancel: () => false, status: () => null, isRunning: () => running };
  const base = await listen(t, { jobs, hasCredentials: () => true, archivePath: join(archiveDir, "archive.json") });
  const ids = async (query = "") => (await (await fetch(`${base}/api/creations${query}`)).json()).creations.map((item) => item.id);

  assert.ok((await ids()).includes(id));
  running = true;
  assert.equal((await fetch(`${base}/api/creations/${id}/archive`, { method: "POST" })).status, 409);
  running = false;

  const archived = await fetch(`${base}/api/creations/${id}/archive`, { method: "POST" });
  assert.equal(archived.status, 200);
  assert.ok((await archived.json()).archivedCount >= 1);
  assert.ok(!(await ids()).includes(id));
  assert.ok((await ids("?archived=1")).includes(id));
  assert.ok(fs.existsSync(join(root, "topic.json")));

  assert.equal((await fetch(`${base}/api/creations/${id}/restore`, { method: "POST" })).status, 200);
  assert.ok((await ids()).includes(id));
  assert.ok(!(await ids("?archived=1")).includes(id));
  assert.equal((await fetch(`${base}/api/creations/archivetest-missing/archive`, { method: "POST" })).status, 404);
});

function progressFixture(t, { topic = true } = {}) {
  const { id, root } = projectDir(t);
  const scene = join(root, "scenes", "scene-a");
  fs.mkdirSync(scene, { recursive: true });
  if (topic) fs.writeFileSync(join(root, "topic.json"), JSON.stringify({ topic: "How tides work", duration: 30, style: "line" }));
  fs.writeFileSync(join(root, "research.json"), "{}");
  fs.writeFileSync(join(root, "project.json"), JSON.stringify({ scenes: [{ id: "scene-a", order: 0, duration: 10 }] }));
  fs.writeFileSync(join(root, "state.json"), JSON.stringify({ version: 1, id, status: "paused", api_calls: 22, limits: { maxCalls: 22 }, audio_pregenerated: true,
    bootstrap: { research: { attempts: 1, status: "validated" }, planning: { attempts: 1, status: "validated" } },
    review_attempts: { "scene-a:abc": { attempts: 1, approved_retry: false, status: "uncertain" } } }));
  fs.writeFileSync(join(scene, "state.json"), JSON.stringify({ status: "scene_written", revisions: 2, project_pipeline: {
    verification: { status: "invalid", attempts: 1, result: { samples: [{ warnings: ["Overlapping text bounds."] }, { warnings: ["Overlapping text bounds."] }] } },
    rendering: { status: "pending", attempts: 0 }, review: { status: "pending", attempts: 0 } } }));
  fs.writeFileSync(join(root, "events.jsonl"), [
    { type: "request_started", call: 1, model: "gemini-4-argon", at: "2026-10-26T00:00:00Z" },
    { type: "request_completed", call: 1, model: "gemini-4-argon", elapsed_ms: 4000, usage: { total_tokens: 1200 } },
    { type: "request_started", call: 2, model: "gemini-3.8-flash", at: "2026-10-26T00:00:05Z" },
    { type: "request_failed", call: 2, model: "gemini-3.8-flash", elapsed_ms: 900, http_status: 400 }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  fs.writeFileSync(join(root, "generation.log"), "Request 2: gemini-3.8-flash.\nGemini request failed (HTTP 400).\n");
  return { id, root };
}

test("progress shows each pipeline stage, agent requests and why a run stopped", (t) => {
  const { buildProgress } = require("../src/server/progress");
  const { id } = progressFixture(t);
  const progress = buildProgress(id);

  assert.deepEqual(progress.budget, { used: 22, limit: 22, remaining: 0 });
  assert.equal(progress.phases.research.status, "passed");
  assert.equal(progress.phases.narration.status, "passed");
  assert.deepEqual(progress.scenes[0].stages.write, { status: "passed", attempts: 2 });
  assert.deepEqual(progress.scenes[0].stages.verify, { status: "invalid", attempts: 1, warnings: ["Overlapping text bounds."] });
  assert.deepEqual(progress.requests.map((req) => [req.call, req.agent, req.status]), [[2, "Flash", "failed"], [1, "Argon", "done"]]);
  assert.equal(progress.requests[0].error, "HTTP 400");
  assert.deepEqual(progress.stop, { reason: "Gemini request failed (HTTP 400).", budgetExhausted: true, reviewRetryEligible: true, resumable: true });
  assert.equal(buildProgress(id, { job: { running: true } }).stop, null);
});

test("resuming from the studio can add requests and approve a review retry", async (t) => {
  const { id, root } = progressFixture(t);
  const started = [];
  let running = false;
  const jobs = { start(spec) { started.push(spec); return { id: spec.id, running: true }; }, cancel: () => false, status: () => null,
    job: () => null, isRunning: () => running };
  const base = await listen(t, { jobs, hasCredentials: () => true });
  const resume = (body) => fetch(`${base}/api/creations/${id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await resume({ extraCalls: 51 })).status, 400);
  assert.equal((await resume({ extraCalls: 2.5 })).status, 400);
  running = true;
  assert.equal((await resume({})).status, 409);
  running = false;

  assert.equal((await resume({ extraCalls: 10, approveReviewRetry: true })).status, 202);
  assert.deepEqual(started, [{ id, topic: "How tides work", duration: 30, style: "line", approveReviewRetry: true }]);
  assert.equal(JSON.parse(fs.readFileSync(join(root, "state.json"), "utf8")).limits.maxCalls, 32);
  assert.match(fs.readFileSync(join(root, "events.jsonl"), "utf8"), /"approved_limits_increased","source":"studio","max_calls":\{"from":22,"to":32\}/);

  const progress = await (await fetch(`${base}/api/creations/${id}/progress`)).json();
  assert.equal(progress.budget.limit, 32);
});

test("resuming refuses creations that were not started from a topic", async (t) => {
  const { id } = progressFixture(t, { topic: false });
  const jobs = { start() { throw new Error("must not start"); }, cancel: () => false, status: () => null, job: () => null, isRunning: () => false };
  const base = await listen(t, { jobs, hasCredentials: () => true });
  const res = await fetch(`${base}/api/creations/${id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /CLI/);
});

test("a resumed generation forwards the review retry approval to the CLI", async (t) => {
  const { id } = projectDir(t);
  const script = fakeScript(t, "console.log(JSON.stringify(process.argv.slice(2)));");
  const jobs = createJobRunner({ script });
  jobs.start({ id, topic: "How tides work", duration: 30, approveReviewRetry: true });
  const done = await waitFor(() => { const s = jobs.status(id); return s.job.running ? null : s; });
  assert.ok(JSON.parse(done.log[0]).includes("--approve-review-retry"));
});
