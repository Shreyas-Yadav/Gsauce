// Local synthetic media only; no model calls and no project-content uploads.
const { mkdirSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const FIXTURE_DIR = resolve(__dirname, "../build/milestone-a");

async function createFixtures() {
  const puppeteer = require("puppeteer-core");
  const chrome = [process.env.CHROME_PATH, "/Applications/Helium.app/Contents/MacOS/Helium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));
  if (!chrome) throw new Error("Set CHROME_PATH to a Chromium executable.");
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 1 });
    await page.setContent('<body style="margin:0;background:#faf5e8"><canvas width="360" height="640"></canvas></body>');
    for (let i = 0; i < 20; i++) {
      await page.evaluate((frame) => {
        const ctx = document.querySelector("canvas").getContext("2d");
        ctx.fillStyle = "#faf5e8";
        ctx.fillRect(0, 0, 360, 640);
        ctx.fillStyle = "#252525";
        ctx.font = "bold 36px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("2 + 2 = 5", 180, 180);
        ctx.font = "20px sans-serif";
        ctx.fillText("Arithmetic example", 180, 230);
        ctx.fillStyle = "#b72d35";
        ctx.fillRect(30 + frame * 12, 360, 60, 60);
      }, i);
      await page.screenshot({ path: join(FIXTURE_DIR, `frame-${String(i).padStart(2, "0")}.png`) });
    }
  } finally {
    await browser.close();
  }
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "10", "-i",
    join(FIXTURE_DIR, "frame-%02d.png"), "-frames:v", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    join(FIXTURE_DIR, "probe.mp4")], { timeout: 30000, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("Synthetic video encoding failed; check FFmpeg availability.");
  return { image: join(FIXTURE_DIR, "frame-00.png"), video: join(FIXTURE_DIR, "probe.mp4") };
}

if (require.main === module) createFixtures().then(() => console.log("Synthetic PNG and 2-second vertical MP4 ready in build/milestone-a."))
  .catch(() => { console.error("Fixture generation failed. Check Chromium and FFmpeg."); process.exitCode = 1; });

module.exports = { FIXTURE_DIR, createFixtures };
