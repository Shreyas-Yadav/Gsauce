const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { openTopic, createProject, LIMITS, FRAME, researchFrom, manifestFrom } = require("../src/harness/create");
const { GeminiSession, MODELS } = require("../src/harness/gemini");
const { manifest, sceneSources } = require("../src/harness/project-demo");
const { shellQuote } = require("../tools/lit");

const researchResponse = () => ({ status: "completed", steps: [{ type: "google_search_result" }, {
  type: "model_output", content: [{ type: "text", text: manifest.sources[0].evidence,
    annotations: [{ type: "url_citation", url: "https://example.org/fixture-primary", title: "Offline research fixture", start_index: 0, end_index: 20 }] }]
}] });
const planningResponse = () => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({
  ...manifest, target_duration: 120, frame: FRAME,
  scenes: manifest.scenes.map((scene) => ({ ...scene, duration: 60 })),
  claims: manifest.claims.map((claim) => ({ ...claim, source_ids: ["source-1"] }))
}) }] }] });

function topicWorkspace(t, options = {}) {
  const workspace = openTopic(manifest.title, { id: `test-create-${randomUUID().slice(0, 8)}`, ...options });
  t.after(() => fs.rmSync(workspace.root, { recursive: true, force: true }));
  return workspace;
}

function sessionFor(workspace, responses, requests = []) {
  return new GeminiSession({ ...workspace.state.limits, initialCalls: workspace.state.api_calls, client: {
    interactions: { async create(request) { requests.push(request); const result = responses.shift(); if (result instanceof Error) throw result; return result; } }
  }, onEvent(event) {
    if (event.type === "request_started") { workspace.state.api_calls = event.call; workspace.save(); }
  } });
}

test("create command gives topic usage without a manifest or API flags", () => {
  const result = spawnSync(process.execPath, ["tools/lit.js", "create"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node tools\/lit.js create/);
  assert.doesNotMatch(result.stderr, /Unknown command|credentials|max-calls|--live/);
  assert.throws(() => openTopic(""), /Usage/);
  assert.equal(shellQuote("What's $(unsafe) `unsafe`?"), "'What'\\''s $(unsafe) `unsafe`?'");
});

test("grounded Argon research and planning promote into existing production with shared persisted counts", async (t) => {
  const workspace = topicWorkspace(t);
  const requests = [];
  const session = sessionFor(workspace, [researchResponse(), planningResponse(), researchResponse()], requests);
  let produced = 0;
  const produce = async (project, activeSession) => {
    produced++;
    assert.equal(project.workspace, workspace);
    assert.deepEqual(project.manifest.frame, FRAME);
    assert.equal(project.manifest.target_duration, 120);
    assert.equal(project.manifest.sources[0].location, "https://example.org/fixture-primary");
    assert.equal(activeSession.calls, 2);
    await activeSession.create(MODELS.lead, "mock production");
    return { passed: true, status: "fixture_complete" };
  };
  assert.equal((await createProject(workspace, session, { produce })).status, "fixture_complete");
  assert.equal(produced, 1);
  assert.deepEqual(requests[0].tools, [{ type: "google_search" }]);
  assert.equal(requests[0].model, MODELS.lead);
  assert.equal(requests[1].model, MODELS.lead);
  assert.equal(requests.every((request) => request.store === false), true);
  assert.equal(workspace.state.api_calls, 3);
  const resumed = openTopic(manifest.title, { id: workspace.id });
  const resumedRequests = [];
  const resumedSession = sessionFor(resumed, [researchResponse()], resumedRequests);
  await createProject(resumed, resumedSession, { produce: async (_project, activeSession) => {
    assert.equal(activeSession.calls, 3);
    await activeSession.create(MODELS.lead, "mock resumed production");
    return { status: "fixture_complete" };
  } });
  assert.equal(resumedRequests.length, 1);
  assert.equal(resumed.state.api_calls, 4);
  assert.throws(() => openTopic("different topic", { id: workspace.id }), /different topic/);
});

test("saved completed research is reused and an uncertain planning request needs an explicit single retry", async (t) => {
  const workspace = topicWorkspace(t);
  await assert.rejects(createProject(workspace, sessionFor(workspace, [researchResponse(), new Error("connection interrupted")])), /Gemini request failed/);
  assert.equal(workspace.state.api_calls, 2);
  const retrySession = sessionFor(workspace, [planningResponse()]);
  await assert.rejects(createProject(workspace, retrySession), /--retry-planning/);
  assert.equal(retrySession.calls, 2);
  let produced = false;
  await createProject(workspace, retrySession, { retryPlanning: true, produce: async () => { produced = true; return { status: "fixture_complete" }; } });
  assert.equal(retrySession.calls, 3);
  assert.equal(produced, true);
});

test("uncited research, malformed saved plans and unknown source references fail closed without paid repair loops", async (t) => {
  const workspace = topicWorkspace(t);
  const malformed = { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "not JSON" }] }] };
  const session = sessionFor(workspace, [researchResponse(), malformed]);
  await assert.rejects(createProject(workspace, session), /malformed JSON/);
  await assert.rejects(createProject(workspace, session), /malformed JSON/);
  assert.equal(session.calls, 2);
  assert.equal(fs.existsSync(workspace.path("project.json")), false);
  assert.equal(fs.existsSync(workspace.path("bootstrap-response.json")), true);
  assert.equal(workspace.state.bootstrap.planning.status, "invalid");
  const replacementRequests = [];
  await createProject(workspace, sessionFor(workspace, [planningResponse()], replacementRequests), {
    retryPlanning: true, produce: async () => ({ status: "fixture_complete" })
  });
  assert.equal(replacementRequests.length, 1);
  assert.deepEqual(replacementRequests[0].tools, []);
  assert.deepEqual(JSON.parse(workspace.read("bootstrap-rejected-1.json")), malformed);
  assert.equal(workspace.state.api_calls, 3);
  assert.equal(workspace.state.bootstrap.research.attempts, 1);
  assert.equal(workspace.state.bootstrap.planning.attempts, 2);
  assert.throws(() => researchFrom({ steps: [{ type: "model_output", content: [{ type: "text", text: "Uncited answer" }] }] }), /no grounded URL citations/);
  const missingSpan = researchResponse();
  delete missingSpan.steps[1].content[0].annotations[0].end_index;
  assert.throws(() => researchFrom(missingSpan), /supporting text spans/);
  const grounded = researchFrom(researchResponse());
  assert.match(grounded.sources[0].evidence, /A convolution combin/);
  assert.equal(grounded.sources[0].evidence.includes(manifest.sources[0].evidence), false);
  const unknown = planningResponse();
  const data = JSON.parse(unknown.steps[0].content[0].text);
  data.claims[0].source_ids = ["invented-source"];
  unknown.steps[0].content[0].text = JSON.stringify(data);
  assert.throws(() => manifestFrom(unknown, { duration: 120, frame: FRAME }, researchFrom(researchResponse()), LIMITS), /valid source references/);
});

test("citation spans use exact UTF-8 byte boundaries and reject clipping or partial characters", () => {
  const text = "é Before 😀 selected Ω after";
  const selected = "😀 selected Ω";
  const start = Buffer.byteLength("é Before ", "utf8");
  const end = start + Buffer.byteLength(selected, "utf8");
  const response = researchResponse();
  const part = response.steps[1].content[0];
  part.text = text;
  part.annotations[0].start_index = start;
  part.annotations[0].end_index = end;
  const research = researchFrom(response);
  assert.equal(research.citations[0].supported_span, selected);
  assert.equal(research.citations[0].offset_encoding, "utf-8-bytes");
  for (const [badStart, badEnd] of [[start + 1, end], [start, end - 1], [start, Buffer.byteLength(text) + 1]]) {
    part.annotations[0].start_index = badStart;
    part.annotations[0].end_index = badEnd;
    assert.throws(() => researchFrom(response), /supporting text spans/);
  }
});

test("invalid saved research is retained and replaced only once on an explicit planning retry", async (t) => {
  const workspace = topicWorkspace(t);
  const invalid = researchResponse();
  invalid.steps[1].content[0].annotations = [];
  await assert.rejects(createProject(workspace, sessionFor(workspace, [invalid])), /no grounded URL citations/);
  const retrySession = sessionFor(workspace, [researchResponse(), planningResponse()]);
  await assert.rejects(createProject(workspace, retrySession), /no grounded URL citations/);
  assert.equal(retrySession.calls, 1);
  await createProject(workspace, retrySession, { retryPlanning: true, produce: async () => ({ status: "fixture_complete" }) });
  assert.deepEqual(JSON.parse(workspace.read("search-rejected-1.json")), invalid);
  assert.equal(workspace.state.bootstrap.research.attempts, 2);
  assert.equal(workspace.state.api_calls, 3);
  const exhausted = topicWorkspace(t);
  const exhaustedSession = sessionFor(exhausted, [invalid, invalid]);
  await assert.rejects(createProject(exhausted, exhaustedSession), /no grounded URL citations/);
  await assert.rejects(createProject(exhausted, exhaustedSession, { retryPlanning: true }), /no grounded URL citations/);
  await assert.rejects(createProject(exhausted, exhaustedSession, { retryPlanning: true }), /replacement request limit/);
  assert.equal(exhaustedSession.calls, 2);
  assert.equal(exhausted.state.bootstrap.research.attempts, 2);
});

test("create forwards review retry approval to the existing bounded review state without repeating completed reviews", async (t) => {
  const workspace = topicWorkspace(t);
  const session = sessionFor(workspace, [researchResponse(), planningResponse()]);
  let key;
  await createProject(workspace, session, { produce: async (project) => {
    const scene = project.scene(manifest.scenes[0].id);
    scene.writeScene(sceneSources[0]);
    key = `${scene.id}:${scene.sceneHash()}`;
    workspace.state.review_attempts = { [key]: { attempts: 1, status: "uncertain", approved_retry: false } };
    workspace.save();
    return { status: "paused" };
  } });
  let productions = 0;
  await createProject(workspace, session, { approveReviewRetry: true, produce: async (project) => {
    productions++;
    assert.equal(workspace.state.review_attempts[key].approved_retry, true);
    const scene = project.scene(manifest.scenes[0].id);
    scene.state.review = { hash: scene.sceneHash(), findings: [] }; scene.save();
    return { status: "fixture_complete" };
  } });
  assert.equal(session.calls, 2);
  await assert.rejects(createProject(workspace, session, { approveReviewRetry: true, produce: async () => { productions++; } }), /No uncertain current Flash review/);
  assert.equal(productions, 1);
  assert.equal(session.calls, 2);
});
