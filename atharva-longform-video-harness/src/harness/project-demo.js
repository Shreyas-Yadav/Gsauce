const { randomUUID } = require("node:crypto");
const { ProjectWorkspace, assembleProject } = require("./project");
const { verifyScene, renderPreview } = require("./render");

const manifest = {
  title: "How a convolution moves",
  audience: "A curious viewer with no signal-processing background",
  takeaway: "A small kernel can reveal local structure by combining nearby values.",
  target_duration: 4,
  api_limits: { max_calls: 2, max_output_tokens: 512, reviewer_max_output_tokens: 512 },
  frame: { width: 960, height: 540, fps: 12 },
  art_direction: { style: "line", palette: { paper: "#FAF5E8", ink: "#241E28", accent: "#2A857E" },
    typography: { font_family: "Arial", font_weight: 700, label_size: 48 }, recurring_objects: ["a small window"], capabilities: ["line drawing", "spatial movement"] },
  sources: [{ id: "demo-source", location: "offline demo fixture", evidence: "A convolution combines local input values with kernel weights." }],
  claims: [{ id: "local-window", source_ids: ["demo-source"], evidence: "Nearby values are combined with kernel weights.", uncertainty: "A simplified one-dimensional illustration.", simplification: "The demo omits stride, padding, and learned weights." }],
  scenes: [
    { id: "window", order: 0, duration: 2, purpose: "Show a small window moving across values.", claim_ids: ["local-window"], transition: "cut" },
    { id: "combine", order: 1, duration: 2, purpose: "Show nearby values becoming one response.", claim_ids: ["local-window"], transition: "cut" }
  ],
  narration: [], observation_windows: [], captions: []
};
const sceneSources = [
  `return {duration:2, draw(ctx,t,kit) { const x=260+220*(t/2); kit.stroke([[x,220],[x+220,220],[x+220,390],[x,390]], {closed:true,color:kit.PAL.accent,width:8,seed:"window"}); kit.label("LOCAL WINDOW",540,180,{size:42}); kit.label("nearby values",540,470,{size:36}); }};`,
  `return {duration:2, draw(ctx,t,kit) { const x=420+80*(t/2); kit.circle(x,300,76,{color:kit.PAL.accent,width:8,seed:"response"}); kit.label("WEIGHTED SUM",540,180,{size:42}); kit.label("one response",540,470,{size:36}); }};`
];

async function runProjectDemo({ id = `project-demo-${randomUUID().slice(0, 8)}`, width = 960 } = {}) {
  const project = new ProjectWorkspace(id, { create: true, manifest, demo: true, limits: null });
  const sceneResults = [];
  for (const [index, sceneInfo] of manifest.scenes.entries()) {
    const scene = project.scene(sceneInfo.id);
    scene.writeScene(sceneSources[index]);
    const verification = await verifyScene(scene, { width });
    if (!verification.passed) throw new Error(`Demo scene ${sceneInfo.id} failed verification.`);
    const preview = await renderPreview(scene, { width, fps: manifest.frame.fps });
    scene.state.status = "local_preview_only";
    scene.save();
    sceneResults.push({ id: sceneInfo.id, hash: scene.sceneHash(), verification_passed: true, preview });
  }
  const assembly = await assembleProject(project, { allowUnreviewed: true });
  return { id, api_calls: project.workspace.state.api_calls, scene_results: sceneResults, assembly, status: project.status() };
}

module.exports = { manifest, sceneSources, runProjectDemo };
