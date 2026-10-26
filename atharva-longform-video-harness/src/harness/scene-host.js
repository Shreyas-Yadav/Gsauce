// Executed only inside an opaque-origin, sandboxed browser frame. Never in Node.
function installScene(source, width, style, configuration = {}) {
  const W = configuration.logicalWidth || 1080, H = configuration.logicalHeight || 1920;
  const outputHeight = configuration.outputHeight || Math.round(width * H / W);
  const safe = configuration.safeRegion || { left: 54, top: 150, right: 1026, bottom: 1670 };
  const expectedDuration = configuration.duration;
  const density = configuration.density || { maxWords: 30, maxLongBlocks: 2 };
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = outputHeight;
  canvas.style.cssText = "width:100vw;height:100vh;display:block";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  const engine = window.ENG;
  const press = style === "risograph" ? window.Riso.press({ px: [width, canvas.height], k: width / W }) : null;
  const tracked = new WeakSet();
  const PAL = Object.freeze({ paper: "#FAF5E8", ink: "#241E28", accent: "#2A857E", gold: "#E8A838", red: "#C83E37", ...(configuration.palette || {}) });
  let texts = [], securityViolations = 0;
  document.addEventListener("securitypolicyviolation", () => securityViolations++);
  function trackText(context) {
    if (tracked.has(context)) return context;
    tracked.add(context);
    const nativeFillText = context.fillText.bind(context);
    context.fillText = function (text, x, y, maxWidth) {
    const m = context.measureText(String(text));
    const k = W / canvas.width;
    const matrix = context.getTransform();
    const corners = [[x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent],
      [x + m.actualBoundingBoxRight, y - m.actualBoundingBoxAscent],
      [x - m.actualBoundingBoxLeft, y + m.actualBoundingBoxDescent],
      [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent]]
      .map(([px, py]) => [k * (matrix.a * px + matrix.c * py + matrix.e), k * (matrix.b * px + matrix.d * py + matrix.f)]);
    if (context.globalAlpha > 0.05) texts.push({ text: String(text),
      box: [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])),
        Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))] });
    return maxWidth === undefined ? nativeFillText(text, x, y) : nativeFillText(text, x, y, maxWidth);
  };
    return context;
  }
  trackText(ctx);
  const ink = (color) => color === PAL.accent || color === "blue" ? "blue" : color === PAL.gold || color === "yellow" ? "yellow" : color === PAL.red || color === "pink" ? "pink" : "navy";
  const plate = (name = "navy", kind = "solid") => trackText(press.plate(name, kind));
  function prepared(points, closed) {
    if (!Array.isArray(points) || points.length < 2 || points.length > 2000 || points.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) throw new Error("Invalid stroke geometry.");
    const clean = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.001);
    if (clean.length < 2) return clean;
    if (closed && Math.hypot(clean[0][0] - clean.at(-1)[0], clean[0][1] - clean.at(-1)[1]) < 0.001) clean.pop();
    const path = closed ? [...clean, clean[0]] : clean;
    const dense = engine.densify(path, 60);
    return closed ? dense.slice(0, -1) : dense;
  }
  const rawTiming = configuration.timing || {};
  const timingCues = rawTiming.cues || {};
  const timingWords = Array.isArray(rawTiming.words) ? rawTiming.words : [];
  const timing = Object.freeze({
    measuredDuration: rawTiming.measured_duration ?? expectedDuration ?? 0,
    speechStart: rawTiming.speech_start ?? 0,
    speechEnd: rawTiming.speech_end ?? (expectedDuration || 0),
    observationPause: rawTiming.observation_pause ?? 0,
    cues: Object.freeze({ ...timingCues }),
    words: timingWords,
    cue(wordOrKey, fallback = 0) {
      if (!wordOrKey) return fallback;
      const key = String(wordOrKey).toLowerCase();
      if (Number.isFinite(timingCues[wordOrKey])) return timingCues[wordOrKey];
      if (Number.isFinite(timingCues[key])) return timingCues[key];
      const match = timingWords.find((w) => String(w.word || "").toLowerCase().replace(/[^\w]/g, "") === key);
      return match && Number.isFinite(match.start) ? match.start : fallback;
    }
  });
  const kit = Object.freeze({
    W, H, PAL, clamp: engine.clamp, lerp: engine.lerp, ease: engine.easeInOutCubic, rng: engine.rngFor,
    entryAnchor: configuration.entryAnchor ? Object.freeze({ ...configuration.entryAnchor }) : null,
    exitAnchor: configuration.exitAnchor ? Object.freeze({ ...configuration.exitAnchor }) : null,
    timing,
    riso: press ? Object.freeze({ plate, tone: window.Riso.tone, knockout: (fn) => press.knockout(fn), ramp: window.Riso.ramp, radial: window.Riso.radial }) : null,
    stroke(points, options = {}) { engine.penStroke(press ? plate(ink(options.color)) : ctx, prepared(points, options.closed), { width: 5, color: PAL.ink, seed: "stroke", ...options, ...(press ? { color: "#000" } : {}) }); },
    circle(x, y, r, options = {}) {
      const points = Array.from({ length: 49 }, (_, i) => [x + r * Math.cos(i * Math.PI / 24), y + r * Math.sin(i * Math.PI / 24)]);
      engine.penStroke(press ? plate(ink(options.color)) : ctx, points, { closed: true, width: 5, color: PAL.ink, seed: "circle", ...options, ...(press ? { color: "#000" } : {}) });
    },
    wash(points, color, options = {}) { engine.wetWash(press ? plate(ink(color), "screen") : ctx, prepared(points, true), press ? "#000000" : color, { alpha: 0.3, bleed: 2, dx: 0, dy: 0, seed: "wash", ...options }); },
    label(text, x, y, options = {}) {
      const target = press ? plate(ink(options.color)) : ctx;
      const typography = configuration.typography;
      const family = typography?.font_family || (press ? "Trebuchet MS" : "Chalkboard SE");
      const weight = typography?.font_weight || (press ? 800 : 400);
      const size = options.size || typography?.label_size || 48;
      target.save();
      target.font = `${weight} ${size}px '${family}', sans-serif`;
      target.fillStyle = press ? "#000" : options.color || PAL.ink;
      target.textAlign = options.align || "center";
      target.fillText(String(text), x, y);
      target.restore();
    }
  });
  Object.defineProperty(Math, "random", { value() { throw new Error("Use kit.rng with a stable seed, not Math.random."); }, writable: false });
  let scene;
  try { scene = new Function('"use strict";\n' + source)(); }
  catch (error) { throw new Error(`Scene runtime error: ${error?.message || "scene initialization failed"}`); }
  const minDuration = Number.isFinite(expectedDuration) ? expectedDuration : 10;
  const maxDuration = Number.isFinite(expectedDuration) ? expectedDuration : 15;
  if (!scene || typeof scene.draw !== "function" || !Number.isFinite(scene.duration) || scene.duration < minDuration || scene.duration > maxDuration) {
    throw new Error("Scene duration must match its approved scene brief.");
  }
  function renderAt(t) {
    if (!Number.isFinite(t) || t < 0 || t > scene.duration) throw new Error("Invalid seek time.");
    canvas.width = width; // Reset transforms, clipping, and state before every seek.
    texts = [];
    if (press) {
      press.each((g) => { g.reset(); g.setTransform(width / W, 0, 0, width / W, 0, 0); });
      press.begin(Math.floor(t * 12) / 12);
    }
    ctx.scale(width / W, width / W);
    ctx.fillStyle = style === "line" ? "#FFFDF8" : PAL.paper;
    ctx.fillRect(0, 0, W, H);
    const result = scene.draw(ctx, press ? Math.floor(t * 12) / 12 : t, kit);
    if (result && typeof result.then === "function") throw new Error("draw must be synchronous.");
    if (press) press.print(ctx, { key: Math.floor(t * 12) / 12 });

    // Optional burned-in subtitles on presentation canvas (excluded from non-subtitle prose density counting)
    if (configuration.subtitles && configuration.subtitles.length) {
      engine.drawBurnedSubtitles(ctx, t, configuration.subtitles, { width: W, height: H, safeBottom: safe.bottom });
    }
    const warnings = [];
    for (const item of texts) {
      const [x0, y0, x1, y1] = item.box;
      if (![x0, y0, x1, y1].every(Number.isFinite)) warnings.push("Non-finite text geometry.");
      else if (x0 < safe.left || x1 > safe.right || y0 < safe.top || y1 > safe.bottom) warnings.push(`Text crosses configured safe region: ${item.text.slice(0, 80)}`);
    }
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].box, b = texts[j].box;
      if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 4 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 4) {
        warnings.push("Overlapping text bounds.");
      }
    }
    const proseCounts = texts.map((item) => /[=Σ∫×÷]/u.test(item.text) ? 0 : (item.text.match(/\p{L}+/gu) || []).length);
    const proseWords = proseCounts.reduce((sum, count) => sum + count, 0);
    const longProseBlocks = proseCounts.filter((count) => count >= 6).length;
    // Experimental production heuristic, not a universal learning-science limit.
    const densityWarnings = proseWords > density.maxWords || longProseBlocks > density.maxLongBlocks ? ["Reduce redundant prose: use concise labels and let the mechanism explain."] : [];
    return { warnings: [...new Set(warnings)], density_warnings: densityWarnings, prose_words: proseWords, long_prose_blocks: longProseBlocks,
      words: texts.reduce((n, item) => n + (item.text.match(/[\p{L}\p{N}]+/gu) || []).length, 0),
      text_blocks: texts.length, security_violations: securityViolations };
  }
  window.__sceneHost = Object.freeze({ renderAt, duration: scene.duration });
  return { duration: scene.duration };
}

module.exports = { installScene };
