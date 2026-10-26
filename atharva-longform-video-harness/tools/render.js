// tools/render.js — Headless Chromium / Helium Renderer, Contact Sheet Generator & FFmpeg Encoder
// Usage:
//   node tools/render.js --verify
//   node tools/render.js --sheet=3.5,10,14,19,26,34,45,54,66,81,88,95,104,108,116,121 --cols=4 --out=build/sheets/overview.jpg
//   node tools/render.js --stills=3.5,14.0,26.5,36.0,54.5,66.0,88.0,95.5,107.0,119.5 --out=build/stills
//   node tools/render.js --render --workers=6 --fps=30 --audio=build/audio/master_audio.wav --subs=out/mcculloch_pitts_neuron.srt --out=out/mcculloch_pitts_neuron.mp4

const puppeteer = require("puppeteer-core");
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const idx = a.indexOf("=");
    if (idx === -1) return [a.replace(/^--/, ""), true];
    return [a.slice(2, idx), a.slice(idx + 1)];
  })
);

const BROWSER_CANDIDATES = [
  args.chrome,
  process.env.CHROME_PATH,
  "/Applications/Helium.app/Contents/MacOS/Helium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

const CHROME = BROWSER_CANDIDATES.find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("No Chromium/Helium binary found.");
  process.exit(1);
}

const FPS = Number(args.fps || 30);
const FRAMES_DIR = "build/frames";

function runCmd(cmd, cmdArgs) {
  return new Promise((resolveOk, rejectErr) => {
    const p = spawn(cmd, cmdArgs, { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolveOk() : rejectErr(new Error(`${cmd} exited with ${code}`))));
  });
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 0,
    args: [
      "--allow-file-access-from-files",
      "--ignore-gpu-blocklist",
      "--use-angle=metal",
      "--enable-gpu-rasterization",
      "--window-size=1920,1080",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling"
    ]
  });
}

async function openStudioPage(browser, tag = "") {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on("console", (m) => {
    if (["error", "warn"].includes(m.type())) {
      console.log(`[page${tag}]`, m.text());
    }
  });
  page.on("pageerror", (e) => console.error(`[pageerror${tag}]`, e.message));
  const url = pathToFileURL(resolve("studio.html")).href + "?render=1";
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction("window.ready === true", { timeout: 30000 });
  return page;
}

async function main() {
  const browser = await launchBrowser();
  try {
    if (args.verify) {
      // Determinism verification: seek forward vs seek reverse on fresh pages and compare base64 output
      const testTimes = [1.5, 12.4, 26.2, 35.8, 54.4, 65.8, 84.5, 95.2, 106.5, 118.5];
      const p1 = await openStudioPage(browser, "#fwd");
      const p2 = await openStudioPage(browser, "#rev");
      const fwd = {};
      for (const t of testTimes) {
        fwd[t] = await p1.evaluate((sec) => window.renderAt(sec, "image/png"), t);
      }
      let mismatches = 0;
      for (const t of [...testTimes].reverse()) {
        const rev = await p2.evaluate((sec) => window.renderAt(sec, "image/png"), t);
        if (rev !== fwd[t]) {
          console.error(`Determinism mismatch at t=${t}s`);
          mismatches++;
        }
      }
      if (mismatches === 0) {
        console.log(`VERIFY PASS: All ${testTimes.length} sample timestamps are 100% byte-identical across forward and reverse cold seeks.`);
      } else {
        process.exitCode = 1;
      }
      return;
    }

    if (args.sheet) {
      const page = await openStudioPage(browser);
      const times = String(args.sheet).split(",").map(Number);
      const cols = Number(args.cols || 4);
      const w = Number(args.w || 480);
      const outPath = args.out || "build/sheets/sheet.jpg";
      mkdirSync(dirname(outPath), { recursive: true });
      const dataUrl = await page.evaluate((ts, c, tw) => window.renderSheet(ts, c, tw), times, cols, w);
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      writeFileSync(outPath, buf);
      console.log(`Wrote contact sheet: ${outPath} (${times.length} frames)`);
      return;
    }

    if (args.stills) {
      const page = await openStudioPage(browser);
      const times = String(args.stills).split(",").map(Number);
      const outDir = args.out || "build/stills";
      mkdirSync(outDir, { recursive: true });
      for (const t of times) {
        const dataUrl = await page.evaluate((sec) => window.renderAt(sec, "image/png"), t);
        const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
        const file = `${outDir}/still_${t.toFixed(2).replace(".", "_")}s.png`;
        writeFileSync(file, buf);
        console.log(`Wrote 1080p still: ${file}`);
      }
      return;
    }

    if (args.render) {
      const probe = await openStudioPage(browser, "#probe");
      const duration = await probe.evaluate(() => window.__lit.duration);
      await probe.close();

      const totalFrames = Math.ceil(duration * FPS);
      const workers = Number(args.workers || 6);
      mkdirSync(FRAMES_DIR, { recursive: true });

      const todo = [];
      for (let i = 0; i < totalFrames; i++) {
        const f = `${FRAMES_DIR}/f${String(i).padStart(5, "0")}.jpg`;
        if (!existsSync(f) || statSync(f).size < 2000) {
          todo.push(i);
        }
      }

      console.log(`Rendering ${todo.length} frames (${totalFrames} total at ${FPS} fps) across ${workers} parallel Helium tabs...`);
      let cursor = 0;
      let completed = 0;
      const t0 = Date.now();

      await Promise.all(
        Array.from({ length: workers }, async (_, wIdx) => {
          const page = await openStudioPage(browser, `#w${wIdx}`);
          while (cursor < todo.length) {
            const frameIdx = todo[cursor++];
            const sec = frameIdx / FPS;
            const dataUrl = await page.evaluate((t) => window.renderAt(t, "image/jpeg", 0.94), sec);
            const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
            const fPath = `${FRAMES_DIR}/f${String(frameIdx).padStart(5, "0")}.jpg`;
            writeFileSync(fPath + ".tmp", buf);
            renameSync(fPath + ".tmp", fPath);
            completed++;
            if (completed % 150 === 0 || completed === todo.length) {
              const elapsed = (Date.now() - t0) / 1000;
              const rate = completed / elapsed;
              const eta = (todo.length - completed) / rate;
              console.log(
                `  [${completed}/${todo.length}] (${((completed / todo.length) * 100).toFixed(1)}%) | ${rate.toFixed(1)} fps | ETA: ${eta.toFixed(1)}s`
              );
            }
          }
          await page.close();
        })
      );

      // Encode final MP4 with FFmpeg (muxing master WAV audio + soft-muxing SRT subtitle track)
      const outMp4 = args.out || "out/mcculloch_pitts_neuron.mp4";
      mkdirSync(dirname(outMp4), { recursive: true });
      const audioPath = args.audio || "build/audio/master_audio.wav";
      const subsPath = args.subs || "out/mcculloch_pitts_neuron.srt";

      console.log(`Encoding ${totalFrames} frames + master audio + subtitle track -> ${outMp4}`);
      const ffArgs = [
        "-y",
        "-loglevel", "error",
        "-stats",
        "-framerate", String(FPS),
        "-i", `${FRAMES_DIR}/f%05d.jpg`,
        "-i", audioPath
      ];

      if (existsSync(subsPath)) {
        ffArgs.push(
          "-i", subsPath,
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-map", "2:s:0",
          "-c:s", "mov_text",
          "-metadata:s:s:0", "language=eng",
          "-metadata:s:s:0", "title=English"
        );
      } else {
        ffArgs.push("-map", "0:v:0", "-map", "1:a:0");
      }

      ffArgs.push(
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "17",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        outMp4
      );

      await runCmd("ffmpeg", ffArgs);
      console.log(`Successfully produced: ${outMp4}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
