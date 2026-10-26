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
