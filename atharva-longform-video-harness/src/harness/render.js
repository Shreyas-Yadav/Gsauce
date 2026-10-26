const fs = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { PROJECT, noSymlinks, atomicWrite } = require("./workspace");
const { installScene } = require("./scene-host");
const { sceneGeometry, validateTypography } = require("./project");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const engineSource = () => fs.readFileSync(join(PROJECT, "src/engine.js"), "utf8");
function isGeneratedSceneDefect(error, signal) {
  if (signal?.aborted) return false;
  return error?.name === "SyntaxError" || /Scene runtime error:|scene duration differs|Scene duration must match|Scene must return|draw must be synchronous|Invalid stroke geometry|Math\.random|forbidden browser operation|Text geometry failed during full temporal rendering|JavaScript execution timed out|Execution context was destroyed/u.test(error?.message || "");
}

function browserPath() {
  const path = [process.env.CHROME_PATH, "/Applications/Helium.app/Contents/MacOS/Helium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"]
    .find((candidate) => candidate && fs.existsSync(candidate));
  if (!path) throw new Error("Chromium not found; configure CHROME_PATH.");
  return path;
}

async function withBrowser(operation, { signal, timeoutMs = 120000, software = false } = {}) {
  if (signal?.aborted) throw new Error("Render cancelled.");
  const puppeteer = require("puppeteer-core");
  // Fresh profile, Chromium's normal sandbox, no file-access relaxation or host bindings.
  const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, timeout: 20000,
    protocolTimeout: 20000, env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"]
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    args: ["--disable-background-networking", "--disable-sync", "--no-first-run", ...(software ? ["--disable-gpu"] : [])] });
  let timer;
  let abort;
  const stopped = new Promise((_resolve, reject) => {
    abort = () => { browser.process()?.kill("SIGKILL"); reject(new Error("Render cancelled or deadline reached.")); };
    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try { return await Promise.race([operation(browser), stopped]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    let closeTimer;
    try {
      await Promise.race([browser.close().catch(() => {}), new Promise((done) => {
        closeTimer = setTimeout(() => { browser.process()?.kill("SIGKILL"); done(); }, 1500);
      })]);
    } finally { clearTimeout(closeTimer); }
  }
}

function renderSettings(brief, width) {
  const project = brief.frame || {};
  const aspectWidth = project.width || 1080;
  const aspectHeight = project.height || 1920;
  const logicalWidth = brief.logical_width === undefined ? (project.logicalWidth === undefined ? 1080 : project.logicalWidth) : brief.logical_width;
  const logicalHeight = brief.logical_height === undefined ? (project.logicalHeight === undefined ? logicalWidth * aspectHeight / aspectWidth : project.logicalHeight) : brief.logical_height;
  const outputHeight = Math.round(width * aspectHeight / aspectWidth);
  if (outputHeight % 2 !== 0) throw new Error("Output height must be even for yuv420p video encoding.");
  const geometry = sceneGeometry({ frame: { width: aspectWidth, height: aspectHeight } }, {
    id: "render", logical_width: logicalWidth, logical_height: logicalHeight,
    safe_region: brief.safe_region || (brief.frame ? undefined : { left: 54, top: 150, right: 1026, bottom: 1670 })
  });
  const typography = brief.typography || null;
  if (typography && !validateTypography(typography)) throw new Error("Invalid project typography settings.");
  return { width, height: outputHeight, style: brief.style, configuration: {
    logicalWidth, logicalHeight, outputHeight, duration: brief.duration,
    safeRegion: geometry.safe_region, typography, density: brief.density_policy || { maxWords: 30, maxLongBlocks: 2 }, palette: brief.palette || {},
    subtitles: brief.subtitles || [],
    entryAnchor: brief.entry_anchor || brief.scene?.entry_anchor || null,
    exitAnchor: brief.exit_anchor || brief.scene?.exit_anchor || null,
    timing: brief.timing || null
  } };
}

async function openScene(browser, source, { width, style, configuration = {} }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const height = configuration.outputHeight || Math.round(width * 16 / 9);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const errors = [];
  let blockedRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 300)));
  await page.setRequestInterception(true);
  page.on("request", (request) => { blockedRequests++; request.abort().catch(() => {}); });
  await page.setContent('<body style="margin:0"><iframe sandbox="allow-scripts" style="border:0;width:100vw;height:100vh;display:block"></iframe></body>');
  const frameElement = await page.$("iframe");
  await frameElement.evaluate((el) => {
    el.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; connect-src \'none\'; img-src data:; frame-src \'none\'; worker-src \'none\'; base-uri \'none\'; form-action \'none\'"><body style="margin:0;overflow:hidden"></body>';
  });
  await page.waitForFunction(() => document.querySelector("iframe").contentWindow !== null);
  let frame;
  for (let i = 0; i < 50; i++) {
    frame = await frameElement.contentFrame();
    if (frame && frame.url() === "about:srcdoc") break;
    await new Promise((done) => setTimeout(done, 20));
  }
  if (!frame || frame.url() !== "about:srcdoc") throw new Error("Isolated scene frame did not initialize.");
  await frame.waitForFunction(() => document.body !== null);
  await frame.evaluate((code) => new Function(code)(), engineSource());
  if (style === "risograph") {
    await frame.evaluate((code) => {
      window.Motion = { rng: window.ENG.rngFor };
      window.Riso = new Function(code + "\nreturn Riso;")();
    }, require("./skills").readRisoKit());
  }
  const metadata = await frame.evaluate(installScene, source, width, style, configuration);
  const draw = async (t) => {
    let metrics;
    try { metrics = await frame.evaluate((time) => window.__sceneHost.renderAt(time), t); }
    catch (error) { throw new Error(`Scene runtime error: ${error.message || "draw failed"}`); }
    if (errors.length) throw new Error(`Scene runtime error: ${errors[0]}`);
    return metrics;
  };
  await draw(0); // Identical warmup for each independent page.
  return { page, frame, draw, duration: metadata.duration, blocked: () => blockedRequests };
}

async function verifyScene(workspace, { signal, width = 540, timeoutMs = 30000 } = {}) {
  const brief = JSON.parse(workspace.read("brief.json"));
  const source = workspace.read("scene.js");
  const hashValue = workspace.sceneHash();
  const dir = workspace.artifactDir();
  let result;
  try { result = await withBrowser(async (browser) => {
    const options = renderSettings(brief, width);
    const forward = await openScene(browser, source, options);
    // Riso performs canvas pixel readback: compare seek order in the same rendering
    // context rather than treating cross-origin raster/readback variation as scene drift.
    const reverse = brief.style === "risograph" ? forward : await openScene(browser, source, options);
    if (Math.abs(forward.duration - brief.duration) > 0.001) throw new Error("Scene duration differs from the brief.");
    const times = [0.15, 0.45, 0.70, 0.95].map((phase) => Number((phase * forward.duration).toFixed(3)));
    const images = new Map();
    const samples = [];
    for (let i = 0; i < times.length; i++) {
      const metrics = await forward.draw(times[i]);
      const bytes = await forward.page.screenshot({ type: "png" });
      images.set(times[i], hash(bytes));
      atomicWrite(noSymlinks(PROJECT, join(dir, `still-${i}.png`)), bytes);
      samples.push({ t: times[i], ...metrics });
    }
    const mismatches = [];
    for (const t of [...times].reverse()) {
      await reverse.draw(t);
      const reverseBytes = await reverse.page.screenshot({ type: "png" });
      if (hash(reverseBytes) !== images.get(t)) {
        mismatches.push(t);
        atomicWrite(noSymlinks(PROJECT, join(dir, `reverse-${times.indexOf(t)}.png`)), reverseBytes);
      }
    }
    const blocked = forward.blocked() + reverse.blocked();
    return { hash: hashValue, passed: !mismatches.length && !blocked && samples.every((s) => !s.warnings.length && !s.security_violations && !s.density_warnings.length),
      density_policy: { status: "experimental_heuristic", max_prose_words: options.configuration.density.maxWords, max_long_prose_blocks: options.configuration.density.maxLongBlocks, equations_excluded: true },
      determinism_mode: brief.style === "risograph" ? "same-context-reverse" : "cold-context-reverse",
      duration: forward.duration, resolution: [width, options.height], samples, mismatches, blocked_requests: blocked,
      limitations: ["Four-phase sampling does not inspect every frame.", "Text probes do not prove diagram correctness or learner comprehension."] };
  }, { signal, timeoutMs, software: brief.style === "risograph" }); }
  catch (error) {
    if (!isGeneratedSceneDefect(error, signal)) throw error;
    result = { hash: hashValue, passed: false, source_defect: { type: error.name || "scene_error", evidence: (error.message || "Scene failed to initialize or draw.").slice(0, 1000) },
      duration: brief.duration, resolution: [width, renderSettings(brief, width).height], samples: [], mismatches: [], blocked_requests: 0,
      density_policy: { status: "not_measured", reason: "Scene code failed before a complete sample set." },
      limitations: ["Scene source failed to initialize or draw; edit the scene and rerun verification."] };
  }
  atomicWrite(noSymlinks(PROJECT, join(dir, "verification.json")), JSON.stringify(result, null, 2));
  workspace.state.verification = result;
  workspace.save();
  return result;
}

function checkVideo(path, { width, height = Math.round(width * 16 / 9), fps, frameCount, signal, hasAudio = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=width,height,codec_type,nb_read_frames", "-show_entries", "format=duration", "-of", "json", path],
      { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH }, signal, timeout: 15000 });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; if (text.length > 64000) child.kill(); });
    child.on("error", () => reject(new Error("FFprobe failed or was cancelled.")));
    child.on("close", (code) => {
      try {
        const info = JSON.parse(text);
        const stream = info.streams?.find(s => s.codec_type === "video") || info.streams?.[0];
        const aStream = info.streams?.find(s => s.codec_type === "audio");
        if (code !== 0 || !stream || stream.width !== width || stream.height !== height ||
            Number(stream.nb_read_frames) !== frameCount || !Number.isFinite(Number(info.format?.duration)) ||
            Math.abs(Number(info.format?.duration) - frameCount / fps) > 0.05) {
          throw new Error("Encoded video failed dimension, frame-count or duration validation.");
        }
        if (hasAudio && !aStream) {
          throw new Error("Encoded video expected an audio stream but none was found.");
        }
        resolve();
      } catch (err) { reject(new Error(`Encoded video validation failed: ${err.message}`)); }
    });
  });
}

function encode(dir, { width, height = Math.round(width * 16 / 9), fps, frameCount, signal, audioPath = null, srtPath = null }) {
  const destination = join(dir, "preview.mp4");
  const temporary = join(dir, "preview.tmp.mp4");
  noSymlinks(PROJECT, temporary);
  return new Promise((resolve, reject) => {
    const ffArgs = [
      "-y", "-loglevel", "error", "-framerate", String(fps),
      "-i", join(dir, "frames/f%05d.jpg")
    ];
    if (audioPath && fs.existsSync(audioPath)) {
      ffArgs.push("-i", audioPath);
    }
    if (srtPath && fs.existsSync(srtPath)) {
      ffArgs.push("-i", srtPath);
    }
    ffArgs.push("-map", "0:v:0");
    if (audioPath && fs.existsSync(audioPath)) {
      ffArgs.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "192k");
    }
    if (srtPath && fs.existsSync(srtPath)) {
      const srtIndex = audioPath && fs.existsSync(audioPath) ? "2:s:0" : "1:s:0";
      ffArgs.push("-map", srtIndex, "-c:s", "mov_text", "-metadata:s:s:0", "language=eng");
    }
    ffArgs.push(
      "-frames:v", String(frameCount),
      "-c:v", "libx264", "-preset", "fast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      temporary
    );

    const child = spawn("ffmpeg", ffArgs,
    { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH }, signal, timeout: 45000 });
    child.stderr.resume();
    child.on("error", () => reject(new Error("FFmpeg failed or was cancelled.")));
    child.on("close", async (code) => {
      if (code !== 0) return reject(new Error("FFmpeg encoding failed."));
      try {
        await checkVideo(temporary, { width, height, fps, frameCount, signal, hasAudio: Boolean(audioPath && fs.existsSync(audioPath)) });
        fs.renameSync(temporary, noSymlinks(PROJECT, destination));
        resolve({ width, height, fps, frameCount });
      } catch (error) { reject(error); }
    });
  });
}

async function renderPreview(workspace, { signal, width = 540, fps = 24, timeoutMs = 180000 } = {}) {
  if (![360, 540, 640, 720, 960, 1080, 1280, 1920].includes(width) || ![10, 12, 24, 30].includes(fps)) throw new Error("Unsupported preview settings.");
  const hashValue = workspace.sceneHash();
  if (workspace.state.verification?.hash !== hashValue || !workspace.state.verification.passed) throw new Error("Verify the current scene before rendering.");
  const brief = JSON.parse(workspace.read("brief.json"));
  const dir = workspace.artifactDir();
  const frames = noSymlinks(PROJECT, join(dir, "frames"));
  fs.mkdirSync(frames, { recursive: true, mode: 0o700 });
  const settings = renderSettings(brief, width);
  const identity = { hash: hashValue, width, height: settings.height, fps, duration: brief.duration };
  const manifest = noSymlinks(PROJECT, join(dir, "render-settings.json"));
  if (fs.existsSync(manifest) && fs.readFileSync(manifest, "utf8") !== JSON.stringify(identity)) throw new Error("Use a new scene revision for different render settings.");
  atomicWrite(manifest, JSON.stringify(identity));
  const frameCount = Math.round(brief.duration * fps);
  let captured = 0;
  await withBrowser(async (browser) => {
    const scene = await openScene(browser, workspace.read("scene.js"), settings);
    for (let index = 0; index < frameCount; index++) {
      if (signal?.aborted) throw new Error("Render cancelled.");
      const file = noSymlinks(PROJECT, join(frames, `f${String(index).padStart(5, "0")}.jpg`));
      if (fs.existsSync(file) && fs.statSync(file).size > 100) {
        const bytes = fs.readFileSync(file);
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) continue;
      }
      const metrics = await scene.draw(index / fps);
      if (metrics.security_violations || scene.blocked()) throw new Error("Scene attempted a forbidden browser operation.");
      if (metrics.warnings.length) throw new Error("Text geometry failed during full temporal rendering.");
      atomicWrite(file, await scene.page.screenshot({ type: "jpeg", quality: 92 }));
      captured++;
    }
  }, { signal, timeoutMs, software: brief.style === "risograph" });
  await encode(dir, {
    width,
    height: settings.height,
    fps,
    frameCount,
    signal,
    audioPath: brief.audio ? join(workspace.root, brief.audio) : null,
    srtPath: brief.subtitles_srt ? join(workspace.root, brief.subtitles_srt) : null
  });
  workspace.state.preview = { ...identity, file: "preview.mp4", frame_count: frameCount, captured_frames: captured, audio: Boolean(brief.audio) };
  workspace.save();
  return workspace.state.preview;
}

function resolveSceneVideoPath(scene) {
  if (typeof scene === "string") return scene;
  if (!scene || typeof scene !== "object") throw new Error("Invalid scene reference for boundary extraction.");
  if (typeof scene.path === "string" && scene.path.endsWith(".mp4")) return scene.path;
  if (typeof scene.file === "string" && scene.file.endsWith(".mp4")) return scene.file;
  if (typeof scene.artifactDir === "function") {
    const candidate = join(scene.artifactDir(), "preview.mp4");
    if (fs.existsSync(candidate)) return candidate;
  }
  if (scene.root && scene.state?.preview?.file) {
    const candidate = join(scene.root, scene.state.preview.file);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Rendered preview video not found for scene ${scene.id || "unknown"}.`);
}

function probeVideoMeta(videoPath, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height,r_frame_rate",
      "-show_entries", "format=duration",
      "-of", "json",
      videoPath
    ], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH }, signal, timeout: 15000 });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; if (text.length > 64000) child.kill(); });
    child.on("error", () => reject(new Error("ffprobe failed during boundary probe.")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with ${code} on ${videoPath}.`));
      try {
        const info = JSON.parse(text);
        const duration = Number(info.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid video duration.");
        const hasAudio = Boolean(info.streams?.some((s) => s.codec_type === "audio"));
        resolve({ duration, hasAudio });
      } catch (err) { reject(err); }
    });
  });
}

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH }, signal, timeout: 30000 });
    let errText = "";
    child.stderr.on("data", (chunk) => { if (errText.length < 4000) errText += chunk; });
    child.on("error", () => reject(new Error("FFmpeg boundary command failed.")));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg boundary extraction failed: ${errText.slice(0, 300)}`)));
  });
}

async function extractBoundaryClip(sceneA, sceneB, outPath, { windowSeconds = 5.0, signal } = {}) {
  if (!outPath || typeof outPath !== "string") throw new Error("extractBoundaryClip requires an output file path.");
  const startWall = Date.now();
  const pathA = resolveSceneVideoPath(sceneA);
  const pathB = resolveSceneVideoPath(sceneB);
  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) {
    throw new Error("Both adjacent scenes must have rendered MP4 files before boundary extraction.");
  }
  const [metaA, metaB] = await Promise.all([probeVideoMeta(pathA, signal), probeVideoMeta(pathB, signal)]);
  const tailDuration = Number(Math.min(windowSeconds, metaA.duration).toFixed(3));
  const headDuration = Number(Math.min(windowSeconds, metaB.duration).toFixed(3));
  const startA = Number(Math.max(0, metaA.duration - tailDuration).toFixed(3));

  const { dirname } = require("node:path");
  const { randomUUID } = require("node:crypto");
  const outDir = dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const uid = randomUUID().slice(0, 8);
  const partA = join(outDir, `.boundary_a_${uid}.mp4`);
  const partB = join(outDir, `.boundary_b_${uid}.mp4`);
  const concatFile = join(outDir, `.boundary_concat_${uid}.txt`);
  const tempOut = `${outPath}.${uid}.tmp.mp4`;

  const keepAudio = metaA.hasAudio && metaB.hasAudio;
  const buildSliceArgs = (inputPath, ss, dur, targetPath) => {
    const args = ["-y", "-loglevel", "error", "-ss", String(ss), "-t", String(dur), "-i", inputPath, "-map", "0:v:0"];
    if (keepAudio) args.push("-map", "0:a:0", "-c:a", "aac", "-ar", "48000", "-ac", "2");
    else args.push("-an");
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", targetPath);
    return args;
  };

  try {
    await Promise.all([
      runFfmpeg(buildSliceArgs(pathA, startA, tailDuration, partA), signal),
      runFfmpeg(buildSliceArgs(pathB, 0, headDuration, partB), signal)
    ]);
    fs.writeFileSync(concatFile, `file '${partA.replaceAll("'", "'\\''")}'\nfile '${partB.replaceAll("'", "'\\''")}'\n`, { mode: 0o600 });
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", "-movflags", "+faststart", tempOut], signal);
    fs.renameSync(tempOut, outPath);
  } finally {
    for (const f of [partA, partB, concatFile, tempOut]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore cleanup errors */ }
    }
  }

  const outMeta = await probeVideoMeta(outPath, signal);
  return {
    path: outPath,
    duration: Number(outMeta.duration.toFixed(3)),
    cut_time: tailDuration,
    tail_duration: tailDuration,
    head_duration: headDuration,
    elapsed_ms: Date.now() - startWall
  };
}

module.exports = { verifyScene, renderPreview, extractBoundaryClip, openScene, withBrowser, renderSettings, isGeneratedSceneDefect };
