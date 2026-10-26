const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { parseArgs } = require("node:util");
const { MODELS, credentials, GeminiProbe, toolRoundTrip, outputText, validateReview } = require("../src/harness/gemini");
const { FIXTURE_DIR } = require("./gemini_fixtures");

const REVIEW_PROMPT = 'Inspect this synthetic arithmetic animation for factual or visual defects. Do not plan or generate content. Return only JSON: {"findings":[{"severity":"major","timestamp_seconds":0,"evidence":"what is visibly wrong","expected":"correct behavior"}]}. Use the image time 0 or actual video timestamps (0–2 seconds). Report only supported observations; an empty findings array is allowed.';

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean", default: false },
    check: { type: "string", default: "all" },
    "max-calls": { type: "string" }, "max-output-tokens": { type: "string" }
  } });
  const key = credentials();
  if (!["all", "tool", "image", "video"].includes(values.check)) throw new Error("Unknown capability check.");
  const requiredCalls = values.check === "all" ? 4 : values.check === "tool" ? 2 : 1;
  const media = { image: join(FIXTURE_DIR, "frame-00.png"), video: join(FIXTURE_DIR, "probe.mp4") };
  console.log(JSON.stringify({ mode: values.live ? "live" : "offline-preflight", credential_present: Boolean(key),
    models: MODELS, sdk: "2.29.1", fixtures_ready: Object.values(media).every(existsSync) }));
  if (!values.live) {
    console.log("No API calls made. Run npm run smoke:fixtures to prepare local synthetic media.");
    return;
  }
  if (!key) throw new Error("Configure GEMINI_API_KEY or Gemini_API_KEY in local .env; never paste keys into chat.");
  if (!values["max-calls"] || !values["max-output-tokens"]) throw new Error("Live mode requires --max-calls=4 --max-output-tokens=4096 (paid-call opt-in; not a dollar cap).");
  if (Number(values["max-calls"]) !== requiredCalls) throw new Error(`Selected check needs exactly ${requiredCalls} requests; no partial paid runs.`);
  if (!Object.values(media).every(existsSync)) throw new Error("Run npm run smoke:fixtures first.");
  const { GoogleGenAI } = require("@google/genai");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  const probe = new GeminiProbe({ client: new GoogleGenAI({ apiKey: key }),
    maxCalls: Number(values["max-calls"]), maxOutputTokens: Number(values["max-output-tokens"]),
    signal: controller.signal, onEvent: (event) => console.log(JSON.stringify(event)) });
  try {
    if (["all", "tool"].includes(values.check)) console.log(JSON.stringify(await toolRoundTrip(probe)));
    for (const [kind, path] of Object.entries(media)) {
      if (!["all", kind].includes(values.check)) continue;
      const bytes = readFileSync(path);
      if (bytes.length > 2 * 1024 * 1024) throw new Error("Synthetic fixture exceeds the 2 MiB upload limit.");
      const result = await probe.create(MODELS.reviewer, [{ type: "text", text: REVIEW_PROMPT },
        { type: kind, mime_type: kind === "image" ? "image/png" : "video/mp4", data: bytes.toString("base64") }]);
      if (result.status !== "completed") throw new Error("Reviewer did not complete.");
      // Private, Git-ignored evidence allows parser fixes without paying to regenerate.
      writeFileSync(join(FIXTURE_DIR, `${kind}-review.json`), JSON.stringify({
        model: MODELS.reviewer, recorded_at: new Date().toISOString(), text: outputText(result)
      }, null, 2), { mode: 0o600 });
      const review = validateReview(outputText(result));
      // A schema-valid answer alone is not a successful reviewer test.
      const caught = review.findings.some((f) => /2\s*\+\s*2|five|\b5\b/i.test(f.evidence) && /four|\b4\b/i.test(f.expected));
      console.log(JSON.stringify({ capability: `${kind}_review`, schema_valid: true, seeded_defect_detected: caught, findings: review.findings.length }));
      if (!caught) throw new Error(`Flash missed the seeded arithmetic defect in the ${kind}.`);
    }
    console.log(`PASS: ${values.check} capability check(s). This is not full reviewer validation.`);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

if (require.main === module) main().catch((error) => {
  // Only our own sanitized errors reach this point; never print SDK objects/stacks.
  const key = (() => { try { return credentials(); } catch { return null; } })();
  let message = error.message || "Smoke test failed.";
  if (key) message = message.split(key).join("[REDACTED]");
  message = message.replace(/AIza[\w-]+/g, "[REDACTED]");
  console.error(message);
  process.exitCode = 1;
});

module.exports = { main, REVIEW_PROMPT };
