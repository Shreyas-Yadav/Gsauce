const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeFileSync, readFileSync } = require("node:fs");
const { Workspace, PROJECT } = require("../src/harness/workspace");
const { verifyScene, renderPreview } = require("../src/harness/render");
const { brief, source } = require("../src/harness/demo");

function setup(code = source) {
  const ws = new Workspace(`render-${randomUUID().slice(0, 8)}`, { create: true, base: join(PROJECT, "build/render-tests"), brief, limits: null });
  ws.writeScene(code);
  return ws;
}

test("real browser renders a deterministic vertical scene and resumes cached frames", { timeout: 90000 }, async () => {
  const ws = setup();
  const result = await verifyScene(ws, { width: 360 });
  assert.equal(result.passed, true);
  assert.equal(result.samples.length, 4);
  assert.deepEqual(result.resolution, [360, 640]);
  const preview = await renderPreview(ws, { width: 360, fps: 10 });
  assert.equal(preview.frame_count, 120);
  assert.equal(preview.audio, false);
  const resumed = await renderPreview(ws, { width: 360, fps: 10 });
  assert.equal(resumed.captured_frames, 0);
  writeFileSync(join(ws.artifactDir(), "frames/f00010.jpg"), "broken".repeat(100));
  const repaired = await renderPreview(ws, { width: 360, fps: 10 });
  assert.equal(repaired.captured_frames, 1);
});

test("real geometry probes catch overflow and overlapping labels", { timeout: 40000 }, async () => {
  const ws = setup('return {duration:12,draw(ctx,t,kit){kit.label("outside",10,50);kit.label("one",500,500);kit.label("two",500,500);}};');
  const result = await verifyScene(ws, { width: 360 });
  assert.equal(result.passed, false);
  assert.ok(result.samples[0].warnings.some((warning) => warning.includes("safe region")));
  assert.ok(result.samples[0].warnings.some((warning) => warning.includes("Overlapping")));
  await assert.rejects(renderPreview(ws), /Verify/);
});

test("original spline-corner failure: wide closed strokes are subdivided before smoothing", { timeout: 40000 }, async () => {
  const ws = setup('const original=window.ENG.penStroke;window.ENG.penStroke=(ctx,p,o)=>{if(p.length<20)throw Error("not subdivided");for(let i=1;i<p.length;i++)if(Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1])>60.01)throw Error("long segment");original(ctx,p,o);};return {duration:12,draw(ctx,t,kit){kit.stroke([[100,200],[980,200],[980,1600],[100,1600],[100,200]],{closed:true});}};');
  assert.equal((await verifyScene(ws, { width: 360 })).passed, true);
});

test("original prose-overload failure blocks rendering while numeric tokens remain telemetry", { timeout: 40000 }, async () => {
  const ws = setup('return {duration:12,draw(ctx,t,kit){for(let i=0;i<5;i++)kit.label("This redundant explanation competes with the main diagram",540,400+i*100,{size:24});}};');
  const result = await verifyScene(ws, { width: 360 });
  assert.equal(result.passed, false);
  assert.ok(result.samples[0].density_warnings.length > 0);
  await assert.rejects(renderPreview(ws), /Verify/);
});

test("reverse-seek comparison catches hidden accumulating scene state", { timeout: 40000 }, async () => {
  const ws = setup('let count=0;return {duration:12,draw(ctx,t,kit){kit.label(String(++count),540,500);}};');
  const result = await verifyScene(ws, { width: 360 });
  assert.equal(result.passed, false);
  assert.ok(result.mismatches.length > 0);
});

test("generated browser code cannot read its parent or use a network connection", { timeout: 40000 }, async () => {
  const ws = setup('let blocked=false;try{parent.document.body.innerHTML}catch{blocked=true;} fetch("https://example.com").catch(()=>{});return {duration:12,draw(ctx,t,kit){if(!blocked)throw Error("parent escaped");kit.label("isolated",540,500);}};');
  const result = await verifyScene(ws, { width: 360 });
  assert.equal(result.passed, false);
  assert.ok(result.samples.some((sample) => sample.security_violations > 0));
});

test("browser initialization and draw errors fail instead of becoming valid previews", { timeout: 40000 }, async () => {
  const ws = setup('return {duration:12,draw(){throw Error("deliberate draw failure")}};');
  const result = await verifyScene(ws, { width: 360 });
  assert.equal(result.passed, false);
  assert.match(result.source_defect.evidence, /deliberate draw failure/);
  assert.deepEqual(ws.state.verification, result);
  assert.deepEqual(JSON.parse(readFileSync(join(ws.artifactDir(), "verification.json"), "utf8")), result);
  assert.equal(ws.gate({ requireReview: false }).passed, false);
  assert.equal(ws.state.preview, null);
});

test("infinite generated code is stopped by the renderer watchdog", { timeout: 15000 }, async () => {
  const ws = setup('while(true){}');
  await assert.rejects(verifyScene(ws, { width: 360, timeoutMs: 2500 }), /deadline|closed|Target|Protocol/);
});
