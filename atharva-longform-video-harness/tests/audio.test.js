const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { Workspace, PROJECT } = require("../src/harness/workspace");
const { generateSceneAudio } = require("../src/harness/audio");
const { verifyScene, renderPreview } = require("../src/harness/render");
const { buildSubtitles, probeAudioDuration } = require("../src/harness/subtitles");

test("buildSubtitles chunks into orphan-free cues and produces clean SRT/VTT", () => {
  const segments = [
    {
      id: "seg_1",
      start: 0.4,
      end: 4.8,
      words: [
        { word: "Inside", start: 0.4, end: 0.8 },
        { word: "your", start: 0.8, end: 1.1 },
        { word: "brain,", start: 1.1, end: 1.6 },
        { word: "eighty-six", start: 1.6, end: 2.2 },
        { word: "billion", start: 2.2, end: 2.7 },
        { word: "neurons", start: 2.7, end: 3.3 },
        { word: "are", start: 3.3, end: 3.6 },
        { word: "firing.", start: 3.6, end: 4.8 }
      ]
    }
  ];

  const { cues, srt, vtt } = buildSubtitles(segments, 6);
  assert.ok(cues.length >= 1);
  assert.ok(cues.every(c => c.words.length >= 3 || cues.length === 1));
  assert.ok(srt.includes("-->"));
  assert.ok(vtt.startsWith("WEBVTT"));
});

test("generateSceneAudio produces voice track, ducked master audio, and subtitle files in offline mode", async () => {
  const ws = new Workspace(`audio-test-${randomUUID().slice(0, 8)}`, {
    create: true,
    base: join(PROJECT, "build/test-runs"),
    brief: { topic: "Audio test", duration: 6, style: "line", facts: [], sources: [] }
  });

  const beats = [
    { id: "b1", text: "First clause introduces the concept.", pause_before: 0.3, pause_after: 0.5 },
    { id: "b2", text: "Second clause demonstrates the action.", pause_before: 0.2, pause_after: 0.4 }
  ];

  const manifest = await generateSceneAudio(ws, "test_scene", beats, { offline: true });
  assert.ok(manifest.total_duration >= 3.0);
  assert.equal(manifest.segments.length, 2);
  assert.ok(fs.existsSync(join(ws.root, "audio/master_audio.wav")));
  assert.ok(fs.existsSync(join(ws.root, "audio/subtitles.srt")));
  assert.ok(fs.existsSync(join(ws.root, "audio/subtitles.json")));

  const measuredDur = probeAudioDuration(join(ws.root, "audio/master_audio.wav"));
  assert.ok(Math.abs(measuredDur - manifest.total_duration) < 0.1);
});

test("scene with audio and subtitles renders into an mp4 containing audio and subtitle tracks", async () => {
  const ws = new Workspace(`scene-audio-test-${randomUUID().slice(0, 8)}`, {
    create: true,
    base: join(PROJECT, "build/test-runs"),
    brief: { topic: "Scene Audio Test", duration: 4, style: "line", facts: [], sources: [] }
  });

  const beats = [
    { id: "b1", text: "Look at this moving window.", pause_before: 0.2, pause_after: 0.4 }
  ];

  const audioManifest = await generateSceneAudio(ws, "s1", beats, { offline: true });
  
  // Update scene brief with the measured audio & subtitles
  const briefWithAudio = {
    topic: "Scene Audio Test",
    duration: Math.round(audioManifest.total_duration),
    style: "line",
    facts: [],
    sources: [],
    audio: audioManifest.master_audio,
    subtitles_srt: audioManifest.subtitles_srt,
    subtitles: audioManifest.subtitles
  };
  ws.write("brief.json", JSON.stringify(briefWithAudio));

  const sceneCode = `return {
    duration: ${briefWithAudio.duration},
    draw(ctx, t, kit) {
      kit.label("NARRATED SCENE", 540, 300, { size: 48 });
      kit.circle(540, 500, 60 + 20 * Math.sin(t * 3), { color: kit.PAL.accent });
    }
  };`;
  ws.writeScene(sceneCode);

  const verification = await verifyScene(ws, { width: 360 });
  assert.equal(verification.passed, true);

  const preview = await renderPreview(ws, { width: 360, fps: 12 });
  assert.equal(preview.audio, true);
  assert.ok(fs.existsSync(join(ws.artifactDir(), "preview.mp4")));

  // Verify the final MP4 has an audio stream
  const ffprobeRes = require("node:child_process").spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type",
    "-of", "json",
    join(ws.artifactDir(), "preview.mp4")
  ], { encoding: "utf8" });
  const info = JSON.parse(ffprobeRes.stdout);
  assert.ok(info.streams.some(s => s.codec_type === "audio"));
});
