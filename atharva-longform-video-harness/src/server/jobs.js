const fs = require("node:fs");
const { join } = require("node:path");
const childProcess = require("node:child_process");
const { PROJECT, RUNS, noSymlinks } = require("../harness/workspace");

const LOG_FILE = "generation.log";
const LOG_LIMIT = 1024 * 1024;
const LOG_TAIL_LINES = 20;
const MAX_CONCURRENT = 2;

// Runs `lit.js create` as a child process per project so a crashed or slow
// generation never takes the studio server down with it. The CLI owns the
// workspace lock, the 15-minute deadline and SIGINT cancellation.
function createJobRunner({ spawn = childProcess.spawn, script = join(PROJECT, "tools/lit.js"), runs = RUNS, maxConcurrent = MAX_CONCURRENT } = {}) {
  const jobs = new Map();

  const projectRoot = (id) => noSymlinks(PROJECT, join(runs, "projects", id));
  const running = () => [...jobs.values()].filter((job) => job.running).length;

  function start({ id, topic, duration, style, approveReviewRetry = false }) {
    if (jobs.get(id)?.running) throw Object.assign(new Error("Generation is already running for this creation."), { status: 409 });
    if (running() >= maxConcurrent) throw Object.assign(new Error(`At most ${maxConcurrent} generations can run at once.`), { status: 429 });

    const args = [script, "create", topic, `--id=${id}`, `--duration=${duration}`];
    if (style) args.push(`--style=${style}`);
    if (approveReviewRetry) args.push("--approve-review-retry");
    const child = spawn(process.execPath, args, { cwd: PROJECT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    const logPath = join(projectRoot(id), LOG_FILE);
    fs.writeFileSync(logPath, "", { mode: 0o600 });
    let logged = 0;
    const append = (chunk) => {
      if (logged >= LOG_LIMIT) return;
      const text = chunk.toString("utf8").slice(0, LOG_LIMIT - logged);
      logged += Buffer.byteLength(text);
      fs.appendFileSync(logPath, text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const job = { id, pid: child.pid, running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, signal: null, error: null, child };
    jobs.set(id, job);
    const finish = (exitCode, signal, error = null) => {
      if (!job.running) return;
      Object.assign(job, { running: false, finishedAt: new Date().toISOString(), exitCode, signal, error, child: null });
    };
    child.on("error", (error) => finish(null, null, error.message));
    child.on("exit", (code, signal) => finish(code, signal));
    return publicJob(job);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job?.running) return false;
    job.child.kill("SIGINT");
    return true;
  }

  function status(id) {
    const root = projectRoot(id);
    if (!fs.existsSync(root)) return null;
    const state = readJson(join(root, "state.json"));
    const job = jobs.get(id);
    return {
      id,
      status: state.status || "research_pending",
      apiCalls: state.api_calls || 0,
      job: job ? publicJob(job) : null,
      log: tail(join(root, LOG_FILE))
    };
  }

  return { start, cancel, status, job: (id) => (jobs.has(id) ? publicJob(jobs.get(id)) : null), isRunning: (id) => Boolean(jobs.get(id)?.running) };
}

function publicJob({ child, ...job }) {
  return job;
}

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return {}; }
}

function tail(path) {
  try {
    return fs.readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).slice(-LOG_TAIL_LINES);
  } catch { return []; }
}

module.exports = { createJobRunner };
