const fs = require("node:fs");
const { join } = require("node:path");
const { RUNS } = require("../harness/workspace");

const FINISHED = new Set(["ready_for_human_review", "needs_audiovisual_review"]);
const MAX_REQUESTS_SHOWN = 60;

function readJson(path, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
}

function readEvents(path) {
  try {
    return fs.readFileSync(path, "utf8").trim().split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

function lastLogLine(path) {
  try { return fs.readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).at(-1) || null; } catch { return null; }
}

function agentFor(model = "") {
  return /flash/i.test(model) ? "Flash" : /argon/i.test(model) ? "Argon" : model || "Model";
}

// One row per Gemini request, merged from its started/completed/failed events.
function requestTimeline(events) {
  const byCall = new Map();
  for (const event of events) {
    if (!["request_started", "request_completed", "request_failed"].includes(event.type) || !Number.isInteger(event.call)) continue;
    const row = byCall.get(event.call) || { call: event.call, agent: agentFor(event.model), model: event.model, status: "running", startedAt: null };
    if (event.type === "request_started") row.startedAt = event.at;
    else {
      row.status = event.type === "request_completed" ? "done" : "failed";
      row.finishedAt = event.at;
      row.elapsedMs = event.elapsed_ms ?? null;
      if (event.usage) row.tokens = event.usage.total_tokens ?? null;
      if (event.type === "request_failed") row.error = event.http_status ? `HTTP ${event.http_status}` : event.error_type || "failed";
    }
    byCall.set(event.call, row);
  }
  return [...byCall.values()].sort((a, b) => b.call - a.call).slice(0, MAX_REQUESTS_SHOWN);
}

function stage(record) {
  if (!record) return { status: "pending", attempts: 0 };
  const out = { status: record.status || "pending", attempts: record.attempts || 0 };
  if (record.error) out.error = String(record.error).slice(0, 300);
  const warnings = [...new Set((record.result?.samples || []).flatMap((sample) => [...(sample.warnings || []), ...(sample.density_warnings || [])]))];
  if (warnings.length) out.warnings = warnings.slice(0, 3);
  if (record.result?.source_defect) out.warnings = [record.result.source_defect.evidence.slice(0, 300)];
  return out;
}

function sceneProgress(projectRoot, spec) {
  const state = readJson(join(projectRoot, "scenes", spec.id, "state.json"));
  const pipeline = state.project_pipeline || {};
  const written = Boolean(state.revisions) || fs.existsSync(join(projectRoot, "scenes", spec.id, "scene.js"));
  const review = state.review || null;
  return {
    id: spec.id,
    order: spec.order,
    duration: spec.duration,
    status: state.status || "pending",
    stages: {
      write: { status: written ? "passed" : "pending", attempts: state.revisions || 0 },
      verify: stage(pipeline.verification),
      render: stage(pipeline.rendering),
      review: review
        ? { status: review.passed === false ? "invalid" : "passed", attempts: pipeline.review?.attempts || 1, findings: (review.findings || []).length }
        : stage(pipeline.review)
    }
  };
}

function reviewRetryEligible(state) {
  return Object.values(state.review_attempts || {}).some((entry) =>
    ["uncertain", "failed"].includes(entry.status) && entry.attempts === 1 && !entry.approved_retry);
}

function buildProgress(id, { job = null, runs = RUNS } = {}) {
  const root = join(runs, "projects", id);
  if (!fs.existsSync(root)) return null;
  const state = readJson(join(root, "state.json"));
  const manifest = readJson(join(root, "project.json"), null);
  const topic = readJson(join(root, "topic.json"), null);
  const events = readEvents(join(root, "events.jsonl"));
  const running = Boolean(job?.running);
  const status = state.status || "research_pending";
  const used = state.api_calls || 0;
  const limit = state.limits?.maxCalls || 0;
  const bootstrap = state.bootstrap || {};
  const phase = (record, done) => ({ status: done ? "passed" : record?.status === "validated" ? "passed" : record?.attempts ? "running" : "pending", attempts: record?.attempts || 0 });

  const scenes = (manifest?.scenes || []).slice().sort((a, b) => a.order - b.order).map((spec) => sceneProgress(root, spec));
  const failedRequest = events.filter((event) => event.type === "request_failed").at(-1);
  const stopped = !running && !FINISHED.has(status);

  return {
    id,
    status,
    running,
    job,
    budget: { used, limit, remaining: Math.max(0, limit - used) },
    phases: {
      research: phase(bootstrap.research, fs.existsSync(join(root, "research.json"))),
      planning: phase(bootstrap.planning, Boolean(manifest)),
      narration: { status: state.audio_pregenerated ? "passed" : "pending", attempts: 0 },
      assembly: { status: FINISHED.has(status) ? "passed" : "pending", attempts: 0 }
    },
    scenes,
    requests: requestTimeline(events),
    stop: stopped ? {
      reason: lastLogLine(join(root, "generation.log")) || (failedRequest ? `Request ${failedRequest.call} failed (${failedRequest.http_status ? `HTTP ${failedRequest.http_status}` : failedRequest.error_type || "error"})` : null),
      budgetExhausted: limit > 0 && used >= limit,
      reviewRetryEligible: reviewRetryEligible(state),
      resumable: Boolean(topic)
    } : null
  };
}

module.exports = { buildProgress, requestTimeline };
