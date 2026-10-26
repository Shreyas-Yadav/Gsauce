const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { validateProject, sceneBrief, ProjectWorkspace } = require("../src/harness/project");
const { extractBoundaryClip } = require("../src/harness/render");
const { reviewBoundary } = require("../src/harness/tools");
const { dispatchParallelSwarm } = require("../src/harness/project-agent");
const { openTopic, createProject, FRAME } = require("../src/harness/create");
const { GeminiSession } = require("../src/harness/gemini");
const { manifest } = require("../src/harness/project-demo");
const { digest } = require("../src/harness/workspace");
const { installScene } = require("../src/harness/scene-host");

function makeTestVideo(filePath, color, durationSec = 8) {
  const res = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=24:d=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    filePath
  ], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr || res.error?.message);
}

test("validateProject validates entry_anchor and exit_anchor handoff contracts and propagates them to sceneBrief", () => {
  const withAnchors = {
    ...manifest,
    scenes: [
      {
        ...manifest.scenes[0],
        exit_anchor: { object: "car", x: 640, y: 300, vx: 150, vy: 0 }
      },
      {
        ...manifest.scenes[1],
        entry_anchor: { object: "car", x: 640, y: 300, vx: 150, vy: 0 },
        exit_anchor: { object: "car", x: 820, y: 300, vx: 0, vy: 0 }
      }
    ]
  };
  const validated = validateProject(withAnchors, { demo: true });
  const brief0 = sceneBrief(validated, validated.scenes[0]);
  const brief1 = sceneBrief(validated, validated.scenes[1]);
  assert.deepEqual(brief0.exit_anchor, { object: "car", x: 640, y: 300, vx: 150, vy: 0 });
  assert.deepEqual(brief1.entry_anchor, { object: "car", x: 640, y: 300, vx: 150, vy: 0 });

  // Rejects non-finite anchor coordinate
  assert.throws(() => validateProject({
    ...withAnchors,
    scenes: [
      { ...withAnchors.scenes[0], exit_anchor: { object: "car", x: NaN, y: 300 } },
      withAnchors.scenes[1]
    ]
  }, { demo: true }), /entry_anchor|exit_anchor/);

  // Rejects mismatched x coordinate across cut boundary for the same object
  assert.throws(() => validateProject({
    ...withAnchors,
    scenes: [
      { ...withAnchors.scenes[0], exit_anchor: { object: "car", x: 640, y: 300 } },
      { ...withAnchors.scenes[1], entry_anchor: { object: "car", x: 120, y: 300 } }
    ]
  }, { demo: true }), /does not match previous scene/);

  // Accepts vector [x, y] position/velocity and focal_object format from architecture.md 2.1
  const vecAnchors = validateProject({
    ...manifest,
    scenes: [
      {
        ...manifest.scenes[0],
        exit_anchor: { focal_object: "vehicle_chassis", position: [640, 520], velocity: [120, 0], active_color: "#1D2630", scale: 1.0 }
      },
      {
        ...manifest.scenes[1],
        entry_anchor: { focal_object: "vehicle_chassis", position: [640, 520], velocity: [120, 0], active_color: "#1D2630", scale: 1.0 }
      }
    ]
  }, { demo: true });
  assert.deepEqual(sceneBrief(vecAnchors, vecAnchors.scenes[1]).entry_anchor.position, [640, 520]);
});

test("extractBoundaryClip extracts a 10s cross-cut boundary slice (last 5s of sceneA + first 5s of sceneB)", async (t) => {
  const temp = fs.mkdtempSync(join(os.tmpdir(), "lit-boundary-clip-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const videoA = join(temp, "sceneA.mp4");
  const videoB = join(temp, "sceneB.mp4");
  const stitchOut = join(temp, "stitch_1_2.mp4");

  makeTestVideo(videoA, "red", 8);
  makeTestVideo(videoB, "blue", 8);

  const clip = await extractBoundaryClip(videoA, videoB, stitchOut);
  assert.equal(fs.existsSync(stitchOut), true);
  assert.equal(clip.cut_time, 5);
  assert.equal(clip.tail_duration, 5);
  assert.equal(clip.head_duration, 5);
  assert.ok(Math.abs(clip.duration - 10.0) < 0.2, `Expected ~10.0s boundary clip, got ${clip.duration}s`);
});

test("reviewBoundary evaluates 10s boundary slice with Flash and flags cross-cut continuity defects on target scene", async (t) => {
  const temp = fs.mkdtempSync(join(os.tmpdir(), "lit-boundary-review-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const videoA = join(temp, "scene1.mp4");
  const videoB = join(temp, "scene2.mp4");
  makeTestVideo(videoA, "red", 7);
  makeTestVideo(videoB, "blue", 7);

  const sceneA = {
    id: "scene_1",
    path: videoA,
    brief: { exit_anchor: { object: "car", x: 640, y: 300, vx: 150 } }
  };
  const sceneB = {
    id: "scene_2",
    path: videoB,
    root: temp,
    state: {},
    save() {},
    brief: { entry_anchor: { object: "car", x: 640, y: 300, vx: 150 } }
  };

  const prompts = [];
  const responses = [
    {
      status: "completed",
      steps: [{
        type: "model_output",
        content: [{
          type: "text",
          text: JSON.stringify({
            findings: [{
              severity: "major",
              timestamp_seconds: 5.0,
              evidence: "Car teleports from x=640 to x=120 at cut t=5.0s",
              expected: "Car enters scene_2 smoothly at x=640"
            }]
          })
        }]
      }]
    },
    {
      status: "completed",
      steps: [{
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify({ findings: [] }) }]
      }]
    }
  ];

  const session = {
    async create(model, content) {
      assert.equal(model, "gemini-3.8-flash");
      prompts.push(content[0].text);
      assert.equal(content[1].type, "video");
      assert.equal(content[1].mime_type, "video/mp4");
      return responses.shift();
    }
  };

  const failedReview = await reviewBoundary(sceneA, sceneB, session);
  assert.equal(failedReview.passed, false);
  assert.equal(failedReview.boundary, "scene_1->scene_2");
  assert.equal(failedReview.target_scene_id, "scene_2");
  assert.equal(failedReview.cut_time, 5);
  assert.equal(failedReview.findings.length, 1);
  assert.match(prompts[0], /640/);

  const passedReview = await reviewBoundary(sceneA, sceneB, session);
  assert.equal(passedReview.passed, true);
  assert.equal(passedReview.findings.length, 0);
});

test("dispatchParallelSwarm runs concurrent scene workers and isolates surgical boundary patching to the entry scene", async (t) => {
  const id = `test-swarm-${randomUUID().slice(0, 8)}`;
  const threeSceneManifest = {
    ...manifest,
    target_duration: 6,
    scenes: [
      { id: "s1", order: 0, duration: 2, purpose: "Act 1", claim_ids: ["local-window"], transition: "cut", exit_anchor: { object: "window", x: 640, y: 300 } },
      { id: "s2", order: 1, duration: 2, purpose: "Act 2", claim_ids: ["local-window"], transition: "cut", entry_anchor: { object: "window", x: 640, y: 300 }, exit_anchor: { object: "window", x: 740, y: 300 } },
      { id: "s3", order: 2, duration: 2, purpose: "Act 3", claim_ids: ["local-window"], transition: "cut", entry_anchor: { object: "window", x: 740, y: 300 } }
    ]
  };
  const project = new ProjectWorkspace(id, { create: true, manifest: threeSceneManifest, demo: true, limits: { maxCalls: 16, maxOutputTokens: 8192 } });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));

  const renderedSceneIds = [];
  let cut12Attempts = 0;
  const session = { maxCalls: 16, calls: 0 };

  const swarmResult = await dispatchParallelSwarm(project, session, 3, {
    sceneAuthor: async (scene) => `return {duration:2,draw(ctx,t,kit){kit.label('${scene.id}_v1',540,300)}};`,
    verifier: async (scene) => {
      scene.state.verification = { hash: scene.sceneHash(), passed: true };
      scene.save();
      return scene.state.verification;
    },
    renderer: async (scene, options) => {
      renderedSceneIds.push(`${scene.id}:r${scene.state.revisions}`);
      const preview = { hash: scene.sceneHash(), width: options.width, height: threeSceneManifest.frame.height, fps: options.fps, duration: 2, file: "preview.mp4" };
      scene.state.preview = preview;
      for (const f of ["preview.mp4", "still-0.png", "still-1.png", "still-2.png", "still-3.png"]) {
        fs.writeFileSync(join(scene.artifactDir(), f), "fixture");
      }
      scene.save();
      return preview;
    },
    reviewer: async (scene) => {
      scene.state.review = { hash: scene.sceneHash(), findings: [] };
      scene.save();
      return scene.state.review;
    },
    boundaryReviewer: async (sceneA, sceneB) => {
      if (sceneA.id === "s1" && sceneB.id === "s2") {
        cut12Attempts++;
        if (cut12Attempts === 1) {
          return {
            passed: false,
            boundary: "s1->s2",
            from_scene_id: "s1",
            target_scene_id: "s2",
            cut_time: 2,
            duration: 4,
            findings: [{ severity: "major", timestamp_seconds: 2.0, evidence: "Object jumps at s1->s2 cut", expected: "Match s1 exit_anchor x=640" }]
          };
        }
      }
      return {
        passed: true,
        boundary: `${sceneA.id}->${sceneB.id}`,
        from_scene_id: sceneA.id,
        target_scene_id: sceneB.id,
        cut_time: 2,
        duration: 4,
        findings: []
      };
    },
    boundaryPatcher: async (_sceneA, sceneB) => {
      return `return {duration:2,draw(ctx,t,kit){kit.label('${sceneB.id}_patched_entry_640',540,300)}};`;
    },
    assembler: async (candidate) => {
      const output = join(candidate.root, "swarm-master.mp4");
      fs.writeFileSync(output, "assembled master film");
      candidate.workspace.state.assembly = {
        hash: candidate.assemblyHash(),
        file: output,
        output_hash: digest(fs.readFileSync(output)),
        status: "ready_for_human_review"
      };
      candidate.workspace.save();
      return candidate.workspace.state.assembly;
    }
  });

  assert.equal(swarmResult.passed, true);
  assert.equal(swarmResult.boundaries.length, 2);
  assert.equal(swarmResult.boundaries.every((b) => b.passed), true);
  // Only s2 was re-rendered after the s1->s2 boundary defect; s1 and s3 remained at revision 1!
  assert.equal(project.scene("s1").state.revisions, 1);
  assert.equal(project.scene("s2").state.revisions, 2);
  assert.equal(project.scene("s3").state.revisions, 1);
  assert.deepEqual(renderedSceneIds, ["s1:r1", "s2:r1", "s3:r1", "s2:r2"]);
});

test("createProject immediately pre-generates scene audio and subtitle cues after manifest planning", async (t) => {
  const workspace = openTopic(manifest.title, { id: `test-create-audio-${randomUUID().slice(0, 8)}` });
  t.after(() => fs.rmSync(workspace.root, { recursive: true, force: true }));

  const researchResp = {
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{
        text: manifest.sources[0].evidence,
        type: "text",
        annotations: [{ type: "url_citation", url: "https://example.org/primary", title: "Source", start_index: 0, end_index: 20 }]
      }]
    }]
  };
  const plannedWithNarration = {
    ...manifest,
    target_duration: 120,
    frame: FRAME,
    scenes: manifest.scenes.map((s) => ({ ...s, duration: 60 })),
    claims: manifest.claims.map((c) => ({ ...c, source_ids: ["source-1"] })),
    narration: [
      { scene_id: "window", start: 0.4, end: 3.2, text: "A sliding kernel measures local neighborhood structure." }
    ]
  };
  const planningResp = {
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(plannedWithNarration) }] }]
  };

  const responses = [researchResp, planningResp];
  const session = new GeminiSession({
    ...workspace.state.limits,
    initialCalls: 0,
    client: { interactions: { async create() { return responses.shift(); } } }
  });

  let windowBriefDuringProduce = null;
  await createProject(workspace, session, {
    offlineAudio: true,
    produce: async (project) => {
      const windowScene = project.scene("window");
      windowBriefDuringProduce = JSON.parse(windowScene.read("brief.json"));
      return { passed: true, status: "ready_for_human_review" };
    }
  });

  assert.equal(workspace.state.audio_pregenerated, true);
  assert.equal(windowBriefDuringProduce.audio, "audio/master_audio.wav");
  assert.equal(windowBriefDuringProduce.subtitles_srt, "audio/subtitles.srt");
  assert.ok(Array.isArray(windowBriefDuringProduce.subtitles));
  assert.ok(windowBriefDuringProduce.subtitles.length >= 1);
  assert.ok(windowBriefDuringProduce.measured_audio_duration > 0);
  assert.ok(windowBriefDuringProduce.timing && typeof windowBriefDuringProduce.timing.cues === "object");
});

test("scene-host injects kit.entryAnchor, kit.exitAnchor, and kit.timing.cue() into draw runtime", () => {
  const prevDoc = global.document, prevWin = global.window;
  const prevRand = Object.getOwnPropertyDescriptor(Math, "random");
  const context = {
    globalAlpha: 1,
    scale() {},
    fillRect() {},
    save() {},
    restore() {},
    fillText() {},
    measureText: () => ({ actualBoundingBoxLeft: 10, actualBoundingBoxRight: 10, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  };
  global.document = {
    createElement: () => ({ style: {}, getContext: () => context }),
    body: { append() {} },
    addEventListener() {}
  };
  global.window = {
    ENG: {
      clamp: (v, a = 0, b = 1) => Math.max(a, Math.min(b, v)),
      lerp: (a, b, t) => a + (b - a) * t,
      easeInOutCubic: (t) => t,
      rngFor: () => () => 0.5,
      densify: (pts) => pts,
      penStroke() {},
      wetWash() {},
      drawBurnedSubtitles() {}
    }
  };
  try {
    let observedEntry = null;
    let observedRadarCue = null;
    let observedSpeechEnd = null;
    global.window.__capture = (entry, cue, end) => {
      observedEntry = entry;
      observedRadarCue = cue;
      observedSpeechEnd = end;
    };
    const source = `return {
      duration: 10,
      draw(ctx, t, kit) {
        window.__capture(kit.entryAnchor, kit.timing.cue("radar"), kit.timing.speechEnd);
      }
    };`;
    installScene(source, 960, "line", {
      logicalWidth: 1280,
      logicalHeight: 720,
      outputHeight: 540,
      duration: 10,
      entryAnchor: { focal_object: "vehicle_chassis", position: [640, 520], active_color: "#1D2630" },
      timing: {
        measured_duration: 10,
        speech_start: 0.4,
        speech_end: 8.2,
        observation_pause: 1.8,
        cues: { radar: 1.85, drift: 5.4 },
        words: [{ word: "Radar", start: 1.85, end: 2.25 }]
      }
    });
    global.window.__sceneHost.renderAt(2.0);
    assert.deepEqual(observedEntry, { focal_object: "vehicle_chassis", position: [640, 520], active_color: "#1D2630" });
    assert.equal(observedRadarCue, 1.85);
    assert.equal(observedSpeechEnd, 8.2);
  } finally {
    if (prevDoc === undefined) delete global.document; else global.document = prevDoc;
    if (prevWin === undefined) delete global.window; else global.window = prevWin;
    Object.defineProperty(Math, "random", prevRand);
  }
});

