const fs = require("node:fs");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { MODELS } = require("./gemini");
const { noSymlinks, atomicWrite, PROJECT } = require("./workspace");

function fmtSrtTime(sec) {
  const ms = Math.floor((sec % 1) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function fmtVttTime(sec) {
  return fmtSrtTime(sec).replace(",", ".");
}

function probeAudioDuration(filePath) {
  const res = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ], { encoding: "utf8", timeout: 15000 });
  if (res.error || res.status !== 0) {
    throw new Error(`ffprobe failed to measure audio duration for ${filePath}: ${res.stderr || res.error?.message}`);
  }
  const dur = parseFloat(res.stdout.trim());
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`Invalid audio duration measured for ${filePath}: ${res.stdout}`);
  }
  return dur;
}

function alignWords(text, startTime, endTime) {
  const rawWords = text.trim().split(/\s+/).filter(Boolean);
  if (!rawWords.length) return [];
  const charWeights = rawWords.map(w => Math.max(1, w.replace(/[^\w]/g, "").length));
  const totalChars = charWeights.reduce((a, b) => a + b, 0);
  const dur = endTime - startTime;
  
  let cur = startTime;
  const words = [];
  for (let i = 0; i < rawWords.length; i++) {
    const wDur = (charWeights[i] / totalChars) * dur;
    const wStart = Number(cur.toFixed(3));
    const wEnd = Number((cur + wDur).toFixed(3));
    words.push({
      word: rawWords[i],
      start: wStart,
      end: wEnd,
      rel_start: Number((wStart - startTime).toFixed(3)),
      rel_end: Number((wEnd - startTime).toFixed(3))
    });
    cur += wDur;
  }
  return words;
}

function buildSubtitles(segments, maxWords = 8, maxChars = 46) {
  const cues = [];
  for (const seg of segments) {
    const words = seg.words || [];
    if (!words.length) continue;
    
    let chunk = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      chunk.push(w);
      const textLen = chunk.reduce((acc, x) => acc + x.word.length, 0) + chunk.length - 1;
      const rem = words.length - 1 - i;
      const isStrong = /[.:;?!—]$/.test(w.word);
      const isComma = /[,]$/.test(w.word);

      let split = false;
      if (isStrong && chunk.length >= 3 && rem >= 2) split = true;
      else if (isComma && chunk.length >= 4 && rem >= 3) split = true;
      else if ((chunk.length >= maxWords || textLen >= maxChars) && rem >= 3) split = true;

      if (split) {
        cues.push({
          segment_id: seg.id,
          start: chunk[0].start,
          end: Number(Math.min(seg.end, chunk.at(-1).end + 0.12).toFixed(3)),
          words: chunk,
          text: chunk.map(x => x.word).join(" ")
        });
        chunk = [];
      }
    }
    if (chunk.length) {
      cues.push({
        segment_id: seg.id,
        start: chunk[0].start,
        end: Number(Math.min(seg.end, chunk.at(-1).end + 0.12).toFixed(3)),
        words: chunk,
        text: chunk.map(x => x.word).join(" ")
      });
    }
  }

  // Prevent overlap between adjacent cues
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start - 0.04) {
      cues[i].end = Number((cues[i + 1].start - 0.04).toFixed(3));
    }
  }

  let srt = "";
  let vtt = "WEBVTT\n\n";
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    srt += `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n\n`;
    vtt += `${i + 1}\n${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}\n${c.text}\n\n`;
  }

  return { cues, srt, vtt };
}

async function synthesizeSegmentTTS(session, text, { voice = "Puck", style = "clear and informative", model = MODELS.tts } = {}) {
  // Use Gemini 3.8 Flash-Lite TTS for lowest-latency studio voice synthesis
  const interaction = await session.client.interactions.create({
    model,
    input: [{
      type: "user_input",
      content: [{
        type: "text",
        text,
        annotations: [{
          type: "speech_metadata",
          style
        }]
      }]
    }],
    response_format: { type: "audio" },
    generation_config: {
      speech_config: [
        { voice }
      ]
    }
  });

  const base64Data = interaction.output_audio?.data;
  if (!base64Data) {
    throw new Error("TTS model returned no output audio data.");
  }
  return Buffer.from(base64Data, "base64");
}

function synthesizeOfflineToneWav(durationSec, outputPath, sampleRate = 48000) {
  const nSamples = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(44 + nSamples * 2);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + nSamples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // format = 1 (PCM)
  buf.writeUInt16LE(1, 22);  // channels = 1
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);  // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(nSamples * 2, 40);

  // Soft hum with fade in/out
  const freq = 320;
  for (let i = 0; i < nSamples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, Math.min(t / 0.05, (durationSec - t) / 0.05));
    const val = Math.sin(2 * Math.PI * freq * t) * 0.15 * env;
    const intSample = Math.max(-32768, Math.min(32767, Math.floor(val * 32767)));
    buf.writeInt16LE(intSample, 44 + i * 2);
  }
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

module.exports = {
  fmtSrtTime,
  fmtVttTime,
  probeAudioDuration,
  alignWords,
  buildSubtitles,
  synthesizeSegmentTTS,
  synthesizeOfflineToneWav
};
