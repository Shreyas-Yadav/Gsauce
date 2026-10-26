const { readFileSync } = require("node:fs");
const { parseEnv } = require("node:util");

const MODELS = Object.freeze({ lead: "gemini-4-argon", reviewer: "gemini-3.8-flash", tts: "gemini-3.8-flash-lite-tts", ttsStudio: "gemini-3.8-flash-tts" });
const KEY_NAMES = ["GEMINI_API_KEY", "Gemini_API_KEY", "GOOGLE_API_KEY"];

function credentials(env = process.env, envPath = ".env") {
  let local = {};
  try {
    local = parseEnv(readFileSync(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read local environment configuration.");
  }
  // Process variables take precedence without copying secrets into process.env.
  const active = KEY_NAMES.map((name) => env[name]?.trim()).filter(Boolean);
  const values = active.length ? active : KEY_NAMES.map((name) => local[name]?.trim()).filter(Boolean);
  if (new Set(values).size > 1) throw new Error("Conflicting Gemini credentials; configure only one key.");
  return values[0] || null;
}

function outputText(interaction) {
  return (interaction.steps || []).filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || []).filter((part) => part.type === "text")
    .map((part) => part.text).join("\n");
}

function safeFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "Request cancelled or timed out; remote billing may still apply.";
  if (status === 401 || status === 403) return "Gemini authentication or model access denied.";
  if (status === 404) return "Requested Gemini model or endpoint is unavailable.";
  if (status === 429) return "Gemini quota or rate limit reached; no automatic retry.";
  return `Gemini request failed${Number.isInteger(status) && status >= 400 && status < 600 ? ` (HTTP ${status})` : ""}; raw provider details suppressed.`;
}

function failureMetadata(error, returnedStatus) {
  const status = Number(error?.status ?? error?.statusCode);
  const names = ["Error", "APIError", "APIConnectionError", "APIConnectionTimeoutError", "AbortError", "TimeoutError", "HTTPError", "ValidationError"];
  return {
    error_type: names.includes(error?.name) ? error.name : "provider_error",
    ...(Number.isInteger(status) && status >= 400 && status < 600 ? { http_status: status } : {}),
    ...(returnedStatus ? { interaction_status: returnedStatus } : {})
  };
}

class GeminiSession {
  constructor({ client, maxCalls, maxOutputTokens, reviewerMaxOutputTokens = Math.min(maxOutputTokens, 8192), reserveReviewer = false, timeoutMs = 120000, signal, onEvent = () => {}, initialCalls = 0, thinkingLevel = "medium" }) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 32) throw new Error("maxCalls must be 1–32.");
    if (!Number.isInteger(initialCalls) || initialCalls < 0 || initialCalls > maxCalls) throw new Error("Invalid initial request count.");
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 512 || maxOutputTokens > 65536) throw new Error("maxOutputTokens must be 512–65536.");
    if (!Number.isInteger(reviewerMaxOutputTokens) || reviewerMaxOutputTokens < 512 || reviewerMaxOutputTokens > 8192) throw new Error("reviewerMaxOutputTokens must be 512–8192.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error("Invalid request timeout.");
    if (!["low", "medium", "high"].includes(thinkingLevel)) throw new Error("Invalid thinking level.");
    Object.assign(this, { client, maxCalls, maxOutputTokens, reviewerMaxOutputTokens, reserveReviewer, timeoutMs, signal, onEvent, thinkingLevel });
    this.calls = initialCalls;
  }

  async create(model, input, tools = [], systemInstruction) {
    if (!Object.values(MODELS).includes(model)) throw new Error("Model not allowed in the generation harness.");
    if (this.signal?.aborted) throw new Error("Run cancelled before request.");
    if (this.calls >= this.maxCalls) throw new Error("API request limit reached.");
    if (this.reserveReviewer && model === MODELS.lead && this.calls >= this.maxCalls - 1) throw new Error("Last API request is reserved for Flash review.");
    const call = ++this.calls;
    const start = Date.now();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, deadline]) : deadline;
    this.onEvent({ type: "request_started", call, model });
    let returnedStatus;
    try {
      const result = await this.client.interactions.create({
        model, input, tools, store: false,
        ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
        generation_config: { thinking_level: this.thinkingLevel, max_output_tokens: model === MODELS.reviewer ? this.reviewerMaxOutputTokens : this.maxOutputTokens }
      }, { timeout: this.timeoutMs, maxRetries: 0, fetchOptions: { signal } });
      returnedStatus = ["completed", "requires_action", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(result.status) ? result.status : "unknown";
      const usage = Object.fromEntries(["total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_tokens"]
        .filter((name) => Number.isSafeInteger(result.usage?.[name]) && result.usage[name] >= 0)
        .map((name) => [name, result.usage[name]]));
      this.onEvent({ type: ["completed", "requires_action"].includes(returnedStatus) ? "request_completed" : "request_incomplete", call, model, status: returnedStatus, elapsed_ms: Date.now() - start, usage });
      if (!["completed", "requires_action"].includes(returnedStatus)) throw new Error("Interaction did not complete.");
      return result;
    } catch (error) {
      this.onEvent({ type: "request_failed", call, model, elapsed_ms: Date.now() - start, ...failureMetadata(error, returnedStatus) });
      throw new Error(returnedStatus === "incomplete"
        ? "Gemini request failed: thinking and output exhausted the approved token limit; no generated actions were executed."
        : safeFailure(error));
    }
  }
}

class GeminiProbe extends GeminiSession {
  constructor(options) {
    if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 4) throw new Error("maxCalls must be 1–4.");
    if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 512 || options.maxOutputTokens > 8192) throw new Error("maxOutputTokens must be 512–8192.");
    super({ ...options, thinkingLevel: "low" });
  }
}

const SUM_TOOL = Object.freeze({
  type: "function", name: "sum_probe", description: "Add two small integers locally for a capability test.",
  parameters: {
    type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"], additionalProperties: false
  }
});

function executeProbeTool(step) {
  const args = step?.arguments;
  if (step?.type !== "function_call" || step.name !== SUM_TOOL.name || typeof step.id !== "string" || !step.id ||
      !args || Object.keys(args).sort().join(",") !== "a,b" ||
      ![args.a, args.b].every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 100)) {
    throw new Error("Rejected unexpected probe tool call or arguments.");
  }
  return { type: "function_result", name: step.name, call_id: step.id,
    result: [{ type: "text", text: JSON.stringify({ sum: args.a + args.b }) }] };
}

async function toolRoundTrip(probe) {
  const input = [{ type: "user_input", content: [{ type: "text", text: "Call sum_probe exactly once with a=19 and b=23. After the tool result, reply with only the sum." }] }];
  const first = await probe.create(MODELS.lead, input, [SUM_TOOL]);
  const calls = (first.steps || []).filter((step) => step.type === "function_call");
  if (calls.length !== 1) throw new Error("Argon did not request exactly one probe tool call.");
  if (calls[0].arguments?.a !== 19 || calls[0].arguments?.b !== 23) throw new Error("Argon requested incorrect probe operands.");
  const toolResult = executeProbeTool(calls[0]);
  // Preserve opaque thought signatures exactly for stateless continuation.
  const history = [...input, ...first.steps.filter((step) => step.type !== "user_input"), toolResult];
  const final = await probe.create(MODELS.lead, history, [SUM_TOOL]);
  if (final.status !== "completed" || (final.steps || []).some((step) => step.type === "function_call") || outputText(final).trim() !== "42") {
    throw new Error("Argon tool-result continuation failed its exact-answer check.");
  }
  return { tool_round_trip: "passed" };
}

function validateReview(text, duration = 2) {
  let json = text.trim();
  // Normalize one surrounding Markdown fence, never extract JSON from prose.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(json);
  if (fenced) json = fenced[1];
  let review;
  try { review = JSON.parse(json); }
  catch { throw new Error("Reviewer returned malformed JSON; response retained locally for inspection."); }
  if (!review || !Array.isArray(review.findings)) throw new Error("Reviewer omitted findings array.");
  for (const finding of review.findings) {
    if (!finding || !["minor", "moderate", "major", "critical"].includes(finding.severity) ||
        !Number.isFinite(finding.timestamp_seconds) || finding.timestamp_seconds < 0 || finding.timestamp_seconds > duration ||
        !["evidence", "expected"].every((key) => typeof finding[key] === "string" && finding[key].trim())) {
      throw new Error("Reviewer returned an invalid finding.");
    }
  }
  return review;
}

module.exports = { MODELS, credentials, outputText, safeFailure, GeminiSession, GeminiProbe, SUM_TOOL, executeProbeTool, toolRoundTrip, validateReview };
