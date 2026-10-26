const fs = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { Workspace, PROJECT, RUNS, atomicWrite, noSymlinks, digest } = require("./workspace");

const STYLES = new Set(["line", "watercolor", "risograph"]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const finite = (value) => Number.isFinite(value);
const FONT_FAMILIES = new Set(["Arial", "Georgia", "Trebuchet MS", "Verdana", "Helvetica", "Times New Roman", "Courier New"]);
function validateTypography(typography) {
  return Boolean(typography && FONT_FAMILIES.has(typography.font_family) &&
    [400, 500, 600, 700, 800, 900].includes(typography.font_weight) &&
    Number.isInteger(typography.label_size) && typography.label_size >= 24 && typography.label_size <= 96);
}
function validateAnchor(anchor, label = "anchor") {
  if (anchor === undefined || anchor === null) return true;
  if (typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new Error(`Invalid ${label}: must be an object with spatial/velocity handoff coordinates.`);
  }
  const numericKeys = ["x", "y", "vx", "vy", "v", "r", "scale", "alpha", "rotation"];
  for (const key of numericKeys) {
    if (anchor[key] !== undefined && !finite(anchor[key])) {
      throw new Error(`Invalid ${label}: ${key} must be a finite number.`);
    }
  }
  const vecKeys = ["position", "velocity"];
  for (const key of vecKeys) {
    if (anchor[key] !== undefined && (!Array.isArray(anchor[key]) || anchor[key].length !== 2 || !anchor[key].every(finite))) {
      throw new Error(`Invalid ${label}: ${key} must be a [x, y] pair of finite numbers.`);
    }
  }
  const stringKeys = ["object", "focal_object", "id", "color", "active_color", "state", "visual_state", "description", "label"];
  for (const key of stringKeys) {
    if (anchor[key] !== undefined && (typeof anchor[key] !== "string" || !anchor[key].trim())) {
      throw new Error(`Invalid ${label}: ${key} must be a non-empty string.`);
    }
  }
  return true;
}
const FAILURE_COVERAGE = Object.freeze([
  { failure: "spline corner loops", status: "implemented", intervention: "drawing adapter densifies and normalizes closed paths" },
  { failure: "text overlap and overflow", status: "implemented", intervention: "sampled-frame geometry bounds" },
  { failure: "prose overload", status: "experimental_heuristic", intervention: "configurable density telemetry and gate" },
  { failure: "mathematical shading errors", status: "partial", intervention: "shared claim ledger; no general image-to-math invariant" },
  { failure: "defects between stills", status: "partial", intervention: "four-phase deterministic samples; targeted clip review remains deferred" },
  { failure: "narration crowding", status: "partial", intervention: "manifest rejects overlaps with observation windows; speech timing analysis remains deferred" },
  { failure: "cross-scene numerical drift", status: "partial", intervention: "scenes receive canonical claims; generated diagram values are not statically constrained" },
  { failure: "token truncation", status: "implemented", intervention: "incomplete interactions fail closed and request limits persist" },
  { failure: "coordination calls consuming budget", status: "implemented", intervention: "scene writes trigger verification, rendering and review automatically" },
  { failure: "Flash review capacity consumed by planning", status: "implemented", intervention: "lead requests reserve one request for every unreviewed scene" }
]);

function validateProject(manifest, { demo = false } = {}) {
  if (demo && typeof manifest?.art_direction?.typography === "string") {
    manifest.art_direction.typography = { font_family: "Arial", font_weight: 700, label_size: 48 };
  }
  const duration = manifest?.target_duration;
  const frame = manifest?.frame;
  if (!manifest || typeof manifest.title !== "string" || !manifest.title.trim() ||
      typeof manifest.audience !== "string" || !manifest.audience.trim() ||
      typeof manifest.takeaway !== "string" || !manifest.takeaway.trim() ||
      !finite(duration) || (demo ? duration <= 0 || duration > 300 : duration < 10 || duration > 300) ||
      !frame || ![640, 720, 960, 1080, 1280, 1920].includes(frame.width) || !Number.isInteger(frame.height) || frame.height < 360 || frame.height > 2160 || frame.height % 2 !== 0 ||
      frame.width * frame.height > 8_294_400 || ![12, 24, 30].includes(frame.fps) ||
      !manifest.art_direction || !STYLES.has(manifest.art_direction.style) ||
      !manifest.art_direction.palette || typeof manifest.art_direction.palette !== "object" || Array.isArray(manifest.art_direction.palette) ||
      !validateTypography(manifest.art_direction.typography) ||
      !Array.isArray(manifest.art_direction.recurring_objects) || !Array.isArray(manifest.art_direction.capabilities) ||
      !Array.isArray(manifest.sources) || !Array.isArray(manifest.claims) || !Array.isArray(manifest.scenes) ||
      manifest.scenes.length < 1 || manifest.scenes.length > 24 || JSON.stringify(manifest).length > 100000) {
    throw new Error("Invalid project manifest: provide bounded configurable frame dimensions, a 120–300 second target, art direction, sources, claims and scenes.");
  }
  if (!demo && (!manifest.api_limits || !Number.isInteger(manifest.api_limits.max_calls) || manifest.api_limits.max_calls < 1 || manifest.api_limits.max_calls > 32 ||
      !Number.isInteger(manifest.api_limits.max_output_tokens) || manifest.api_limits.max_output_tokens < 512 || manifest.api_limits.max_output_tokens > 65536 ||
      !Number.isInteger(manifest.api_limits.reviewer_max_output_tokens) || manifest.api_limits.reviewer_max_output_tokens < 512 || manifest.api_limits.reviewer_max_output_tokens > 8192)) {
    throw new Error("Production projects need explicit bounded Argon and Flash API limits.");
  }
  if (!demo && manifest.api_limits.max_calls < 2 * manifest.scenes.length + 1) throw new Error("Approved API request limit must allow a scene-authoring request and Flash review per scene, plus final assembly.");
  const ids = new Set();
  let total = 0;
  for (const [order, scene] of manifest.scenes.entries()) {
    if (!scene || typeof scene.id !== "string" || !ID.test(scene.id) || ids.has(scene.id) ||
        !Number.isInteger(scene.order) || scene.order !== order || !finite(scene.duration) || scene.duration <= 0 ||
        !["cut"].includes(scene.transition || "cut") || Math.abs(scene.duration * frame.fps - Math.round(scene.duration * frame.fps)) > 1e-6) throw new Error("Scenes need unique safe IDs, contiguous order, frame-aligned duration and supported cut transitions.");
    ids.add(scene.id);
    total += scene.duration;
  }
  if (!demo && Math.abs(total - duration) > 1 / frame.fps) throw new Error("Scene durations must sum to the project target duration.");
  if (demo && Math.abs(total - duration) > 1 / frame.fps) throw new Error("Demo scene durations must sum to target_duration.");
  const sourceIds = new Set(manifest.sources.map((source) => source?.id));
  if (sourceIds.size !== manifest.sources.length || manifest.sources.some((s) => typeof s.id !== "string" || typeof s.location !== "string" || typeof s.evidence !== "string")) {
    throw new Error("Sources need unique IDs, a location and supporting evidence.");
  }
  const claimIds = new Set();
  for (const claim of manifest.claims) {
    if (!claim || typeof claim.id !== "string" || claimIds.has(claim.id) || !Array.isArray(claim.source_ids) ||
        !claim.source_ids.length || claim.source_ids.some((id) => !sourceIds.has(id)) ||
        typeof claim.evidence !== "string" || !claim.evidence.trim() || typeof claim.uncertainty !== "string" ||
        typeof claim.simplification !== "string") throw new Error("Claims need evidence, uncertainty, simplification and valid source references.");
    claimIds.add(claim.id);
  }
  const claimRef = new Set(claimIds);
  for (const [idx, scene] of manifest.scenes.entries()) {
    if (scene.claim_ids && (!Array.isArray(scene.claim_ids) || scene.claim_ids.some((id) => !claimRef.has(id)))) throw new Error(`Scene ${scene.id} references an unknown claim.`);
    validateAnchor(scene.entry_anchor, `scene ${scene.id} entry_anchor`);
    validateAnchor(scene.exit_anchor, `scene ${scene.id} exit_anchor`);
    if (idx > 0) {
      const prev = manifest.scenes[idx - 1];
      if (prev.exit_anchor && scene.entry_anchor && !scene.entry_anchor.allow_jump) {
        const prevObj = prev.exit_anchor.focal_object || prev.exit_anchor.object;
        const currObj = scene.entry_anchor.focal_object || scene.entry_anchor.object;
        if (prevObj && currObj && prevObj !== currObj) {
          throw new Error(`Scene ${scene.id} entry_anchor focal_object (${currObj}) does not match previous scene ${prev.id} exit_anchor (${prevObj}).`);
        }
        const prevColor = prev.exit_anchor.active_color || prev.exit_anchor.color;
        const currColor = scene.entry_anchor.active_color || scene.entry_anchor.color;
        if (prevColor && currColor && prevColor !== currColor) {
          throw new Error(`Scene ${scene.id} entry_anchor active_color (${currColor}) does not match previous scene ${prev.id} exit_anchor (${prevColor}).`);
        }
        const prevX = Array.isArray(prev.exit_anchor.position) ? prev.exit_anchor.position[0] : prev.exit_anchor.x;
        const currX = Array.isArray(scene.entry_anchor.position) ? scene.entry_anchor.position[0] : scene.entry_anchor.x;
        const prevY = Array.isArray(prev.exit_anchor.position) ? prev.exit_anchor.position[1] : prev.exit_anchor.y;
        const currY = Array.isArray(scene.entry_anchor.position) ? scene.entry_anchor.position[1] : scene.entry_anchor.y;
        if (finite(prevX) && finite(currX) && Math.abs(prevX - currX) > 1e-3) {
          throw new Error(`Scene ${scene.id} entry_anchor x (${currX}) does not match previous scene ${prev.id} exit_anchor x (${prevX}).`);
        }
        if (finite(prevY) && finite(currY) && Math.abs(prevY - currY) > 1e-3) {
          throw new Error(`Scene ${scene.id} entry_anchor y (${currY}) does not match previous scene ${prev.id} exit_anchor y (${prevY}).`);
        }
      }
    }
    sceneGeometry(manifest, scene);
  }
  const narration = manifest.narration || [];
  const observations = manifest.observation_windows || [];
  for (const spoken of narration) for (const beat of observations) {
    if (spoken.scene_id === beat.scene_id && spoken.start < beat.end && beat.start < spoken.end) throw new Error("Narration overlaps an intentional observation window.");
  }
  for (const caption of manifest.captions || []) {
    if (typeof caption.text !== "string" || !caption.text.trim() || caption.text.length > 500) throw new Error("Caption timeline entries need text of at most 500 characters.");
  }
  for (const caption of manifest.captions || []) for (const beat of observations) {
    if (caption.scene_id === beat.scene_id && caption.start < beat.end && beat.start < caption.end) throw new Error("Captions overlap an intentional observation window.");
  }
  for (const interval of [...(manifest.narration || []), ...(manifest.observation_windows || []), ...(manifest.captions || [])]) {
    if (!interval || !ids.has(interval.scene_id) || !finite(interval.start) || !finite(interval.end) || interval.start < 0 || interval.end <= interval.start) {
      throw new Error("Narration, caption and observation intervals need valid scene-local times.");
    }
    const scene = manifest.scenes.find((item) => item.id === interval.scene_id);
    if (interval.end > scene.duration) throw new Error("Timeline interval exceeds its scene duration.");
  }
  if (manifest.density_policy && (!finite(manifest.density_policy.maxWords) || manifest.density_policy.maxWords < 0 ||
      !finite(manifest.density_policy.maxLongBlocks) || manifest.density_policy.maxLongBlocks < 0)) throw new Error("Density thresholds must be finite nonnegative values.");
  return manifest;
}

function sceneBrief(manifest, scene) {
  const claims = new Set(scene.claim_ids || []);
  const geometry = sceneGeometry(manifest, scene);
  return {
    topic: manifest.title, audience: manifest.audience, takeaway: manifest.takeaway,
    style: manifest.art_direction.style, duration: scene.duration,
    facts: manifest.claims.filter((claim) => !claims.size || claims.has(claim.id)),
    sources: manifest.sources, art_direction: manifest.art_direction,
    frame: manifest.frame, palette: manifest.art_direction.palette, typography: manifest.art_direction.typography,
    ...geometry,
    density_policy: manifest.density_policy || { maxWords: 30, maxLongBlocks: 2 },
    narration: (manifest.narration || []).filter((entry) => entry.scene_id === scene.id),
    captions: (manifest.captions || []).filter((entry) => entry.scene_id === scene.id),
    observation_windows: (manifest.observation_windows || []).filter((entry) => entry.scene_id === scene.id),
    ...(scene.entry_anchor ? { entry_anchor: scene.entry_anchor } : {}),
    ...(scene.exit_anchor ? { exit_anchor: scene.exit_anchor } : {}),
    ...(scene.audio ? { audio: scene.audio } : {}),
    ...(scene.subtitles_srt ? { subtitles_srt: scene.subtitles_srt } : {}),
    ...(scene.subtitles_vtt ? { subtitles_vtt: scene.subtitles_vtt } : {}),
    ...(scene.subtitles ? { subtitles: scene.subtitles } : {}),
    ...(scene.measured_audio_duration !== undefined ? { measured_audio_duration: scene.measured_audio_duration } : {}),
    ...(scene.timing ? { timing: scene.timing } : {}),
    scene: {
      id: scene.id,
      order: scene.order,
      purpose: scene.purpose || "Explain one part of the takeaway.",
      transition: scene.transition || "cut",
      ...(scene.entry_anchor ? { entry_anchor: scene.entry_anchor } : {}),
      ...(scene.exit_anchor ? { exit_anchor: scene.exit_anchor } : {})
    }
  };
}

function sceneGeometry(manifest, scene) {
  const logicalWidth = scene.logical_width === undefined ? 1080 : scene.logical_width;
  const logicalHeight = scene.logical_height === undefined ? logicalWidth * manifest.frame.height / manifest.frame.width : scene.logical_height;
  if (!finite(logicalWidth) || !finite(logicalHeight) || logicalWidth <= 0 || logicalHeight <= 0 ||
      Math.abs(logicalWidth / logicalHeight - manifest.frame.width / manifest.frame.height) > 0.002) {
    throw new Error(`Scene ${scene.id} has invalid logical dimensions or an aspect ratio that differs from the project frame.`);
  }
  const safe = scene.safe_region === undefined ? { left: logicalWidth * 0.05, top: logicalHeight * 0.05, right: logicalWidth * 0.95, bottom: logicalHeight * 0.95 } : scene.safe_region;
  if (!safe || !["left", "top", "right", "bottom"].every((key) => finite(safe[key])) ||
      safe.left < 0 || safe.top < 0 || safe.right > logicalWidth || safe.bottom > logicalHeight ||
      safe.left >= safe.right || safe.top >= safe.bottom) throw new Error(`Scene ${scene.id} has an invalid safe region.`);
  return { logical_width: logicalWidth, logical_height: logicalHeight, safe_region: safe };
}

class ProjectWorkspace {
  constructor(id, { create = false, manifest, limits, demo = false } = {}) {
    if (!ID.test(id)) throw new Error("Invalid project ID.");
    if (create) validateProject(manifest, { demo });
    this.id = id;
    this.workspace = new Workspace(id, { create, base: join(RUNS, "projects"), brief: create ? {
      topic: manifest?.title || "Project", audience: manifest?.audience || "", takeaway: manifest?.takeaway || "",
      duration: Math.min(15, Math.max(10, manifest?.target_duration || 10)), style: manifest?.art_direction?.style || "line", facts: [], sources: []
    } : undefined, limits: create ? (limits || {
      maxCalls: manifest.api_limits?.max_calls, maxOutputTokens: manifest.api_limits?.max_output_tokens,
      reviewerMaxOutputTokens: manifest.api_limits?.reviewer_max_output_tokens
    }) : undefined });
    this.root = this.workspace.root;
    if (create) {
      this.workspace.write("project.json", JSON.stringify(manifest, null, 2));
      this.workspace.state.project_version = 1;
      this.workspace.state.project_demo = demo;
      this.workspace.state.assembly = null;
      this.workspace.state.api_calls = 0;
      this.workspace.save();
    }
    const persistedManifest = JSON.parse(this.workspace.read("project.json"));
    const legacyTypography = this.workspace.state.project_demo && typeof persistedManifest.art_direction?.typography === "string";
    this.manifest = validateProject(persistedManifest, { demo: Boolean(this.workspace.state.project_demo) });
    if (legacyTypography) {
      this.workspace.write("project.json", JSON.stringify(this.manifest, null, 2));
      this.workspace.state.assembly = null;
      this.workspace.event({ type: "project_manifest_migrated", from: 1, to: 2, change: "typography contract" });
      this.workspace.save();
    }
  }

  scene(sceneId) {
    const scene = this.manifest.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error("Unknown scene ID.");
    const base = join(this.root, "scenes");
    const brief = sceneBrief(this.manifest, scene);
    const childId = scene.id;
    const childRoot = join(base, childId);
    const child = new Workspace(childId, { base, create: !fs.existsSync(join(childRoot, "state.json")), brief,
      limits: this.workspace.state.limits });
    if (JSON.stringify(JSON.parse(child.read("brief.json"))) !== JSON.stringify(brief)) {
      child.write("brief.json", JSON.stringify(brief));
      child.state.verification = child.state.preview = child.state.review = null;
      child.save();
    }
    return child;
  }

  scenes() { return [...this.manifest.scenes].sort((a, b) => a.order - b.order).map((scene) => this.scene(scene.id)); }
  hashes() { return this.scenes().map((scene) => {
    let hash = null;
    try { hash = scene.sceneHash(); } catch { /* Scene is not authored yet. */ }
    return { id: scene.id, hash, preview: scene.state.preview?.hash || null };
  }); }
  assemblyHash() {
    const audio = this.workspace.state.audio || null;
    if (audio) {
      if (!/^audio\/narration\.(wav|mp3|m4a|aac|flac|ogg)$/.test(audio.file)) throw new Error("Persisted audio path is invalid.");
      const path = noSymlinks(PROJECT, join(this.root, audio.file));
      if (digest(fs.readFileSync(path)) !== audio.hash) throw new Error("Supplied audio changed after import; reimport it before assembly.");
    }
    return digest(JSON.stringify({ manifest: this.manifest, scenes: this.hashes(), audio }));
  }

  async importAudio(sourcePath) {
    const source = require("node:path").resolve(sourcePath);
    const sourceInfo = fs.lstatSync(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1024 || sourceInfo.size > 200 * 1024 * 1024 ||
        !/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(source)) throw new Error("Supply a regular local WAV, MP3, M4A, AAC, FLAC or OGG file up to 200 MB.");
    const probe = JSON.parse(await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-show_entries", "format=duration", "-of", "json", source]));
    if (!probe.streams?.some((stream) => stream.codec_type === "audio") ||
        !Number.isFinite(Number(probe.format?.duration)) || Math.abs(Number(probe.format.duration) - this.manifest.target_duration) > 1 / this.manifest.frame.fps) {
      throw new Error("Supplied audio must contain an audio stream and match the approved project duration within one frame.");
    }
    const extension = source.slice(source.lastIndexOf(".")).toLowerCase();
    const relativeFile = `audio/narration${extension}`;
    const directory = noSymlinks(PROJECT, join(this.root, "audio"));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = noSymlinks(PROJECT, join(this.root, relativeFile));
    const temporary = noSymlinks(PROJECT, `${destination}.${require("node:crypto").randomUUID()}.tmp`);
    fs.writeFileSync(temporary, fs.readFileSync(source), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    this.workspace.state.audio = { file: relativeFile, hash: digest(fs.readFileSync(destination)), duration: Number(probe.format.duration),
      source_name: require("node:path").basename(source), verified_duration: true };
    this.workspace.state.assembly = null;
    this.workspace.save();
    return this.workspace.state.audio;
  }

  status() {
    const hash = this.assemblyHash();
    const assemblyCurrent = this.assemblyCurrent(hash);
    return { id: this.id, target_duration: this.manifest.target_duration, frame: this.manifest.frame,
      api_calls: this.workspace.state.api_calls || 0, limits: this.workspace.state.limits, status: this.workspace.state.status,
      audio: this.workspace.state.audio || null,
      failure_coverage: FAILURE_COVERAGE,
      scenes: this.scenes().map((scene) => {
        let hash = null;
        try { hash = scene.sceneHash(); } catch { /* Scene is not authored yet. */ }
        return { id: scene.id, state: scene.state.status, gate: scene.gate({ requireReview: false }), human_gate: scene.gate({ requireReview: true }),
          pipeline: scene.state.project_pipeline?.hash === hash ? scene.state.project_pipeline : null,
          review_attempt: hash ? this.workspace.state.review_attempts?.[`${scene.id}:${hash}`] || null : null,
          reviewed: Boolean(hash && scene.state.review?.hash === hash) };
      }),
      assembly: assemblyCurrent ? this.workspace.state.assembly : null,
      assembly_stale: Boolean(this.workspace.state.assembly && !assemblyCurrent) };
  }

  assemblyCurrent(hash = this.assemblyHash()) {
    const assembly = this.workspace.state.assembly;
    if (!assembly || assembly.hash !== hash || typeof assembly.file !== "string" || typeof assembly.output_hash !== "string") return false;
    try {
      const output = noSymlinks(PROJECT, assembly.file);
      const rel = require("node:path").relative(this.root, output);
      if (rel === ".." || rel.startsWith(`..${require("node:path").sep}`) || !fs.statSync(output).isFile()) return false;
      return fs.statSync(output).size > 0 && digest(fs.readFileSync(output)) === assembly.output_hash;
    } catch { return false; }
  }

  acquire() { return this.workspace.acquire(); }
}

function run(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH }, signal, timeout: 180000 });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 64000) child.kill(); });
    child.on("error", () => reject(new Error("FFmpeg/FFprobe assembly command failed or was cancelled.")));
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error("Project assembly failed.")));
  });
}

async function assembleProject(project, { signal, allowUnreviewed = false } = {}) {
  const settings = project.manifest.frame;
  const scenes = project.scenes();
  if (scenes.some((scene) => !scene.state.preview || scene.state.preview.hash !== scene.sceneHash() ||
      scene.state.preview.width !== settings.width || scene.state.preview.height !== settings.height ||
      (scene.state.review?.hash !== scene.sceneHash() && !allowUnreviewed))) {
    throw new Error("Every scene needs a current rendered preview and, unless local-only assembly was selected, a current Flash review.");
  }
  for (const scene of scenes) {
    const gate = scene.gate({ requireReview: !allowUnreviewed });
    if (!gate.passed) throw new Error(`Scene ${scene.id} is not ready: ${gate.reason}`);
  }
  const hash = project.assemblyHash();
  const outputDir = noSymlinks(PROJECT, join(project.root, "artifacts", hash));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const concat = noSymlinks(PROJECT, join(outputDir, "concat.txt"));
  const files = scenes.map((scene) => noSymlinks(PROJECT, join(scene.artifactDir(), "preview.mp4")));
  atomicWrite(concat, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  const output = noSymlinks(PROJECT, join(outputDir, "project.mp4"));
  const temporary = noSymlinks(PROJECT, join(outputDir, "project.tmp.mp4"));
  const audio = project.workspace.state.audio;
  const visualReviews = scenes.every((scene) => scene.gate({ requireReview: true }).passed);
  const command = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat];
  if (audio) command.push("-i", noSymlinks(PROJECT, join(project.root, audio.file)));
  command.push("-map", "0:v:0");
  if (audio) command.push("-map", "1:a:0");
  command.push("-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p");
  if (audio) command.push("-c:a", "aac", "-af", `apad,atrim=0:${project.manifest.target_duration}`);
  command.push("-t", String(project.manifest.target_duration), temporary);
  await run(command, signal);
  const probe = JSON.parse(await run(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,nb_read_frames", "-show_entries", "format=duration", "-of", "json", temporary], signal));
  const stream = probe.streams?.find((item) => item.codec_type === "video") || probe.streams?.[0];
  const frameCount = Math.round(project.manifest.target_duration * settings.fps);
  if (!stream || stream.width !== settings.width || stream.height !== settings.height || Number(stream.nb_read_frames) !== frameCount ||
      (audio && !probe.streams.some((item) => item.codec_type === "audio")) ||
      Math.abs(Number(probe.format?.duration) - project.manifest.target_duration) > 1 / settings.fps) throw new Error("Assembled video failed dimension, frame-count or duration validation.");
  fs.renameSync(temporary, output);
  project.workspace.state.assembly = { hash, file: output, width: settings.width, height: settings.height,
    fps: settings.fps, duration: project.manifest.target_duration, frame_count: frameCount,
    output_hash: digest(fs.readFileSync(output)), audio: Boolean(audio), visual_scene_reviews: visualReviews,
    audiovisual_review: audio ? false : null,
    status: allowUnreviewed ? "local_preview_only" : audio ? "needs_audiovisual_review" : "ready_for_human_review",
    reviewed: !allowUnreviewed && !audio };
  project.workspace.save();
  return project.workspace.state.assembly;
}

module.exports = { validateProject, validateAnchor, sceneBrief, sceneGeometry, validateTypography, FONT_FAMILIES, ProjectWorkspace, assembleProject, FAILURE_COVERAGE };
