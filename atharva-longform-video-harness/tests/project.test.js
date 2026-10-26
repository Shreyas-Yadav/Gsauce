const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { ProjectWorkspace, validateProject, sceneBrief, sceneGeometry } = require("../src/harness/project");
const { manifest } = require("../src/harness/project-demo");
const { makeProjectTools, runProjectAgent, systemFor, approveReviewRetry } = require("../src/harness/project-agent");
const { renderSettings } = require("../src/harness/render");
const { digest } = require("../src/harness/workspace");
const { installScene } = require("../src/harness/scene-host");
const { isGeneratedSceneDefect } = require("../src/harness/render");

test("project manifest accepts 120-second landscape and rejects broken claim/time references", () => {
  const production = { ...manifest, target_duration: 120, frame: { width: 1920, height: 1080, fps: 24 },
    api_limits: { max_calls: 8, max_output_tokens: 8192, reviewer_max_output_tokens: 8192 },
    scenes: [{ ...manifest.scenes[0], duration: 60 }, { ...manifest.scenes[1], duration: 60 }] };
  assert.equal(validateProject(production).target_duration, 120);
  assert.equal(validateProject({ ...production, frame: { width: 1280, height: 960, fps: 24 } }).frame.height, 960);
  assert.throws(() => validateProject({ ...production, api_limits: { ...production.api_limits, max_calls: 4 } }), /request limit/);
  assert.throws(() => validateProject({ ...production, scenes: [{ ...production.scenes[0], claim_ids: ["missing"] }, production.scenes[1]] }), /unknown claim/);
  assert.throws(() => validateProject({ ...production, observation_windows: [{ scene_id: "window", start: 0, end: 61 }] }), /exceeds/);
  assert.throws(() => validateProject({ ...production, target_duration: NaN }), /Invalid project manifest/);
  assert.throws(() => validateProject({ ...production, frame: { ...production.frame, height: 1079 } }), /Invalid project manifest/);
  assert.throws(() => validateProject({ ...production, scenes: [{ ...production.scenes[0], safe_region: {} }, production.scenes[1]] }), /safe region/);
  assert.throws(() => validateProject({ ...production, scenes: [{ ...production.scenes[0], logical_width: NaN }, production.scenes[1]] }), /logical dimensions/);
  assert.throws(() => validateProject({ ...production, scenes: [{ ...production.scenes[0], logical_width: -1 }, production.scenes[1]] }), /logical dimensions/);
  assert.throws(() => validateProject({ ...production, art_direction: { ...production.art_direction, typography: { font_family: "Arial;url(https://bad)", font_weight: 700, label_size: 48 } } }), /Invalid project manifest/);
  const custom = { ...production, scenes: [{ ...production.scenes[0], logical_width: 2000, logical_height: 1125 }, { ...production.scenes[1], logical_width: 2000, logical_height: 1125 }] };
  assert.deepEqual(sceneGeometry(custom, custom.scenes[0]), { logical_width: 2000, logical_height: 1125, safe_region: { left: 100, top: 56.25, right: 1900, bottom: 1068.75 } });
  assert.equal(sceneBrief(custom, custom.scenes[0]).logical_width, 2000);
  assert.throws(() => renderSettings({ duration: 1, style: "line", frame: { width: 960, height: 539 }, logical_width: 1080, logical_height: 606.375 }, 960), /even/);
  assert.throws(() => renderSettings({ duration: 1, style: "line", frame: { width: 960, height: 540 }, logical_width: NaN, logical_height: 303 }, 960), /dimensions/);
  for (const logical_width of [NaN, 0, null, -1, Infinity]) {
    assert.throws(() => renderSettings({ duration: 1, style: "line", frame: { width: 960, height: 540 }, logical_width }, 960), /dimensions/);
  }
});

test("generated scene initialization errors are repair feedback rather than local infrastructure failures", () => {
  const previousDocument = global.document, previousWindow = global.window;
  const previousRandom = Object.getOwnPropertyDescriptor(Math, "random");
  const context = { fillText() {} };
  global.document = { createElement: () => ({ style: {}, getContext: () => context }), body: { append() {} }, addEventListener() {} };
  global.window = { ENG: {} };
  try {
    assert.throws(() => installScene("throw new Error('missing source value');", 960, "line"), (error) => {
      assert.match(error.message, /Scene runtime error: missing source value/);
      assert.equal(isGeneratedSceneDefect(error), true);
      return true;
    });
  } finally {
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
    Object.defineProperty(Math, "random", previousRandom);
  }
});

test("project model input includes canonical timelines and scene geometry", async (t) => {
  const id = `test-project-input-${randomUUID().slice(0, 8)}`;
  const timed = { ...manifest, narration: [{ scene_id: "window", start: 0, end: 0.8, text: "A timed narration cue" }],
    captions: [{ scene_id: "window", start: 0, end: 0.8, text: "A timed caption cue" }],
    observation_windows: [{ scene_id: "window", start: 1, end: 1.5 }],
    scenes: [{ ...manifest.scenes[0], logical_width: 2160, logical_height: 1215 }, manifest.scenes[1]] };
  const project = new ProjectWorkspace(id, { create: true, manifest: timed, demo: true, limits: { maxCalls: 8, maxOutputTokens: 8192 } });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  let captured;
  const session = { maxCalls: 8, calls: 0, async create(_model, _history, _tools, system) { captured = system; throw new Error("stop after prompt capture"); } };
  await assert.rejects(runProjectAgent(project, session), /stop after prompt capture/);
  assert.match(captured, /A timed narration cue/);
  assert.match(captured, /A timed caption cue/);
  assert.match(captured, /"observation_windows":\[\{"scene_id":"window","start":1,"end":1\.5\}\]/);
  assert.match(captured, /"logical_width":2160/);
  assert.match(captured, /"logical_height":1215/);
  assert.match(captured, /"font_family":"Arial"/);
});

test("resuming an interrupted verification and render finishes local stages before any new lead call", async (t) => {
  const id = `test-project-resume-${randomUUID().slice(0, 8)}`;
  const oneScene = { ...manifest, target_duration: 2, scenes: [manifest.scenes[0]] };
  const project = new ProjectWorkspace(id, { create: true, manifest: oneScene, demo: true, limits: { maxCalls: 6, maxOutputTokens: 8192 } });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  let leadCalls = 0, verifyCalls = 0, renderCalls = 0, reviewCalls = 0, renderInterrupted = false;
  const session = { maxCalls: 6, calls: 0, async create(model) {
    if (model === "gemini-3.8-flash") throw new Error("review should happen through the injected stage");
    leadCalls++; this.calls++;
    return { status: "requires_action", steps: [{ type: "function_call", id: "write-once", name: "write_scene", arguments: {
      scene_id: "window", source: "return {duration:2,draw(ctx,t,kit){kit.label('ONE',540,300)}};" } }] };
  } };
  const base = {
    verifier: async (scene) => {
      verifyCalls++;
      if (verifyCalls === 1) throw new Error("temporary browser interruption");
      scene.state.verification = { hash: scene.sceneHash(), passed: true }; scene.save(); return scene.state.verification;
    },
    renderer: async (scene, options) => {
      renderCalls++;
      if (!renderInterrupted) { renderInterrupted = true; throw new Error("temporary FFmpeg interruption"); }
      const preview = { hash: scene.sceneHash(), width: options.width, height: oneScene.frame.height, fps: options.fps, duration: 2 };
      scene.state.preview = preview;
      for (const file of ["preview.mp4", "still-0.png", "still-1.png", "still-2.png", "still-3.png"]) fs.writeFileSync(join(scene.artifactDir(), file), "fixture");
      scene.save(); return preview;
    },
    reviewer: async (scene) => { reviewCalls++; session.calls++; scene.state.review = { hash: scene.sceneHash(), findings: [] }; scene.save(); return scene.state.review; },
    assembler: async (candidate) => {
      const output = join(candidate.root, "resume-assembly.mp4"); fs.writeFileSync(output, "resume fixture");
      candidate.workspace.state.assembly = { hash: candidate.assemblyHash(), file: output, output_hash: digest(fs.readFileSync(output)), status: "ready_for_human_review" };
      candidate.workspace.save(); return candidate.workspace.state.assembly;
    }
  };
  const firstTools = makeProjectTools(project, session, base);
  await assert.rejects(runProjectAgent(project, session, { tools: firstTools }), /temporary browser interruption/);
  assert.equal(project.scene("window").state.project_pipeline.verification.attempts, 1);
  const secondTools = makeProjectTools(project, session, base);
  await assert.rejects(runProjectAgent(project, session, { tools: secondTools }), /temporary FFmpeg interruption/);
  const scene = project.scene("window");
  assert.equal(scene.state.project_pipeline.verification.status, "passed", JSON.stringify({ v: verifyCalls, state: scene.state.project_pipeline, verification: scene.state.verification }));
  assert.equal(scene.state.project_pipeline.rendering.attempts, 1);
  const thirdTools = makeProjectTools(project, session, base);
  const result = await runProjectAgent(project, session, { tools: thirdTools });
  assert.equal(result.passed, true);
  assert.equal(leadCalls, 1);
  assert.equal(verifyCalls, 2);
  assert.equal(renderCalls, 2);
  assert.equal(reviewCalls, 1);
});

test("a deterministic scene defect is delivered for repair without retrying the verifier", async (t) => {
  const id = `test-project-defect-${randomUUID().slice(0, 8)}`;
  const oneScene = { ...manifest, target_duration: 2, scenes: [manifest.scenes[0]] };
  const project = new ProjectWorkspace(id, { create: true, manifest: oneScene, demo: true, limits: { maxCalls: 6, maxOutputTokens: 8192 } });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  let verifierCalls = 0, leadCalls = 0, sawFeedback = false;
  const session = { maxCalls: 6, calls: 0, async create(_model, history) {
    leadCalls++; this.calls++;
    if (leadCalls === 1) return { status: "requires_action", steps: [{ type: "function_call", id: "bad-scene", name: "write_scene", arguments: {
      scene_id: "window", source: "return {duration:2,draw(ctx,t,kit){kit.label('bad',540,300)}};" } }] };
    sawFeedback = JSON.stringify(history).includes("source_defect");
    throw new Error("observed verification feedback");
  } };
  const tools = makeProjectTools(project, session, { verifier: async () => { verifierCalls++; const error = new SyntaxError("Unexpected token"); throw error; } });
  await assert.rejects(runProjectAgent(project, session, { tools }), /observed verification feedback/);
  assert.equal(sawFeedback, true);
  assert.equal(verifierCalls, 1);
  assert.equal(project.scene("window").state.project_pipeline.verification.status, "invalid");
});

test("per-scene revisions preserve other scene hashes and project API usage on resume", (t) => {
  const id = `test-project-${randomUUID().slice(0, 8)}`;
  const root = join(process.cwd(), "build/test-projects");
  const project = new ProjectWorkspace(id, { create: true, manifest, demo: true, limits: { maxCalls: 8, maxOutputTokens: 8192 } });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  const [first, second] = project.scenes();
  first.writeScene("return {duration:2,draw(ctx,t,kit){kit.label('ONE',540,300)}};");
  second.writeScene("return {duration:2,draw(ctx,t,kit){kit.label('TWO',540,300)}};");
  const secondHash = second.sceneHash();
  project.workspace.state.api_calls = 3;
  project.workspace.save();
  const assemblyHash = project.assemblyHash();
  first.writeScene("return {duration:2,draw(ctx,t,kit){kit.label('ONE revised',540,300)}};");
  assert.equal(second.sceneHash(), secondHash);
  assert.notEqual(project.assemblyHash(), assemblyHash);
  const resumed = new ProjectWorkspace(id);
  assert.equal(resumed.workspace.state.api_calls, 3);
  assert.equal(resumed.manifest.scenes.length, 2);
  assert.ok(root.endsWith("build/test-projects"));
});

test("project writes automatically run scene stages and preserve review capacity across model turns", async (t) => {
  const id = `test-project-agent-${randomUUID().slice(0, 8)}`;
  const project = new ProjectWorkspace(id, { create: true, manifest, demo: true, limits: { maxCalls: 8, maxOutputTokens: 8192 } });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  const writes = [
    { type: "function_call", id: "write-1", name: "write_scene", arguments: { scene_id: "window", source: "return {duration:2,draw(ctx,t,kit){kit.label('ONE',540,300)}};" } },
    { type: "function_call", id: "write-2", name: "write_scene", arguments: { scene_id: "combine", source: "return {duration:2,draw(ctx,t,kit){kit.label('TWO',540,300)}};" } },
    { type: "function_call", id: "assemble", name: "assemble_project", arguments: {} }
  ];
  let turn = 0;
  const session = { maxCalls: 8, calls: 0, async create(model) {
    this.calls++;
    if (model === "gemini-3.8-flash") return { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "{\"findings\":[]}" }] }] };
    const steps = turn === 0 ? [writes[0]] : [writes[1], writes[2]];
    turn++;
    return { status: "requires_action", steps };
  } };
  const tools = makeProjectTools(project, session, {
    verifier: async (scene) => { scene.state.verification = { hash: scene.sceneHash(), passed: true }; scene.save(); return scene.state.verification; },
    renderer: async (scene, options) => {
      const preview = { hash: scene.sceneHash(), width: options.width, height: manifest.frame.height, fps: options.fps, duration: 2, file: "preview.mp4" };
      scene.state.preview = preview;
      for (const name of ["preview.mp4", "still-0.png", "still-1.png", "still-2.png", "still-3.png"]) require("node:fs").writeFileSync(join(scene.artifactDir(), name), "fixture");
      scene.save();
      return preview;
    },
    reviewer: async (scene) => { session.calls++; scene.state.review = { hash: scene.sceneHash(), findings: [] }; scene.save(); return scene.state.review; },
    assembler: async (candidate) => {
      const output = join(candidate.root, "mock-assembly.mp4");
      fs.writeFileSync(output, "assembly fixture");
      candidate.workspace.state.assembly = { hash: candidate.assemblyHash(), file: output, output_hash: digest(fs.readFileSync(output)), status: "ready_for_human_review" };
      candidate.workspace.save();
      return candidate.workspace.state.assembly;
    }
  });
  const result = await runProjectAgent(project, session, { tools });
  assert.equal(result.passed, true);
  assert.equal(turn, 2);
  assert.equal(session.calls, 4);
  assert.equal(project.status().scenes.every((scene) => scene.reviewed && scene.human_gate.passed), true);
});

test("an uncertain first-scene Flash review reserves an unwritten scene with exactly sufficient retry budget", async (t) => {
  const project = new ProjectWorkspace(`test-project-review-${randomUUID().slice(0, 8)}`, {
    create: true, manifest, demo: true,
    limits: { maxCalls: 3, maxOutputTokens: 8192 }
  });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  let reviews = 0;
  const session = { maxCalls: 3, calls: 0 };
  const tools = makeProjectTools(project, session, {
    verifier: async (scene) => { scene.state.verification = { hash: scene.sceneHash(), passed: true }; scene.save(); return scene.state.verification; },
    renderer: async (scene) => { scene.state.preview = { hash: scene.sceneHash(), ...manifest.frame }; scene.save(); return scene.state.preview; },
    reviewer: async () => {
      reviews++; session.calls++; project.workspace.state.api_calls = session.calls; project.workspace.save();
      if (reviews === 1) throw new Error("review connection interrupted");
      return { findings: [] };
    }
  });
  const result = await tools.execute({ type: "function_call", id: "write-review", name: "write_scene", arguments: {
    scene_id: "window", source: "return {duration:2,draw(){}};"
  } });
  assert.equal(JSON.parse(result.result[0].text).pause_required, true);
  await assert.rejects(tools.reconcile(), /outcome is uncertain/);
  assert.equal(reviews, 1);
  assert.equal(project.workspace.state.limits.maxCalls - project.workspace.state.api_calls, 2);
  assert.equal(approveReviewRetry(project), 1);
  await tools.reconcile();
  assert.equal(reviews, 2);
  await tools.reconcile();
  assert.equal(reviews, 2);
  assert.throws(() => approveReviewRetry(project), /No uncertain current Flash review/);
});

test("resumed rendering delivers major Flash findings in the next model input exactly once", async (t) => {
  const project = new ProjectWorkspace(`test-project-review-feedback-${randomUUID().slice(0, 8)}`, {
    create: true, manifest: { ...manifest, target_duration: 2, scenes: [manifest.scenes[0]] }, demo: true,
    limits: { maxCalls: 6, maxOutputTokens: 8192 }
  });
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  let leads = 0, renders = 0, reviews = 0, observedHistory;
  const session = { maxCalls: 6, calls: 0, async create(_model, history) {
    leads++; this.calls++;
    if (leads === 1) return { steps: [{ type: "function_call", id: "interrupted-write", name: "write_scene", arguments: {
      scene_id: "window", source: "return {duration:2,draw(){}};"
    } }] };
    observedHistory = JSON.parse(JSON.stringify(history));
    throw new Error("captured next repair input");
  } };
  const tools = makeProjectTools(project, session, {
    verifier: async (scene) => { scene.state.verification = { hash: scene.sceneHash(), passed: true }; scene.save(); return scene.state.verification; },
    renderer: async (scene) => {
      if (++renders === 1) throw new Error("interrupted rendering");
      scene.state.preview = { hash: scene.sceneHash(), ...manifest.frame }; scene.save(); return scene.state.preview;
    },
    reviewer: async () => { reviews++; session.calls++; return { findings: [{ severity: "major", t: 1, evidence: "resume-only review evidence", issue: "Repair the diagram" }] }; }
  });
  await assert.rejects(runProjectAgent(project, session, { tools }), /interrupted rendering/);
  await assert.rejects(runProjectAgent(project, session, { tools }), /captured next repair input/);
  assert.match(JSON.stringify(observedHistory), /resume-only review evidence/);
  assert.equal(reviews, 1);
  assert.equal(observedHistory.filter((entry) => entry.type === "user_input" && JSON.stringify(entry).includes("resume-only review evidence")).length, 1);
  assert.deepEqual(await tools.reconcile(observedHistory), []);
  assert.equal(reviews, 1);
  // A stage completed before a conversation checkpoint remains deliverable.
  assert.equal((await tools.reconcile([]))[0].review.findings[0].evidence, "resume-only review evidence");
});

test("audio assembly remains pending audiovisual review and stops without new lead calls", async (t) => {
  const id = `test-project-audio-${randomUUID().slice(0, 8)}`;
  const project = new ProjectWorkspace(id, { create: true, manifest, demo: true, limits: { maxCalls: 8, maxOutputTokens: 8192 } });
  const temp = fs.mkdtempSync(join(os.tmpdir(), "lost-translation-audio-"));
  t.after(() => { fs.rmSync(project.root, { recursive: true, force: true }); fs.rmSync(temp, { recursive: true, force: true }); });
  const runCommand = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  for (const [index, sceneInfo] of manifest.scenes.entries()) {
    const scene = project.scene(sceneInfo.id);
    scene.writeScene(`return {duration:2,draw(ctx,t,kit){kit.label('SCENE ${index}',540,300)}};`);
    const hash = scene.sceneHash();
    const preview = join(temp, `scene-${index}.mp4`);
    runCommand("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${index ? "blue" : "red"}:s=960x540:r=12:d=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", preview]);
    fs.copyFileSync(preview, join(scene.artifactDir(), "preview.mp4"));
    scene.state.verification = { hash, passed: true };
    scene.state.preview = { hash, width: 960, height: 540, fps: 12, duration: 2 };
    scene.state.review = { hash, findings: [] };
    scene.save();
  }
  const sourceAudio = join(temp, "voice.wav");
  runCommand("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-c:a", "pcm_s16le", sourceAudio]);
  await project.importAudio(sourceAudio);
  assert.equal(project.assemblyCurrent(), false);
  let leadCalls = 0;
  const session = { maxCalls: 0, calls: 0, async create() { leadCalls++; throw new Error("must not request a missing AV review tool"); } };
  const result = await runProjectAgent(project, session);
  assert.deepEqual({ passed: result.passed, status: result.status }, { passed: false, status: "needs_audiovisual_review" });
  const assembled = result.assembly;
  assert.equal(assembled.audio, true);
  assert.equal(assembled.visual_scene_reviews, true);
  assert.equal(assembled.audiovisual_review, false);
  assert.equal(assembled.reviewed, false);
  assert.equal(assembled.status, "needs_audiovisual_review");
  assert.equal(project.assemblyCurrent(), true);
  assert.equal(leadCalls, 0);
  fs.rmSync(assembled.file);
  assert.equal(project.status().assembly, null);
  assert.equal(project.status().assembly_stale, true);
});
