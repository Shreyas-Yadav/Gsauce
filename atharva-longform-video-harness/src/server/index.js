const http = require("node:http");
const fs = require("node:fs");
const { join, resolve, extname, dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
const { PROJECT, RUNS, noSymlinks, atomicWrite } = require("../harness/workspace");
const { ProjectWorkspace, assembleProject } = require("../harness/project");
const { verifyScene, renderPreview, extractBoundaryClip } = require("../harness/render");
const { generateSceneAudio } = require("../harness/audio");
const { openTopic, createProject } = require("../harness/create");
const { credentials, GeminiSession, MODELS, outputText } = require("../harness/gemini");

const UI_DIR = join(PROJECT, "src/ui");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8"
};

function readJsonSafe(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch { /* ignore */ }
  return fallback;
}

function findLatestArtifactDir(rootDir) {
  const artifactsRoot = join(rootDir, "artifacts");
  if (!fs.existsSync(artifactsRoot)) return null;
  const entries = fs.readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = join(artifactsRoot, d.name);
      const stat = fs.statSync(full);
      const hasPreview = fs.existsSync(join(full, "preview.mp4")) || fs.existsSync(join(full, "project.mp4"));
      const hasFrames = fs.existsSync(join(full, "frames"));
      return { name: d.name, full, mtimeMs: stat.mtimeMs, hasPreview, hasFrames };
    })
    .sort((a, b) => (Number(b.hasPreview) - Number(a.hasPreview)) || (Number(b.hasFrames) - Number(a.hasFrames)) || (b.mtimeMs - a.mtimeMs));
  return entries[0] || null;
}

function collectSceneFrames(sceneRoot, relPrefix, fps = 24, duration = 10) {
  const latest = findLatestArtifactDir(sceneRoot);
  if (!latest) return { artifactHash: null, previewUrl: null, stills: [], frames: [], verification: null, review: null };

  const artRel = `${relPrefix}/artifacts/${latest.name}`;
  const previewUrl = fs.existsSync(join(latest.full, "preview.mp4")) ? `/media/${artRel}/preview.mp4` : null;
  const verification = readJsonSafe(join(latest.full, "verification.json"));
  let review = readJsonSafe(join(latest.full, "review-response.json"));
  if (review && typeof review.text === "string") {
    try {
      const clean = review.text.replace(/^```(?:json)?\s*\n|\n```$/g, "");
      review = JSON.parse(clean);
    } catch { /* ignore */ }
  }

  const stills = [];
  const phases = [0.15, 0.45, 0.70, 0.95];
  for (let i = 0; i < 4; i++) {
    const stillName = `still-${i}.png`;
    if (fs.existsSync(join(latest.full, stillName))) {
      const t = Number((phases[i] * duration).toFixed(2));
      stills.push({
        index: i,
        frameNumber: Math.round(t * fps),
        timestamp: t,
        url: `/media/${artRel}/${stillName}`,
        kind: "still"
      });
    }
  }

  const framesDir = join(latest.full, "frames");
  const frames = [];
  if (fs.existsSync(framesDir)) {
    const files = fs.readdirSync(framesDir)
      .filter((f) => /^f\d+\.jpg$/i.test(f))
      .sort();
    for (const file of files) {
      const num = parseInt(file.slice(1, 6), 10);
      const t = Number((num / fps).toFixed(3));
      frames.push({
        frameNumber: num,
        timestamp: t,
        file,
        url: `/media/${artRel}/frames/${file}`,
        kind: "frame"
      });
    }
  }

  return {
    artifactHash: latest.name,
    previewUrl,
    stills,
    frames: frames.length ? frames : stills,
    totalFrames: frames.length || stills.length,
    verification,
    review
  };
}

function loadProjectDetails(projectId) {
  const projectRoot = join(RUNS, "projects", projectId);
  if (!fs.existsSync(projectRoot)) return null;
  const manifest = readJsonSafe(join(projectRoot, "project.json"));
  const topic = readJsonSafe(join(projectRoot, "topic.json"), {});
  const state = readJsonSafe(join(projectRoot, "state.json"), {});
  const projectNarration = readJsonSafe(join(projectRoot, "audio/narration.json"));
  const latestProjectArt = findLatestArtifactDir(projectRoot);
  const masterVideoUrl = latestProjectArt && fs.existsSync(join(latestProjectArt.full, "project.mp4"))
    ? `/media/projects/${projectId}/artifacts/${latestProjectArt.name}/project.mp4`
    : null;

  const fps = manifest?.frame?.fps || 24;
  const scenes = [];
  let timeOffset = 0;

  for (const sceneSpec of manifest?.scenes || []) {
    const sceneRoot = join(projectRoot, "scenes", sceneSpec.id);
    const sceneState = readJsonSafe(join(sceneRoot, "state.json"), {});
    const sceneBrief = readJsonSafe(join(sceneRoot, "brief.json"), {});
    const sceneNarration = readJsonSafe(join(sceneRoot, "audio/narration.json"));
    const sceneCode = fs.existsSync(join(sceneRoot, "scene.js")) ? fs.readFileSync(join(sceneRoot, "scene.js"), "utf8") : "";
    const media = fs.existsSync(sceneRoot)
      ? collectSceneFrames(sceneRoot, `projects/${projectId}/scenes/${sceneSpec.id}`, fps, sceneSpec.duration)
      : { artifactHash: null, previewUrl: null, stills: [], frames: [], verification: null, review: null };

    const findings = sceneState.review?.findings || media.review?.findings || [];
    scenes.push({
      id: sceneSpec.id,
      order: sceneSpec.order,
      duration: sceneSpec.duration,
      startTime: Number(timeOffset.toFixed(3)),
      endTime: Number((timeOffset + sceneSpec.duration).toFixed(3)),
      purpose: sceneSpec.purpose,
      entry_anchor: sceneSpec.entry_anchor || sceneBrief.entry_anchor || null,
      exit_anchor: sceneSpec.exit_anchor || sceneBrief.exit_anchor || null,
      status: sceneState.status || "pending",
      revisions: sceneState.revisions || 0,
      code: sceneCode,
      narration: sceneNarration,
      findings,
      ...media
    });
    timeOffset += sceneSpec.duration;
  }

  // Collect boundary clips if present
  const boundariesDir = join(projectRoot, "boundaries");
  const boundaries = [];
  if (scenes.length > 1) {
    for (let i = 0; i < scenes.length - 1; i++) {
      const sA = scenes[i];
      const sB = scenes[i + 1];
      const cutFile = `cut_${sA.id}_${sB.id}.mp4`;
      const cutPath = join(boundariesDir, cutFile);
      const reviewData = readJsonSafe(join(boundariesDir, `cut_${sA.id}_${sB.id}_review.json`));
      boundaries.push({
        id: `${sA.id}->${sB.id}`,
        fromScene: sA.id,
        toScene: sB.id,
        cutTimestamp: sA.endTime,
        exists: fs.existsSync(cutPath),
        url: fs.existsSync(cutPath) ? `/media/projects/${projectId}/boundaries/${cutFile}` : null,
        review: reviewData
      });
    }
  }

  // Build unified transcript segments across project or per-scene audio
  let transcriptSegments = [];
  if (projectNarration?.segments?.length) {
    transcriptSegments = projectNarration.segments.map((seg, idx) => ({
      ...seg,
      index: idx,
      scope: "project",
      sceneId: manifest?.scenes?.[Math.min(idx, (manifest?.scenes?.length || 1) - 1)]?.id || null
    }));
  } else {
    for (const s of scenes) {
      if (s.narration?.segments?.length) {
        for (const [idx, seg] of s.narration.segments.entries()) {
          transcriptSegments.push({
            ...seg,
            index: idx,
            scope: "scene",
            sceneId: s.id,
            globalStart: Number((s.startTime + seg.start).toFixed(3)),
            globalEnd: Number((s.startTime + seg.end).toFixed(3))
          });
        }
      } else if (manifest?.narration?.length) {
        const clauses = manifest.narration.filter((n) => n.scene_id === s.id);
        for (const [idx, c] of clauses.entries()) {
          transcriptSegments.push({
            id: `${s.id}_n${idx}`,
            index: idx,
            scope: "manifest",
            sceneId: s.id,
            text: c.text,
            start: c.start,
            end: c.end,
            duration: Number((c.end - c.start).toFixed(2)),
            globalStart: Number((s.startTime + c.start).toFixed(3)),
            globalEnd: Number((s.startTime + c.end).toFixed(3))
          });
        }
      }
    }
  }

  return {
    id: projectId,
    kind: "project",
    title: manifest?.title || topic.topic || projectId,
    takeaway: manifest?.takeaway || "",
    audience: manifest?.audience || "",
    style: manifest?.art_direction?.style || topic.style || "watercolor",
    palette: manifest?.art_direction?.palette || { paper: "#FAF5E8", ink: "#002A32", accent: "#ED254E" },
    duration: manifest?.target_duration || topic.duration || 30,
    frame: manifest?.frame || { width: 1280, height: 720, fps: 24 },
    status: state.status || "planned",
    apiCalls: state.api_calls || 0,
    masterVideoUrl,
    audioUrl: fs.existsSync(join(projectRoot, "audio/master_audio.wav")) ? `/media/projects/${projectId}/audio/master_audio.wav` : null,
    contactSheetUrl: fs.existsSync(join(projectRoot, "kalman_contact_sheet.jpg")) ? `/media/projects/${projectId}/kalman_contact_sheet.jpg` : null,
    scenes,
    boundaries,
    transcript: transcriptSegments,
    annotations: readJsonSafe(join(projectRoot, "annotations.json"), [])
  };
}

function loadSingleRunDetails(runId) {
  const runRoot = join(RUNS, runId);
  if (!fs.existsSync(runRoot) || !fs.existsSync(join(runRoot, "brief.json"))) return null;
  const brief = readJsonSafe(join(runRoot, "brief.json"), {});
  const state = readJsonSafe(join(runRoot, "state.json"), {});
  const code = fs.existsSync(join(runRoot, "scene.js")) ? fs.readFileSync(join(runRoot, "scene.js"), "utf8") : "";
  const fps = brief.frame?.fps || 24;
  const duration = brief.duration || 12;
  const media = collectSceneFrames(runRoot, runId, fps, duration);

  return {
    id: runId,
    kind: "single",
    title: brief.topic || runId,
    takeaway: brief.takeaway || "",
    audience: brief.audience || "",
    style: brief.style || "line",
    palette: brief.palette || { paper: "#FAF5E8", ink: "#002A32", accent: "#ED254E" },
    duration,
    frame: brief.frame || { width: 540, height: 960, fps },
    status: state.status || "created",
    apiCalls: state.api_calls || 0,
    masterVideoUrl: media.previewUrl,
    scenes: [{
      id: runId,
      order: 0,
      duration,
      startTime: 0,
      endTime: duration,
      purpose: brief.takeaway || brief.topic || "Single scene run",
      status: state.status || "created",
      revisions: state.revisions || 0,
      code,
      findings: state.review?.findings || media.review?.findings || [],
      ...media
    }],
    boundaries: [],
    transcript: (brief.subtitles || []).map((s, idx) => ({
      id: `sub_${idx}`,
      index: idx,
      sceneId: runId,
      text: s.text,
      start: s.start,
      end: s.end,
      globalStart: s.start,
      globalEnd: s.end
    })),
    annotations: []
  };
}

function listAllCreations() {
  const items = [];
  const projectsDir = join(RUNS, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("test-")) continue;
      const details = loadProjectDetails(entry.name);
      if (details) {
        const stat = fs.statSync(join(projectsDir, entry.name));
        items.push({
          id: details.id,
          kind: "project",
          title: details.title,
          style: details.style,
          duration: details.duration,
          status: details.status,
          sceneCount: details.scenes.length,
          hasVideo: Boolean(details.masterVideoUrl || details.scenes.some((s) => s.previewUrl)),
          thumbnailUrl: details.scenes.find((s) => s.stills?.length)?.stills[0]?.url || null,
          updatedAt: stat.mtimeMs
        });
      }
    }
  }
  if (fs.existsSync(RUNS)) {
    for (const entry of fs.readdirSync(RUNS, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "projects" || entry.name.startsWith("test-")) continue;
      const details = loadSingleRunDetails(entry.name);
      if (details) {
        const stat = fs.statSync(join(RUNS, entry.name));
        items.push({
          id: details.id,
          kind: "single",
          title: details.title,
          style: details.style,
          duration: details.duration,
          status: details.status,
          sceneCount: 1,
          hasVideo: Boolean(details.masterVideoUrl),
          thumbnailUrl: details.scenes[0]?.stills?.[0]?.url || null,
          updatedAt: stat.mtimeMs
        });
      }
    }
  }
  return items.sort((a, b) => (Number(b.hasVideo) - Number(a.hasVideo)) || (b.updatedAt - a.updatedAt));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large."));
      }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveMediaFile(req, res, relPath) {
  try {
    const cleanRel = decodeURIComponent(relPath).replace(/^\/+/, "");
    const target = noSymlinks(PROJECT, resolve(RUNS, cleanRel));
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = extname(target).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const stat = fs.statSync(target);
    const range = req.headers.range;
    if (range && ext === ".mp4") {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime
      });
      fs.createReadStream(target, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(400);
    res.end(err.message);
  }
}

function applySurgicalCodeNote(existingCode, { timestamp, box, prompt }) {
  const header = `// [STUDIO SURGICAL PATCH @ t=${Number(timestamp || 0).toFixed(2)}s | region=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)}x${Math.round(box.h)}` : "full"}]: ${String(prompt).replace(/\r?\n/g, " ")}\n`;
  if (existingCode.startsWith("// [STUDIO SURGICAL PATCH")) {
    return header + existingCode.replace(/^\/\/ \[STUDIO SURGICAL PATCH[^\n]*\n/, "");
  }
  return header + existingCode;
}

function createStudioServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/api/creations") {
        return sendJson(res, 200, { creations: listAllCreations() });
      }

      if (req.method === "GET" && pathname.startsWith("/api/creations/")) {
        const id = decodeURIComponent(pathname.slice("/api/creations/".length));
        const details = loadProjectDetails(id) || loadSingleRunDetails(id);
        if (!details) return sendJson(res, 404, { error: "Creation not found." });
        return sendJson(res, 200, details);
      }

      // Extract & inspect 10s boundary slice between two scenes
      if (req.method === "POST" && /^\/api\/creations\/[^/]+\/boundary$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readBody(req);
        const project = new ProjectWorkspace(id);
        const sceneA = project.scene(body.fromScene);
        const sceneB = project.scene(body.toScene);
        const boundariesDir = join(project.root, "boundaries");
        fs.mkdirSync(boundariesDir, { recursive: true, mode: 0o700 });
        const outPath = join(boundariesDir, `cut_${sceneA.id}_${sceneB.id}.mp4`);
        const clip = await extractBoundaryClip(sceneA, sceneB, outPath);
        return sendJson(res, 200, {
          ok: true,
          clipUrl: `/media/projects/${id}/boundaries/cut_${sceneA.id}_${sceneB.id}.mp4`,
          clip
        });
      }

      // Mark-out a frame region + prompt Argon to surgically fix that scene at timestamp t
      if (req.method === "POST" && /^\/api\/creations\/[^/]+\/fix-frame$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readBody(req);
        const { sceneId, timestamp = 0, frameNumber = 0, box = null, prompt = "", codeOverride = null, rerender = false } = body;
        if (!prompt.trim() && !codeOverride) {
          return sendJson(res, 400, { error: "Provide a repair prompt or code edit." });
        }

        const isProject = fs.existsSync(join(RUNS, "projects", id));
        const sceneRoot = isProject ? join(RUNS, "projects", id, "scenes", sceneId) : join(RUNS, id);
        if (!fs.existsSync(sceneRoot)) return sendJson(res, 404, { error: "Target scene not found." });

        const currentCode = fs.existsSync(join(sceneRoot, "scene.js")) ? fs.readFileSync(join(sceneRoot, "scene.js"), "utf8") : "";
        let updatedCode = codeOverride || applySurgicalCodeNote(currentCode, { timestamp, box, prompt });

        // If live Gemini credentials exist and user requested AI surgical repair without manual codeOverride
        const key = credentials(process.env, join(PROJECT, ".env"));
        let agentUsed = false;
        if (!codeOverride && key && body.useLiveAgent) {
          try {
            const { GoogleGenAI } = require("@google/genai");
            const session = new GeminiSession({
              client: new GoogleGenAI({ apiKey: key }),
              maxCalls: 2,
              maxOutputTokens: 16384
            });
            const brief = readJsonSafe(join(sceneRoot, "brief.json"), {});
            const logicalBox = box ? {
              x: Math.round(box.x * (brief.logical_width || 1080)),
              y: Math.round(box.y * (brief.logical_height || 1920)),
              w: Math.round(box.w * (brief.logical_width || 1080)),
              h: Math.round(box.h * (brief.logical_height || 1920))
            } : null;
            const repairPrompt = `Surgical Frame Repair Request for Scene "${sceneId}" at t = ${timestamp}s (Frame #${frameNumber}).
User highlighted canvas region: ${JSON.stringify(logicalBox || "entire frame")}.
User instruction: ${JSON.stringify(prompt)}.
Adjust ONLY the visual elements around t = ${timestamp}s in this region while preserving duration=${brief.duration} and existing anchors.
Current scene.js:\n${currentCode}\nReturn ONLY the valid JavaScript function body ending in return {duration:${brief.duration},draw(ctx,t,kit){...}}.`;
            const resp = await session.create(MODELS.lead, [{ type: "user_input", content: [{ type: "text", text: repairPrompt }] }]);
            let text = outputText(resp).trim();
            const fenced = /^```(?:javascript|js)?\s*\n([\s\S]*?)\n```$/i.exec(text);
            if (fenced) text = fenced[1].trim();
            if (text.includes("draw")) {
              updatedCode = text;
              agentUsed = true;
            }
          } catch { /* fallback to local surgical patch */ }
        }

        atomicWrite(join(sceneRoot, "scene.js"), updatedCode);

        // Record annotation in project annotations ledger
        const ownerRoot = isProject ? join(RUNS, "projects", id) : sceneRoot;
        const annotationsFile = join(ownerRoot, "annotations.json");
        const annotations = readJsonSafe(annotationsFile, []);
        const entry = {
          id: `fix-${randomUUID().slice(0, 8)}`,
          at: new Date().toISOString(),
          sceneId,
          timestamp,
          frameNumber,
          box,
          prompt,
          agentUsed
        };
        annotations.unshift(entry);
        atomicWrite(annotationsFile, JSON.stringify(annotations.slice(0, 50), null, 2));

        let renderSummary = null;
        if (rerender && isProject) {
          const project = new ProjectWorkspace(id);
          const sceneWs = project.scene(sceneId);
          const ver = await verifyScene(sceneWs, { width: project.manifest.frame.width });
          if (ver.passed) {
            renderSummary = await renderPreview(sceneWs, { width: project.manifest.frame.width, fps: project.manifest.frame.fps });
          }
        }

        return sendJson(res, 200, {
          ok: true,
          annotation: entry,
          agentUsed,
          renderSummary,
          creation: loadProjectDetails(id) || loadSingleRunDetails(id)
        });
      }

      // Edit transcript clause text or pause timing & re-synthesize audio/subtitles
      if (req.method === "POST" && /^\/api\/creations\/[^/]+\/fix-audio$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readBody(req);
        const { sceneId, segmentIndex = 0, text, pauseBefore = 0.3, pauseAfter = 0.4 } = body;
        if (typeof text !== "string" || !text.trim()) {
          return sendJson(res, 400, { error: "Transcript text cannot be empty." });
        }

        const projectRoot = join(RUNS, "projects", id);
        if (!fs.existsSync(projectRoot)) return sendJson(res, 404, { error: "Project not found." });

        const targetSceneRoot = sceneId && fs.existsSync(join(projectRoot, "scenes", sceneId))
          ? join(projectRoot, "scenes", sceneId)
          : projectRoot;

        const existingNarration = readJsonSafe(join(targetSceneRoot, "audio/narration.json")) ||
          readJsonSafe(join(projectRoot, "audio/narration.json")) || { segments: [] };

        const beats = (existingNarration.segments || []).map((seg, idx) => ({
          id: seg.id || `b_${idx}`,
          text: idx === Number(segmentIndex) ? text.trim() : seg.text,
          pause_before: idx === Number(segmentIndex) ? Number(pauseBefore) : 0.25,
          pause_after: idx === Number(segmentIndex) ? Number(pauseAfter) : 0.35
        }));
        if (!beats.length) {
          beats.push({ id: "b_0", text: text.trim(), pause_before: Number(pauseBefore), pause_after: Number(pauseAfter) });
        }

        const updatedAudio = await generateSceneAudio(targetSceneRoot, sceneId || id, beats, { offline: true });
        return sendJson(res, 200, {
          ok: true,
          audio: updatedAudio,
          creation: loadProjectDetails(id)
        });
      }

      // Create a new project topic workspace
      if (req.method === "POST" && pathname === "/api/creations") {
        const body = await readBody(req);
        const topicText = (body.topic || "").trim();
        const style = body.style || "risograph";
        const duration = Number(body.duration || 120);
        const customId = body.id || `studio-${randomUUID().slice(0, 8)}`;
        const ws = openTopic(topicText, { id: customId, duration, style });
        return sendJson(res, 201, {
          ok: true,
          id: ws.id,
          creations: listAllCreations()
        });
      }

      // Serve media files from build/runs
      if (req.method === "GET" && pathname.startsWith("/media/")) {
        return serveMediaFile(req, res, pathname.slice("/media/".length));
      }

      // Serve static UI files
      const uiFile = pathname === "/" ? "index.html" : pathname.slice(1);
      const resolvedUi = resolve(UI_DIR, uiFile);
      if (resolvedUi.startsWith(UI_DIR) && fs.existsSync(resolvedUi) && fs.statSync(resolvedUi).isFile()) {
        const ext = extname(resolvedUi).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
          "Cache-Control": "no-store"
        });
        return fs.createReadStream(resolvedUi).pipe(res);
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Internal Studio Server error." });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  const server = createStudioServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Lost in Translation Studio running at http://127.0.0.1:${port}`);
  });
}

module.exports = { createStudioServer, listAllCreations, loadProjectDetails, loadSingleRunDetails };
