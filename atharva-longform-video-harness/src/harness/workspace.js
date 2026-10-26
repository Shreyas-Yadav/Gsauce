const fs = require("node:fs");
const { resolve, join, relative, sep } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const PROJECT = resolve(__dirname, "../..");
const RUNS = join(PROJECT, "build/runs");
const FILES = new Set(["scene.js", "plan.json", "brief.json", "project.json", "state.json", "history.json", "events.jsonl",
  "topic.json", "research.json", "search-response.json", "bootstrap-response.json", "search-rejected-1.json", "bootstrap-rejected-1.json"]);

function noSymlinks(base, target) {
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(base, rel) !== target) throw new Error("Path outside workspace.");
  let current = base;
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    current = part ? join(current, part) : current;
    if (fs.existsSync(current) || (() => { try { return fs.lstatSync(current).isSymbolicLink(); } catch { return false; } })()) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symbolic links are not allowed in workspaces.");
    }
  }
  return target;
}

function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, path);
}

function digest(source) { return createHash("sha256").update(source).digest("hex"); }

class Workspace {
  constructor(id, { base = RUNS, create = false, brief, limits } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid run ID.");
    this.id = id;
    this.base = resolve(base);
    // Check the build directory as well as the run directory before creating anything.
    noSymlinks(PROJECT, this.base);
    this.root = noSymlinks(PROJECT, join(this.base, id));
    if (create) {
      fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.root, { mode: 0o700 });
      this.state = { version: 1, id, status: "created", api_calls: 0, tool_calls: 0, revisions: 0,
        limits, verification: null, preview: null, review: null };
      this.write("brief.json", JSON.stringify(brief));
      this.write("history.json", "[]");
      this.save();
    } else {
      this.state = JSON.parse(this.read("state.json"));
      if (this.state.version !== 1 || this.state.id !== id) throw new Error("Unsupported run state.");
    }
  }

  path(name) {
    if (!FILES.has(name)) throw new Error("File is not allowlisted.");
    return noSymlinks(PROJECT, join(this.root, name));
  }
  read(name) {
    const path = this.path(name);
    if (fs.statSync(path).size > 2 * 1024 * 1024) throw new Error("Workspace file exceeds size limit.");
    return fs.readFileSync(path, "utf8");
  }
  write(name, content) {
    if (typeof content !== "string" || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Workspace content exceeds size limit.");
    atomicWrite(this.path(name), content);
  }
  save() { this.write("state.json", JSON.stringify(this.state, null, 2)); }
  event(event) {
    fs.appendFileSync(this.path("events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  }
  sceneHash() {
    // Cache identity includes the approved brief and the code that actually draws it.
    return digest(JSON.stringify({ scene: this.read("scene.js"), brief: this.read("brief.json"),
      riso: JSON.parse(this.read("brief.json")).style === "risograph" ? digest(require("./skills").readRisoKit()) : null,
      renderer: ["engine.js", "harness/scene-host.js", "harness/render.js"].map((name) => digest(fs.readFileSync(join(PROJECT, "src", name)))) }));
  }
  artifactDir() {
    const path = noSymlinks(PROJECT, join(this.root, "artifacts", this.sceneHash()));
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  writeScene(source) {
    if (typeof source !== "string" || Buffer.byteLength(source) > 100000) throw new Error("Scene must be at most 100 KB of JavaScript.");
    if (fs.existsSync(this.path("scene.js")) && this.read("scene.js") === source) return { hash: this.sceneHash(), revision: this.state.revisions, unchanged: true };
    if (this.state.revisions >= 4) throw new Error("Scene revision limit reached.");
    this.write("scene.js", source);
    this.state.revisions++;
    this.state.verification = this.state.preview = this.state.review = null;
    this.state.status = "scene_written";
    this.save();
    return { hash: this.sceneHash(), revision: this.state.revisions };
  }
  gate({ requireReview = true } = {}) {
    let hash;
    try { hash = this.sceneHash(); } catch { return { passed: false, reason: "No scene written." }; }
    if (this.state.verification?.hash !== hash || !this.state.verification.passed) return { passed: false, reason: "Current scene has not passed verification." };
    if (this.state.preview?.hash !== hash || !fs.existsSync(join(this.artifactDir(), "preview.mp4"))) return { passed: false, reason: "Current scene needs a rendered preview." };
    if (requireReview && (this.state.review?.hash !== hash || this.state.review.findings.some((f) => ["major", "critical"].includes(f.severity)))) {
      return { passed: false, reason: "Current scene needs a valid Flash review with no unresolved major findings." };
    }
    return { passed: true, status: "ready_for_human_review", hash };
  }
  acquire() {
    const path = noSymlinks(PROJECT, join(this.root, ".lock"));
    if (fs.existsSync(path)) {
      const pid = Number(fs.readFileSync(path, "utf8"));
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      if (alive) throw new Error("Run is locked by another process.");
      fs.unlinkSync(path);
    }
    fs.writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return () => { if (fs.existsSync(path) && fs.readFileSync(path, "utf8") === String(process.pid)) fs.unlinkSync(path); };
  }
}

module.exports = { Workspace, PROJECT, RUNS, noSymlinks, atomicWrite, digest };
