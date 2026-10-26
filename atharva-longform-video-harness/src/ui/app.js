const state = {
  creations: [],
  activeCreation: null,
  activeSceneId: null,
  selectedFrame: null,
  selectedTranscript: null,
  toolMode: "scrub", // "scrub" | "mark"
  viewMode: "video", // "video" | "frame"
  markBox: null, // normalized { x, y, w, h }
  selectedStyle: "risograph",
  selectedDuration: 120,
  frameStep: 12,
  poll: null // { id, timer, lastStatus }
};

const POLL_MS = 3000;

const el = (id) => document.getElementById(id);

function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 3400);
}

function fmtTime(sec) {
  const s = Math.max(0, Number(sec || 0));
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${rem}`;
}

async function fetchCreations() {
  const res = await fetch("/api/creations");
  const data = await res.json();
  state.creations = data.creations || [];
  renderCreationsMenu();
}

function renderCreationsMenu() {
  const list = el("creationsList");
  list.innerHTML = "";
  for (const item of state.creations) {
    const card = document.createElement("div");
    card.className = `creation-card ${state.activeCreation?.id === item.id ? "active" : ""}`;
    const thumbHtml = item.thumbnailUrl
      ? `<img class="creation-thumb" src="${item.thumbnailUrl}" alt="${item.id}" loading="lazy" />`
      : `<div class="creation-thumb" style="display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:10px;color:var(--red)">${item.style.slice(0, 4).toUpperCase()}</div>`;
    card.innerHTML = `
      ${thumbHtml}
      <div class="creation-meta">
        <div class="creation-name" title="${item.title}">${item.title}</div>
        <div class="creation-tags">
          <span class="tag-style">${item.style}</span>
          <span>· ${item.duration}s</span>
          <span>· ${item.sceneCount}sc</span>
        </div>
      </div>
    `;
    card.addEventListener("click", () => selectCreation(item.id));
    list.appendChild(card);
  }
}

function switchStageView(mode) {
  const isPrompt = mode === "prompt";
  el("promptComposerView").classList.toggle("hidden", !isPrompt);
  el("canvasStageView").classList.toggle("hidden", isPrompt);
  el("btnModePrompt").classList.toggle("active", isPrompt);
  el("btnModeCanvas").classList.toggle("active", !isPrompt);
}

async function selectCreation(id) {
  if (state.poll && state.poll.id !== id) stopPolling();
  const res = await fetch(`/api/creations/${encodeURIComponent(id)}`);
  if (!res.ok) return showToast("Could not load creation.");
  const details = await res.json();
  state.activeCreation = details;
  state.activeSceneId = details.scenes[0]?.id || null;
  state.selectedFrame = null;
  state.selectedTranscript = null;
  clearMarkBox();

  renderCreationsMenu();
  switchStageView("canvas");
  updateInspector();
  renderTimelineTracks();

  const firstScene = details.scenes[0];
  const videoUrl = details.masterVideoUrl || firstScene?.previewUrl || null;
  const video = el("stageVideo");
  const img = el("stageImage");

  el("stageCreationTitle").textContent = details.title;
  el("activeStatusBadge").textContent = (details.status || "READY").toUpperCase();

  if (videoUrl) {
    setMediaDisplay("video", videoUrl);
  } else if (firstScene?.frames?.length) {
    selectFrameLayer(firstScene, firstScene.frames[0]);
  }
  if (!state.poll) pollGeneration(id);
}

function statusLabel(status) {
  return String(status || "ready").replace(/_/g, " ").toUpperCase();
}

function renderGeneration(info) {
  const running = Boolean(info?.job?.running);
  el("activeStatusBadge").textContent = running ? `GENERATING · ${statusLabel(info.status)}` : statusLabel(info?.status);
  el("generationLog").textContent = running ? (info.log.at(-1) || "Starting…") : "";
  el("btnCancelGeneration").classList.toggle("hidden", !running);
}

function stopPolling() {
  if (state.poll) clearTimeout(state.poll.timer);
  state.poll = null;
  el("generationLog").textContent = "";
  el("btnCancelGeneration").classList.add("hidden");
}

async function pollGeneration(id) {
  const res = await fetch(`/api/creations/${encodeURIComponent(id)}/status`);
  if (!res.ok || state.activeCreation?.id !== id) return;
  const info = await res.json();
  renderGeneration(info);
  if (!info.job?.running) {
    if (state.poll?.id === id) {
      stopPolling();
      renderGeneration(info);
      await fetchCreations();
      await selectCreation(id);
      const failed = info.job && info.job.exitCode !== 0;
      showToast(failed ? `Generation stopped: ${info.log.at(-1) || statusLabel(info.status)}` : `Generation finished: ${statusLabel(info.status)}`);
    }
    return;
  }
  const changed = state.poll?.lastStatus !== undefined && state.poll.lastStatus !== info.status;
  state.poll = { id, lastStatus: info.status, timer: setTimeout(() => pollGeneration(id), POLL_MS) };
  if (changed) {
    await fetchCreations();
    await selectCreation(id);
    renderGeneration(info);
  }
}

async function cancelGeneration() {
  const id = state.poll?.id;
  if (!id) return;
  const res = await fetch(`/api/creations/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  const data = await res.json();
  showToast(res.ok ? "Stopping generation…" : data.error || "Could not stop generation.");
}

function setMediaDisplay(mode, srcUrl) {
  state.viewMode = mode;
  const video = el("stageVideo");
  const img = el("stageImage");
  el("btnViewVideo").classList.toggle("active", mode === "video");
  el("btnViewFrame").classList.toggle("active", mode === "frame");

  if (mode === "video") {
    img.classList.add("hidden");
    video.classList.remove("hidden");
    if (srcUrl && video.getAttribute("src") !== srcUrl) {
      video.src = srcUrl;
    }
  } else {
    video.pause();
    video.classList.add("hidden");
    img.classList.remove("hidden");
    if (srcUrl) img.src = srcUrl;
  }
}

function selectScene(sceneId) {
  if (!state.activeCreation) return;
  const scene = state.activeCreation.scenes.find((s) => s.id === sceneId);
  if (!scene) return;
  state.activeSceneId = scene.id;
  el("stageSceneBadge").textContent = `SCENE ${scene.order + 1} · ${scene.id}`;
  el("codeSceneLabel").textContent = `${scene.id} / scene.js`;
  el("sceneCodeEditor").value = scene.code || "";

  if (scene.previewUrl) {
    setMediaDisplay("video", scene.previewUrl);
  } else if (scene.frames?.length) {
    selectFrameLayer(scene, scene.frames[0]);
  }
  updateInspector();
}

function selectFrameLayer(scene, frameObj) {
  state.activeSceneId = scene.id;
  state.selectedFrame = { sceneId: scene.id, ...frameObj };
  state.selectedTranscript = null;

  el("stageSceneBadge").textContent = `SCENE ${scene.order + 1} · ${scene.id}`;
  const fStr = `f${String(frameObj.frameNumber || 0).padStart(5, "0")}`;
  el("stageFrameCounter").textContent = `${fStr} · ${fmtTime((scene.startTime || 0) + frameObj.timestamp)} (local ${frameObj.timestamp}s)`;
  el("codeSceneLabel").textContent = `${scene.id} / scene.js`;
  el("sceneCodeEditor").value = scene.code || "";

  setMediaDisplay("frame", frameObj.url);
  setToolMode("mark");

  el("surgicalTargetText").textContent = `FRAME ${fStr} @ ${frameObj.timestamp}s (${scene.id})`;
  el("surgicalPromptInput").value = "";
  el("surgicalPromptInput").placeholder = `Describe the fix at ${frameObj.timestamp}s`;
  el("btnApplyFrameFix").classList.remove("hidden");
  el("btnApplyAudioFix").classList.add("hidden");

  document.querySelectorAll(".frame-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.key === `${scene.id}:${frameObj.frameNumber}`);
  });
  document.querySelectorAll(".transcript-block").forEach((b) => b.classList.remove("selected"));
  updateInspector();
}

function selectTranscriptSegment(seg) {
  state.selectedTranscript = seg;
  if (seg.sceneId) state.activeSceneId = seg.sceneId;

  el("surgicalTargetText").textContent = `AUDIO [${fmtTime(seg.start)}–${fmtTime(seg.end)}]`;
  el("surgicalPromptInput").value = seg.text;
  el("btnApplyFrameFix").classList.add("hidden");
  el("btnApplyAudioFix").classList.remove("hidden");

  const video = el("stageVideo");
  if (!video.classList.contains("hidden")) {
    video.currentTime = seg.globalStart ?? seg.start ?? 0;
  }

  document.querySelectorAll(".transcript-block").forEach((b) => {
    b.classList.toggle("selected", b.dataset.segId === seg.id);
  });
}

function updateInspector() {
  const c = state.activeCreation;
  if (!c) return;

  const list = el("sceneCutList");
  list.innerHTML = "";
  c.scenes.forEach((scene, idx) => {
    const sDiv = document.createElement("div");
    sDiv.className = `scene-item ${scene.id === state.activeSceneId ? "active" : ""}`;
    sDiv.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:12px;">
        <span>${idx + 1}. ${scene.id}</span>
        <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--red)">${scene.duration}s · ${scene.frames?.length || 0}f</span>
      </div>
      <div style="font-size:11px;color:var(--beige-muted);margin-top:3px;">${scene.purpose || ""}</div>
    `;
    sDiv.addEventListener("click", () => selectScene(scene.id));
    list.appendChild(sDiv);

    if (idx < c.scenes.length - 1) {
      const nextScene = c.scenes[idx + 1];
      const cutDiv = document.createElement("div");
      cutDiv.className = "cut-item";
      cutDiv.innerHTML = `
        <span>CUT ${idx + 1} / ${idx + 2}</span>
        <span>INSPECT</span>
      `;
      cutDiv.addEventListener("click", () => inspectBoundaryCut(scene.id, nextScene.id));
      list.appendChild(cutDiv);
    }
  });

  const activeScene = c.scenes.find((s) => s.id === state.activeSceneId) || c.scenes[0];
  if (activeScene) {
    el("codeSceneLabel").textContent = `${activeScene.id} / scene.js`;
    if (document.activeElement !== el("sceneCodeEditor")) {
      el("sceneCodeEditor").value = activeScene.code || "";
    }
    const anchorInfo = {
      scene: activeScene.id,
      entry_anchor: activeScene.entry_anchor || { status: "open_entry" },
      exit_anchor: activeScene.exit_anchor || { status: "open_exit" }
    };
    el("anchorCard").textContent = JSON.stringify(anchorInfo, null, 2);
  }

  const findingsContainer = el("findingsList");
  findingsContainer.innerHTML = "";

  // Show user surgical patches first
  for (const patch of c.annotations || []) {
    const card = document.createElement("div");
    card.className = "finding-card patch-card";
    card.innerHTML = `
      <div class="finding-head">
        <span style="color:var(--beige)">SURGICAL PATCH · ${patch.sceneId}</span>
        <span>t=${Number(patch.timestamp || 0).toFixed(2)}s</span>
      </div>
      <div>${patch.prompt}</div>
    `;
    findingsContainer.appendChild(card);
  }

  // Show Flash findings across scenes
  let totalFindings = 0;
  for (const scene of c.scenes) {
    for (const f of scene.findings || []) {
      totalFindings++;
      const card = document.createElement("div");
      card.className = "finding-card";
      card.innerHTML = `
        <div class="finding-head">
          <span>${(f.severity || "note").toUpperCase()} · ${scene.id}</span>
          <span>t=${f.timestamp_seconds ?? f.t ?? 0}s</span>
        </div>
        <div>${f.evidence || f.issue || ""}</div>
      `;
      card.addEventListener("click", () => {
        selectScene(scene.id);
        const v = el("stageVideo");
        if (!v.classList.contains("hidden")) v.currentTime = Number(f.timestamp_seconds || 0);
      });
      findingsContainer.appendChild(card);
    }
  }

  if (!totalFindings && !(c.annotations || []).length) {
    findingsContainer.innerHTML = `<div style="font-size:11.5px;color:var(--beige-muted)">No open findings.</div>`;
  }
}

async function inspectBoundaryCut(fromScene, toScene) {
  if (!state.activeCreation) return;
  showToast(`Extracting 10s boundary slice: ${fromScene} to ${toScene}`);
  const res = await fetch(`/api/creations/${encodeURIComponent(state.activeCreation.id)}/boundary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromScene, toScene })
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Boundary extraction requires rendered scene MP4s.");
  el("stageSceneBadge").textContent = `BOUNDARY ${fromScene} / ${toScene}`;
  setMediaDisplay("video", `${data.clipUrl}?t=${Date.now()}`);
  el("stageVideo").play().catch(() => {});
  showToast(`Loaded 10s boundary clip (cut @ t=${data.clip.cut_time}s).`);
}

function renderTimelineTracks() {
  const c = state.activeCreation;
  const frameStrip = el("frameTrackStrip");
  const audioStrip = el("audioTrackStrip");
  frameStrip.innerHTML = "";
  audioStrip.innerHTML = "";
  if (!c) return;

  const step = Number(state.frameStep || 12);
  let shownFrames = 0;
  let totalRawFrames = 0;

  c.scenes.forEach((scene, sIdx) => {
    const raw = scene.frames || [];
    totalRawFrames += raw.length;
    const filtered = raw.filter((f, idx) => f.kind === "still" || idx % step === 0 || idx === raw.length - 1);

    for (const frameObj of filtered) {
      shownFrames++;
      const card = document.createElement("div");
      card.className = "frame-card";
      card.dataset.key = `${scene.id}:${frameObj.frameNumber}`;
      const fLabel = `f${String(frameObj.frameNumber).padStart(4, "0")}`;
      card.innerHTML = `
        <img src="${frameObj.url}" alt="${fLabel}" loading="lazy" />
        <div class="frame-card-foot">
          <span>${fLabel}</span>
          <span style="color:var(--red)">${frameObj.timestamp}s</span>
        </div>
      `;
      card.addEventListener("click", () => selectFrameLayer(scene, frameObj));
      frameStrip.appendChild(card);
    }

    if (sIdx < c.scenes.length - 1) {
      const nextScene = c.scenes[sIdx + 1];
      const cutPill = document.createElement("div");
      cutPill.className = "frame-cut-pill";
      cutPill.innerHTML = `<span>CUT</span><span>${sIdx + 1}/${sIdx + 2}</span>`;
      cutPill.title = "Click to extract and inspect 10s boundary handover clip";
      cutPill.addEventListener("click", () => inspectBoundaryCut(scene.id, nextScene.id));
      frameStrip.appendChild(cutPill);
    }
  });

  // Render Audio / Transcript Track
  const segments = c.transcript || [];
  for (const seg of segments) {
    const block = document.createElement("div");
    block.className = "transcript-block";
    block.dataset.segId = seg.id;
    block.innerHTML = `
      <div class="transcript-time">${fmtTime(seg.globalStart ?? seg.start)} – ${fmtTime(seg.globalEnd ?? seg.end)} · ${seg.sceneId || "voice"}</div>
      <div class="transcript-text" title="${seg.text}">"${seg.text}"</div>
    `;
    block.addEventListener("click", () => selectTranscriptSegment(seg));
    audioStrip.appendChild(block);
  }

  el("timelineStats").textContent = `${shownFrames} layer thumbs (${totalRawFrames} total frames) · ${segments.length} voice clauses`;
}

/* MARK-OUT BOUNDING BOX INTERACTION ON FRAME STAGE */
function setToolMode(mode) {
  state.toolMode = mode;
  el("btnToolScrub").classList.toggle("active", mode === "scrub");
  el("btnToolMark").classList.toggle("active", mode === "mark");
  el("markOverlay").classList.toggle("armed", mode === "mark");
}

function clearMarkBox() {
  state.markBox = null;
  el("markSelectionBox").classList.add("hidden");
  el("btnClearMark").classList.add("hidden");
}

function initMarkOverlay() {
  const overlay = el("markOverlay");
  const boxEl = el("markSelectionBox");
  const coordsEl = el("markCoordsLabel");
  let dragging = false;
  let startX = 0;
  let startY = 0;

  overlay.addEventListener("mousedown", (e) => {
    if (state.toolMode !== "mark") return;
    const rect = overlay.getBoundingClientRect();
    dragging = true;
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    boxEl.classList.remove("hidden");
    el("btnClearMark").classList.remove("hidden");
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = overlay.getBoundingClientRect();
    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.max(12, Math.abs(curX - startX));
    const h = Math.max(12, Math.abs(curY - startY));

    boxEl.style.left = `${x}px`;
    boxEl.style.top = `${y}px`;
    boxEl.style.width = `${w}px`;
    boxEl.style.height = `${h}px`;

    state.markBox = {
      x: Number((x / rect.width).toFixed(3)),
      y: Number((y / rect.height).toFixed(3)),
      w: Number((w / rect.width).toFixed(3)),
      h: Number((h / rect.height).toFixed(3))
    };
    const logicalX = Math.round(state.markBox.x * 1280);
    const logicalY = Math.round(state.markBox.y * 720);
    const logicalW = Math.round(state.markBox.w * 1280);
    const logicalH = Math.round(state.markBox.h * 720);
    coordsEl.textContent = `x:${logicalX} y:${logicalY} (${logicalW}×${logicalH})`;
  });

  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      el("surgicalPromptInput").focus();
    }
  });
}

async function submitFrameSurgicalFix() {
  if (!state.activeCreation) return;
  const prompt = el("surgicalPromptInput").value.trim();
  if (!prompt) return showToast("Describe the fix first.");

  const sceneId = state.selectedFrame?.sceneId || state.activeSceneId || state.activeCreation.scenes[0]?.id;
  const timestamp = state.selectedFrame?.timestamp ?? Number(el("stageVideo").currentTime.toFixed(2));
  const frameNumber = state.selectedFrame?.frameNumber ?? Math.round(timestamp * 24);

  showToast(`Dispatching surgical frame patch to ${sceneId} @ t=${timestamp}s...`);
  const res = await fetch(`/api/creations/${encodeURIComponent(state.activeCreation.id)}/fix-frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sceneId,
      timestamp,
      frameNumber,
      box: state.markBox,
      prompt,
      useLiveAgent: true
    })
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to apply surgical frame fix.");

  state.activeCreation = data.creation;
  el("surgicalPromptInput").value = "";
  clearMarkBox();
  updateInspector();
  showToast(`Patched ${sceneId} at Frame #${frameNumber} (t=${timestamp}s).`);
}

async function submitAudioSurgicalFix() {
  if (!state.activeCreation || !state.selectedTranscript) return;
  const text = el("surgicalPromptInput").value.trim();
  if (!text) return showToast("Enter updated spoken transcript text.");

  showToast("Re-synthesizing voice clause & updating word timings...");
  const res = await fetch(`/api/creations/${encodeURIComponent(state.activeCreation.id)}/fix-audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sceneId: state.selectedTranscript.sceneId,
      segmentIndex: state.selectedTranscript.index || 0,
      text
    })
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Audio update failed.");

  state.activeCreation = data.creation;
  renderTimelineTracks();
  updateInspector();
  showToast("Updated voice track, subtitles.srt & kit.timing cues!");
}

async function createNewTopicCreation() {
  const topic = el("topicInput").value.trim();
  if (!topic) return showToast("Enter a topic in the prompt box first.");

  showToast("Starting generation…");
  const res = await fetch("/api/creations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      style: state.selectedStyle,
      duration: state.selectedDuration
    })
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Creation failed.");

  state.creations = data.creations;
  renderCreationsMenu();
  await selectCreation(data.id);
  showToast(`Generating ${data.id} (${state.selectedStyle}, ${state.selectedDuration}s).`);
}

function wireEvents() {
  el("btnModePrompt").addEventListener("click", () => switchStageView("prompt"));
  el("btnModeCanvas").addEventListener("click", () => switchStageView("canvas"));
  el("btnNewCreation").addEventListener("click", () => {
    switchStageView("prompt");
    el("topicInput").focus();
  });

  el("btnToolScrub").addEventListener("click", () => setToolMode("scrub"));
  el("btnToolMark").addEventListener("click", () => setToolMode("mark"));
  el("btnViewVideo").addEventListener("click", () => {
    const scene = state.activeCreation?.scenes?.find((s) => s.id === state.activeSceneId);
    setMediaDisplay("video", scene?.previewUrl || state.activeCreation?.masterVideoUrl);
  });
  el("btnViewFrame").addEventListener("click", () => {
    setMediaDisplay("frame", state.selectedFrame?.url);
  });
  el("btnClearMark").addEventListener("click", clearMarkBox);

  el("btnApplyFrameFix").addEventListener("click", submitFrameSurgicalFix);
  el("btnApplyAudioFix").addEventListener("click", submitAudioSurgicalFix);
  el("surgicalPromptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (!el("btnApplyAudioFix").classList.contains("hidden")) submitAudioSurgicalFix();
      else submitFrameSurgicalFix();
    }
  });

  el("btnSaveCode").addEventListener("click", async () => {
    if (!state.activeCreation || !state.activeSceneId) return;
    const codeOverride = el("sceneCodeEditor").value;
    const res = await fetch(`/api/creations/${encodeURIComponent(state.activeCreation.id)}/fix-frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sceneId: state.activeSceneId,
        timestamp: 0,
        prompt: "Direct scene.js edit in Studio",
        codeOverride
      })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || "Save failed");
    state.activeCreation = data.creation;
    updateInspector();
    showToast(`Saved ${state.activeSceneId}/scene.js`);
  });

  el("tabBtnScenes").addEventListener("click", () => {
    el("tabBtnScenes").classList.add("active");
    el("tabBtnCode").classList.remove("active");
    el("inspectorScenesTab").classList.remove("hidden");
    el("inspectorCodeTab").classList.add("hidden");
  });
  el("tabBtnCode").addEventListener("click", () => {
    el("tabBtnCode").classList.add("active");
    el("tabBtnScenes").classList.remove("active");
    el("inspectorCodeTab").classList.remove("hidden");
    el("inspectorScenesTab").classList.add("hidden");
  });

  el("frameStepSelect").addEventListener("change", (e) => {
    state.frameStep = Number(e.target.value);
    renderTimelineTracks();
  });

  document.querySelectorAll("#styleSelector .opt-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#styleSelector .opt-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedStyle = btn.dataset.style;
    });
  });

  document.querySelectorAll("#durationSelector .opt-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#durationSelector .opt-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedDuration = Number(btn.dataset.duration);
    });
  });

  document.querySelectorAll(".sample-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (chip.dataset.sample) {
        selectCreation(chip.dataset.sample);
      } else if (chip.dataset.prompt) {
        el("topicInput").value = chip.dataset.prompt;
        el("topicInput").focus();
      }
    });
  });

  el("btnCreateTopic").addEventListener("click", createNewTopicCreation);
  el("btnCancelGeneration").addEventListener("click", cancelGeneration);
  initMarkOverlay();
}

window.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  await fetchCreations();
});
