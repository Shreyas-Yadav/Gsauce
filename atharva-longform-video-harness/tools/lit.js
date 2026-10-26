const fs = require("node:fs");
const { resolve, join } = require("node:path");
const { parseArgs } = require("node:util");
const { randomUUID } = require("node:crypto");
const { Workspace, PROJECT } = require("../src/harness/workspace");
const { GeminiSession, credentials } = require("../src/harness/gemini");
const { verifyScene, renderPreview } = require("../src/harness/render");
const { runAgent } = require("../src/harness/agent");
const { syncSkills, readSkill } = require("../src/harness/skills");
const demo = require("../src/harness/demo");
const risoDemo = require("../src/harness/riso-demo");
const { ProjectWorkspace, validateProject, assembleProject } = require("../src/harness/project");
const { runProjectDemo } = require("../src/harness/project-demo");
const { runProjectAgent, makeProjectTools, approveReviewRetry, dispatchParallelSwarm } = require("../src/harness/project-agent");
const { openTopic, createProject } = require("../src/harness/create");

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function validateBrief(brief) {
  if (!brief || typeof brief.topic !== "string" || !brief.topic.trim() || typeof brief.audience !== "string" ||
      typeof brief.takeaway !== "string" || !["line", "watercolor", "risograph"].includes(brief.style) ||
      !Number.isFinite(brief.duration) || brief.duration < 10 || brief.duration > 15 ||
      !Array.isArray(brief.facts) || !brief.facts.every((item) => typeof item === "string") ||
      !Array.isArray(brief.sources) || !brief.sources.every((item) => typeof item === "string") ||
      JSON.stringify(brief).length > 12000) throw new Error("Invalid brief: provide topic, audience, takeaway, duration 10–15, style line/watercolor/risograph, facts and sources.");
  return brief;
}

function applyResumeLimits(workspace, limits, approvedIncrease, approvedRequests = false) {
  const previous = workspace.state.limits;
  const normalized = previous && { ...previous, reviewerMaxOutputTokens: previous.reviewerMaxOutputTokens ?? Math.min(previous.maxOutputTokens, 8192) };
  if (JSON.stringify(normalized) === JSON.stringify(limits)) return;
  if (!normalized || limits.reviewerMaxOutputTokens !== normalized.reviewerMaxOutputTokens ||
      (limits.maxCalls !== normalized.maxCalls && !(approvedRequests && limits.maxCalls > normalized.maxCalls)) ||
      (limits.maxOutputTokens !== normalized.maxOutputTokens && !(approvedIncrease && limits.maxOutputTokens > normalized.maxOutputTokens))) {
    throw new Error("Resume requires explicit approval flags for any output or request limit increase.");
  }
  const change = { at: new Date().toISOString(), api_calls_already_used: workspace.state.api_calls, previous: normalized, approved: limits };
  workspace.state.limit_changes = [...(workspace.state.limit_changes || []), change];
  workspace.state.limits = limits;
  workspace.save();
  workspace.event({ type: "approved_limits_increased", ...change });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    id: { type: "string" }, brief: { type: "string" }, live: { type: "boolean", default: false },
    "max-calls": { type: "string" }, "max-output-tokens": { type: "string" }, width: { type: "string" },
    thinking: { type: "string", default: "medium" }, "review-output-tokens": { type: "string" },
    "approve-output-increase": { type: "boolean", default: false },
    "approve-request-increase": { type: "boolean", default: false }, style: { type: "string" },
    scene: { type: "string" }, audio: { type: "string" }, "local-only": { type: "boolean", default: false },
    "approve-review-retry": { type: "boolean", default: false },
    duration: { type: "string" }, "retry-planning": { type: "boolean", default: false }
  } });
  const command = positionals[0] || "help";
  if (command === "help") {
    console.log('Create a researched project: node tools/lit.js create "Your topic" [--id=PROJECT_ID] [--duration=120] [--style=line]. No manifest or budget flags are required.');
    console.log("Commands: demo (offline), sync-skills, status --id, generate/resume --live --max-calls=N --max-output-tokens=N [--id] [--brief=approved.json].");
    console.log("Generated JS runs only in Chromium, never Node. Demo is hand-authored, silent, and makes no API calls.");
    console.log("Projects: project:demo (offline two-scene 16:9 plumbing check); project-init --id=ID --brief=manifest.json; project-status --id=ID; project-render --id=ID --scene=SCENE; project-audio --id=ID --audio=voice.wav; project-assemble --id=ID [--local-only]; project-generate/project-resume require --live and explicit limits. Uncertain Flash review retries require project-resume --approve-review-retry.");
    return;
  }
  if (command === "create") {
    if (positionals.length !== 2) throw new Error('Usage: node tools/lit.js create "Your topic" [--id=PROJECT_ID].');
    const workspace = openTopic(positionals[1], { id: values.id, duration: Number(values.duration || 120), style: values.style });
    console.log(`Project: ${workspace.id}`);
    console.log(`Resume: node tools/lit.js create ${shellQuote(positionals[1])} --id=${workspace.id}${values.duration ? ` --duration=${Number(values.duration)}` : ""}${values.style ? ` --style=${values.style}` : ""}`);
    const release = workspace.acquire();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    const deadline = setTimeout(cancel, 900000);
    deadline.unref();
    try {
      const key = credentials(process.env, join(PROJECT, ".env"));
      if (!key) throw new Error("Gemini credentials are not configured locally.");
      const { GoogleGenAI } = require("@google/genai");
      const session = new GeminiSession({ client: new GoogleGenAI({ apiKey: key }), ...workspace.state.limits,
        initialCalls: workspace.state.api_calls || 0, signal: controller.signal, timeoutMs: 900000,
        reserveReviewer: false,
        onEvent(event) {
          if (event.type === "request_started") { workspace.state.api_calls = event.call; workspace.save(); console.log(`Request ${event.call}: ${event.model}.`); }
          if (event.type === "request_completed") console.log(`Request ${event.call} completed.`);
          workspace.event(event);
        } });
      const result = await createProject(workspace, session, {
      signal: controller.signal,
      retryPlanning: values["retry-planning"],
      approveReviewRetry: values["approve-review-retry"],
      log: console.log,
      produce: (proj, sess, opts) => dispatchParallelSwarm(proj, sess, { concurrency: 3, ...opts })
    });
      console.log(`Status: ${result.status || (result.passed ? "ready_for_human_review" : "paused")}`);
      if (result.assembly?.file) console.log(`Output: ${result.assembly.file}`);
    } finally { clearTimeout(deadline); release(); process.removeListener("SIGINT", cancel); }
    return;
  }
  if (command === "sync-skills") { console.log(JSON.stringify(await syncSkills())); return; }
  if (command === "project-demo") { console.log(JSON.stringify(await runProjectDemo({ id: values.id, width: Number(values.width || 960) }), null, 2)); return; }
  if (["project-init", "project-status", "project-render", "project-audio", "project-assemble", "project-generate", "project-resume"].includes(command)) {
    if (command === "project-init") {
      if (!values.id || !values.brief) throw new Error("project-init requires --id and --brief=<manifest.json>.");
      const path = resolve(values.brief);
      if (!path.endsWith(".json") || fs.statSync(path).size > 100000) throw new Error("Project manifest must be JSON at most 100 KB.");
      const manifest = validateProject(JSON.parse(fs.readFileSync(path, "utf8")));
      const project = new ProjectWorkspace(values.id, { create: true, manifest });
      console.log(JSON.stringify(project.status(), null, 2));
      return;
    }
    if (command === "project-generate" || command === "project-resume") {
      const live = Boolean(values.live);
      if (!live || !values["max-calls"] || !values["max-output-tokens"]) throw new Error("Project generation requires explicit --live, --max-calls and --max-output-tokens; no API call made.");
      if (!values.id) throw new Error(`${command} requires --id.`);
      let project;
      if (command === "project-generate") {
        if (!values.brief) throw new Error("project-generate requires --brief=<manifest.json>.");
        const path = resolve(values.brief);
        if (!path.endsWith(".json") || fs.statSync(path).size > 100000) throw new Error("Project manifest must be JSON at most 100 KB.");
        const manifest = validateProject(JSON.parse(fs.readFileSync(path, "utf8")));
        const limits = { maxCalls: Number(values["max-calls"]), maxOutputTokens: Number(values["max-output-tokens"]), reviewerMaxOutputTokens: Number(values["review-output-tokens"] || manifest.api_limits.reviewer_max_output_tokens) };
        if (limits.maxCalls !== manifest.api_limits.max_calls || limits.maxOutputTokens !== manifest.api_limits.max_output_tokens || limits.reviewerMaxOutputTokens !== manifest.api_limits.reviewer_max_output_tokens) throw new Error("CLI limits must match the approved manifest limits.");
        new GeminiSession({ client: null, ...limits, thinkingLevel: values.thinking });
        project = new ProjectWorkspace(values.id, { create: true, manifest, limits });
      } else {
        project = new ProjectWorkspace(values.id);
        const limits = { maxCalls: Number(values["max-calls"]), maxOutputTokens: Number(values["max-output-tokens"]), reviewerMaxOutputTokens: Number(values["review-output-tokens"] || project.manifest.api_limits.reviewer_max_output_tokens) };
        if (limits.maxCalls !== project.manifest.api_limits.max_calls || limits.maxOutputTokens !== project.manifest.api_limits.max_output_tokens || limits.reviewerMaxOutputTokens !== project.manifest.api_limits.reviewer_max_output_tokens) throw new Error("Resume limits must match the persisted approved manifest.");
        new GeminiSession({ client: null, ...limits, initialCalls: project.workspace.state.api_calls || 0, thinkingLevel: values.thinking });
      }
      const release = project.acquire();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      const deadline = setTimeout(cancel, 900000);
      deadline.unref();
      try {
        if (command === "project-resume" && values["approve-review-retry"]) approveReviewRetry(project);
        const key = credentials(process.env, join(PROJECT, ".env"));
        if (!key) throw new Error("Gemini credentials are not configured locally.");
        const { GoogleGenAI } = require("@google/genai");
        const session = new GeminiSession({ client: new GoogleGenAI({ apiKey: key }), maxCalls: project.workspace.state.limits.maxCalls,
          maxOutputTokens: project.workspace.state.limits.maxOutputTokens, reviewerMaxOutputTokens: project.workspace.state.limits.reviewerMaxOutputTokens,
          initialCalls: project.workspace.state.api_calls || 0, signal: controller.signal, reserveReviewer: false,
          timeoutMs: Number(values["max-output-tokens"]) > 16384 ? 900000 : 120000,
          onEvent(event) {
            if (event.type === "request_started") { project.workspace.state.api_calls = event.call; project.workspace.save(); }
            project.workspace.event(event);
            console.log(JSON.stringify(event));
          } });
        const tools = makeProjectTools(project, session, { signal: controller.signal });
        console.log(JSON.stringify(await runProjectAgent(project, session, { signal: controller.signal, tools }), null, 2));
      } finally { clearTimeout(deadline); release(); process.removeListener("SIGINT", cancel); }
      return;
    }
    if (!values.id) throw new Error(`${command} requires --id.`);
    const project = new ProjectWorkspace(values.id);
    if (command === "project-status") {
      const release = project.acquire();
      try { console.log(JSON.stringify(project.status(), null, 2)); } finally { release(); }
      return;
    }
    if (command === "project-audio") {
      if (!values.audio) throw new Error("project-audio requires --audio=<local audio file>.");
      const release = project.acquire();
      try { console.log(JSON.stringify(await project.importAudio(values.audio), null, 2)); } finally { release(); }
      return;
    }
    if (command === "project-render") {
      if (!values.scene) throw new Error("project-render requires --scene=<scene-id>.");
      const release = project.acquire();
      try {
        const scene = project.scene(values.scene);
        const width = Number(values.width || project.manifest.frame.width);
        const verification = await verifyScene(scene, { width });
        if (!verification.passed) throw new Error("Scene verification failed; inspect its verification artifact.");
        const preview = await renderPreview(scene, { width, fps: project.manifest.frame.fps });
        console.log(JSON.stringify({ scene: values.scene, verification_passed: true, preview, flash_reviewed: false, status: "local_preview_only" }, null, 2));
      } finally { release(); }
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    const release = project.acquire();
    try { console.log(JSON.stringify(await assembleProject(project, { signal: controller.signal, allowUnreviewed: values["local-only"] }), null, 2)); }
    finally { release(); process.removeListener("SIGINT", cancel); }
    return;
  }
  if (command === "status") {
    if (!values.id) throw new Error("status requires --id.");
    const workspace = new Workspace(values.id);
    console.log(JSON.stringify({ id: workspace.id, state: workspace.state, gate: workspace.gate() }, null, 2));
    return;
  }
  if (!["demo", "generate", "resume"].includes(command)) throw new Error("Unknown command.");
  const live = command !== "demo";
  let limits;
  if (live) {
    if (!values.live || !values["max-calls"] || !values["max-output-tokens"]) {
      throw new Error("Generation requires explicit --live, --max-calls and --max-output-tokens; no API call made.");
    }
    limits = { maxCalls: Number(values["max-calls"]), maxOutputTokens: Number(values["max-output-tokens"]),
      reviewerMaxOutputTokens: Number(values["review-output-tokens"] || Math.min(Number(values["max-output-tokens"]), 8192)) };
    // Validate limits without creating a workspace or touching credentials.
    new GeminiSession({ client: null, ...limits, thinkingLevel: values.thinking });
    readSkill("engine");
    readSkill("style-line");
  }
  let brief = demo.brief;
  if (values.brief) {
    const path = resolve(values.brief);
    if (!path.endsWith(".json") || fs.statSync(path).size > 12000) throw new Error("Brief must be a JSON file at most 12 KB.");
    brief = JSON.parse(fs.readFileSync(path, "utf8"));
  }
  validateBrief(brief);
  if (values.style) brief = validateBrief({ ...brief, style: values.style });
  if (command === "resume" && values.style) throw new Error("Choose a style on a new run; resume preserves its approved brief.");
  if (command === "resume" && !values.id) throw new Error("resume requires --id.");
  const id = values.id || `${live ? "scene" : "demo"}-${randomUUID().slice(0, 8)}`;
  const workspace = new Workspace(id, { create: command !== "resume", brief, limits: limits || null });
  console.log(JSON.stringify({ run: id, command, style: JSON.parse(workspace.read("brief.json")).style }));
  const release = workspace.acquire();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  const timer = setTimeout(cancel, 900000);
  timer.unref();
  try {
    if (command === "resume") applyResumeLimits(workspace, limits, values["approve-output-increase"], values["approve-request-increase"]);
    if (!live) {
      workspace.writeScene(brief.style === "risograph" ? risoDemo.source : demo.source);
      const verification = await verifyScene(workspace, { signal: controller.signal });
      if (!verification.passed) throw new Error("Offline demo verification failed; inspect the saved verification artifact.");
      await renderPreview(workspace, { signal: controller.signal, width: Number(values.width || 540) });
      workspace.state.status = "local_preview_only";
      workspace.save();
      console.log(JSON.stringify({ id, origin: "hand-authored plumbing fixture", api_calls: 0,
        verification_passed: true, preview: join(workspace.artifactDir(), "preview.mp4"), flash_reviewed: false }));
      return;
    }
    const key = credentials(process.env, join(PROJECT, ".env"));
    if (!key) throw new Error("Gemini credentials are not configured locally.");
    const { GoogleGenAI } = require("@google/genai");
    const session = new GeminiSession({ client: new GoogleGenAI({ apiKey: key }), ...limits,
      initialCalls: workspace.state.api_calls, signal: controller.signal, thinkingLevel: values.thinking, reserveReviewer: true,
      timeoutMs: limits.maxOutputTokens > 16384 ? 900000 : 120000,
      onEvent(event) {
        if (event.type === "request_started") { workspace.state.api_calls = event.call; workspace.save(); }
        workspace.event(event);
        console.log(JSON.stringify(event));
      } });
    const gate = await runAgent(workspace, session, { signal: controller.signal, autoPipeline: true });
    console.log(JSON.stringify({ id, ...gate, preview: join(workspace.artifactDir(), "preview.mp4") }));
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    release();
  }
}

if (require.main === module) main().catch((error) => {
  const message = error.message || "Harness operation failed.";
  console.error(message.replace(/AIza[\w-]+/g, "[REDACTED]"));
  process.exitCode = 1;
});

module.exports = { main, validateBrief, applyResumeLimits, shellQuote };
