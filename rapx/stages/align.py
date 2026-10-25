"""Stage 7: align — Hybrid WhisperX ASR + CTC Forced Alignment + Worst-Bar Gate + librosa beats.

1. Transcribes each take with WhisperX (`faster-whisper`) to measure true acoustic lyric drift against known lyrics.
2. Runs WhisperX (`wav2vec2`) CTC forced alignment against the known lyrics for exact word timestamps `{w, start, end, confidence}`.
3. Evaluates per-bar confidence (Worst-Bar Gate: penalizes any take that rushes or drops a bar).
4. Smart Intro/Outro Trimming: if a 16-bar take exceeds 60s due to long instrumental intro/outro, trims the silent/instrumental padding around the vocals so all 16 bars stay intact within 30-60s.
5. Extracts `bpm`, `beats[]`, and vocal-anchored `downbeats[]` with `librosa` -> `timeline.json`.
"""

from __future__ import annotations

from difflib import SequenceMatcher
import json
import logging
import re
import subprocess
import time
import warnings
from pathlib import Path
from typing import Any

# Suppress noisy pyannote torchcodec multi-line warning before importing whisperx
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote\.audio\.core\.io")
warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")

import librosa
import lightning.pytorch
import numpy as np
import pytorch_lightning
import whisperx

# Eagerly silence whisperx and lightning loggers (whisperx lazy-imports lightning, which resets its logger to INFO)
whisperx.setup_logging(level="error")
for _log_name in ("lightning.pytorch", "pytorch_lightning", "whisperx"):
    logging.getLogger(_log_name).setLevel(logging.ERROR)

from rapx.clients.argon import compute_stage_hash, record_stage_metric
from rapx.config import AppConfig
from rapx.schemas import LyricsArtifact, OutlineArtifact, StageMetric, TimelineArtifact, WordTimestamp


def _clean_word(w: str) -> str:
    return re.sub(r"[^a-z0-9']", "", w.lower()).strip("'")


def parse_lyria_segment_hints(
    lyrics_text: str | None,
    bars: list[str],
    bpm: float,
    audio_duration: float,
) -> tuple[list[dict[str, Any]], float]:
    """Build full-track segment [{"text": full_lyrics, "start": 0.0, "end": audio_duration}] for CTC forced alignment."""
    full_text = " ".join(bar.strip() for bar in bars if bar.strip())
    segments: list[dict[str, Any]] = [
        {"text": full_text, "start": 0.0, "end": round(audio_duration, 3)}
    ]
    return segments, round(audio_duration, 3)


def transcribe_take_words(asr_model: Any, audio: np.ndarray) -> list[str]:
    """Run WhisperX ASR transcription to get the actual sung words for true lyric drift calculation."""
    try:
        res = asr_model.transcribe(audio, batch_size=8, language="en")
        segs = res.get("segments", [])
        text = " ".join(str(s.get("text", "")) for s in segs)
        return [_clean_word(w) for w in text.split() if _clean_word(w)]
    except Exception:
        return []


def compute_per_bar_stats(
    known_bars: list[str],
    aligned_words: list[WordTimestamp],
) -> tuple[list[dict[str, Any]], float, int]:
    """Compute per-bar mean confidence, duration, and count of bars failing the Worst-Bar Gate (< 0.35)."""
    bar_stats: list[dict[str, Any]] = []
    idx = 0
    for b_idx, bar_text in enumerate(known_bars, start=1):
        b_tokens = [w for w in bar_text.split() if w.strip()]
        n_tok = len(b_tokens)
        slice_w = aligned_words[idx : idx + n_tok]
        idx += n_tok
        if slice_w:
            s_t = slice_w[0].start
            e_t = slice_w[-1].end
            dur = round(e_t - s_t, 3)
            mean_c = round(float(np.mean([w.confidence or 0.0 for w in slice_w])), 4)
        else:
            s_t, e_t, dur, mean_c = 0.0, 0.0, 0.0, 0.0
        bar_stats.append(
            {
                "bar_index": b_idx,
                "start": s_t,
                "end": e_t,
                "duration": dur,
                "mean_confidence": mean_c,
            }
        )

    min_bar_conf = min((b["mean_confidence"] for b in bar_stats), default=0.0)
    dropped_bars = sum(1 for b in bar_stats if b["mean_confidence"] < 0.35 or b["duration"] < 1.35)
    return bar_stats, round(float(min_bar_conf), 4), dropped_bars


def compute_lyric_drift(
    known_bars: list[str],
    lyria_lyrics_text: str | None,
    aligned_words: list[WordTimestamp],
    asr_tokens: list[str] | None = None,
) -> float:
    """Compute hybrid lyric drift combining ASR word-error drift, CTC low-confidence rate, and compressed-word rate."""
    expected_tokens = [_clean_word(w) for bar in known_bars for w in bar.split() if _clean_word(w)]
    if not expected_tokens:
        return 0.0

    # 1. CTC alignment quality (words with confidence >= 0.30 and duration >= 50ms)
    good_words = sum(
        1
        for w in aligned_words
        if (w.confidence or 0.0) >= 0.30 and (w.end - w.start) >= 0.05
    )
    ctc_drift = max(0.0, 1.0 - min(1.0, good_words / max(1, len(expected_tokens))))

    # 2. ASR transcription similarity (true acoustic word drift)
    if asr_tokens:
        asr_sim = SequenceMatcher(None, expected_tokens, asr_tokens).ratio()
        asr_drift = 1.0 - asr_sim
        return round(0.5 * ctc_drift + 0.5 * asr_drift, 4)

    # 3. Fallback to Lyria returned vocal transcript if ASR not run
    if lyria_lyrics_text:
        sung_lines: list[str] = []
        for raw_line in lyria_lyrics_text.splitlines():
            m = re.match(r"^\[(?:\d+(?:\.\d+)?)?:(?:\d+(?:\.\d+)?)?\]\s*(.*)$", raw_line.strip())
            if m and len(sung_lines) < len(known_bars):
                cleaned_line = re.split(r"Caption:\s*", m.group(1))[0].strip()
                sung_lines.append(cleaned_line)
        if sung_lines:
            sung_tokens = [_clean_word(w) for ln in sung_lines for w in ln.split() if _clean_word(w)]
            sim = SequenceMatcher(None, expected_tokens, sung_tokens).ratio()
            return round(0.5 * ctc_drift + 0.5 * (1.0 - sim), 4)

    return round(ctc_drift, 4)


def extract_beats_and_downbeats(
    audio_path: Path,
    target_bpm: float,
    max_duration: float,
    first_word_start: float | None = None,
) -> tuple[float, list[float], list[float]]:
    y, sr = librosa.load(str(audio_path), sr=22050, duration=max_duration)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, start_bpm=target_bpm)
    detected_bpm = float(np.atleast_1d(tempo)[0])
    if detected_bpm <= 0:
        detected_bpm = float(target_bpm)

    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    beats = [round(float(t), 3) for t in beat_times if float(t) <= max_duration]

    if not beats:
        step = 60.0 / target_bpm
        beats = [round(i * step, 3) for i in range(int(max_duration / step))]

    best_phase = 0
    if first_word_start is not None and len(beats) >= 4:
        nearest_idx = int(np.argmin([abs(b - first_word_start) for b in beats]))
        best_phase = nearest_idx % 4
    else:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        valid_frames = [f for f in beat_frames if f < len(onset_env)]
        if len(valid_frames) >= 4:
            phase_scores = [
                float(np.mean([onset_env[valid_frames[idx]] for idx in range(p, len(valid_frames), 4)]))
                for p in range(4)
            ]
            best_phase = int(np.argmax(phase_scores))

    downbeats = [beats[i] for i in range(best_phase, len(beats), 4)]
    return round(detected_bpm, 2), beats, downbeats


def smart_trim_audio_around_vocals(
    src_path: Path,
    dst_path: Path,
    first_word_start: float,
    last_word_end: float,
    raw_duration: float,
    min_dur: float,
    max_dur: float,
) -> tuple[float, float]:
    """Trim excess instrumental intro/outro around the vocals so all 16 bars stay intact inside [min_dur, max_dur].

    Returns (trim_start_offset_sec, final_duration_sec).
    """
    # Keep up to 2.5s of drum intro before the first vocal word if we need to trim
    trim_start = 0.0
    if last_word_end + 2.0 > max_dur and first_word_start > 3.0:
        trim_start = round(max(0.0, min(first_word_start - 2.5, last_word_end + 2.5 - max_dur)), 3)

    remaining_after_start = raw_duration - trim_start
    vocal_end_shifted = last_word_end - trim_start
    target_duration = min(
        max_dur,
        min(remaining_after_start, max(min_dur, vocal_end_shifted + 2.5)),
    )
    fade_start = max(0.0, target_duration - 1.5)
    af_filters = [f"afade=t=out:st={fade_start:.3f}:d=1.5"]
    if trim_start > 0:
        af_filters.insert(0, "afade=t=in:st=0:d=0.4")

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{trim_start:.3f}",
            "-i",
            str(src_path),
            "-t",
            f"{target_duration:.3f}",
            "-af",
            ",".join(af_filters),
            "-acodec",
            "libmp3lame",
            "-q:a",
            "2",
            str(dst_path),
        ],
        check=True,
        capture_output=True,
    )
    return trim_start, round(target_duration, 3)


def run_align(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
) -> TimelineArtifact:
    lyrics_path = run_dir / "lyrics.json"
    manifest_path = run_dir / "audio_takes.json"
    if not lyrics_path.exists() or not manifest_path.exists():
        raise FileNotFoundError(f"Missing lyrics.json or audio_takes.json in {run_dir}")

    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    takes_meta: list[dict[str, Any]] = json.loads(manifest_path.read_text(encoding="utf-8"))

    outline_path = run_dir / "outline.json"
    key_terms: set[str] = set()
    for bar in lyrics.bars:
        for kt in bar.key_terms_used:
            for part in kt.lower().split():
                if _clean_word(part):
                    key_terms.add(_clean_word(part))
    if outline_path.exists():
        outline = OutlineArtifact.model_validate_json(outline_path.read_text(encoding="utf-8"))
        for kp in outline.key_points:
            for kt in kp.key_terms:
                for part in kt.lower().split():
                    if _clean_word(part):
                        key_terms.add(_clean_word(part))

    out_path = run_dir / "timeline.json"
    hash_path = run_dir / ".align.hash"
    stage_hash = compute_stage_hash(
        "whisperx_hybrid_v2",
        lyrics.model_dump_json(),
        [json.dumps(takes_meta, sort_keys=True)],
    )

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        artifact = TimelineArtifact.model_validate_json(out_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(stage="align", model="whisperx+librosa", cached=True, input_hash=stage_hash),
        )
        return artifact

    t0 = time.perf_counter()
    device = "cpu"
    align_model, align_metadata = whisperx.load_align_model(language_code="en", device=device)

    # Load WhisperX ASR model for true acoustic lyric drift (uses fast local/cached CTranslate2 model)
    asr_model = None
    try:
        asr_model = whisperx.load_model("base.en", device=device, compute_type="int8")
    except Exception:
        asr_model = None

    bars_list = [b.text for b in lyrics.bars]
    take_evaluations: list[dict[str, Any]] = []
    best_eval: dict[str, Any] | None = None

    for take in takes_meta:
        take_file = run_dir / str(take.get("take_name") or Path(str(take["output_path"])).name)
        if not take_file.exists():
            continue

        audio = whisperx.load_audio(str(take_file))
        raw_duration = round(len(audio) / 16000.0, 3)

        asr_tokens = transcribe_take_words(asr_model, audio) if asr_model is not None else None

        segments, verse_end = parse_lyria_segment_hints(
            take.get("lyrics_text"),
            bars_list,
            float(lyrics.bpm or cfg.audio.bpm),
            raw_duration,
        )

        aligned = whisperx.align(
            segments,
            align_model,
            align_metadata,
            audio,
            device,
            return_char_alignments=False,
        )

        raw_words = aligned.get("word_segments", [])
        words: list[WordTimestamp] = []
        cursor = 0.0
        for w_item in raw_words:
            w_text = str(w_item.get("word", "")).strip()
            if not w_text:
                continue
            s_val = w_item.get("start")
            e_val = w_item.get("end")
            conf_val = w_item.get("score")
            start_t = round(float(s_val), 3) if s_val is not None else round(cursor, 3)
            end_t = round(float(e_val), 3) if e_val is not None else round(start_t + 0.22, 3)
            if end_t <= start_t:
                end_t = round(start_t + 0.15, 3)
            cursor = end_t
            conf = round(float(conf_val), 4) if conf_val is not None else 0.5
            words.append(WordTimestamp(w=w_text, start=start_t, end=end_t, confidence=conf))

        kt_scores = [w.confidence or 0.0 for w in words if _clean_word(w.w) in key_terms]
        all_scores = [w.confidence or 0.0 for w in words]
        kt_conf = round(
            float(np.mean(kt_scores)) if kt_scores else (float(np.mean(all_scores)) if all_scores else 0.0),
            4,
        )

        bar_stats, min_bar_conf, dropped_bars = compute_per_bar_stats(bars_list, words)
        drift = compute_lyric_drift(bars_list, take.get("lyrics_text"), words, asr_tokens=asr_tokens)

        vocal_span_sec = round((words[-1].end - words[0].start), 3) if words else raw_duration
        max_vocal_span = float(cfg.video.duration_max_sec) - 3.0
        span_penalty = round(max(0.0, vocal_span_sec - max_vocal_span) * 0.015, 4)

        # Worst-Bar Gate: penalize dropped/rushed bars and takes whose vocal span overflows the 60s video budget
        worst_bar_penalty = round(dropped_bars * 0.08 + max(0.0, 0.40 - min_bar_conf) * 0.5 + span_penalty, 4)
        rank_score = round(kt_conf - drift - worst_bar_penalty, 4)

        eval_entry = {
            "take_name": take_file.name,
            "take_path": str(take_file),
            "raw_duration_sec": raw_duration,
            "vocal_span_sec": vocal_span_sec,
            "verse_end_sec": round(verse_end, 3),
            "key_term_confidence": kt_conf,
            "lyric_drift_score": drift,
            "min_bar_confidence": min_bar_conf,
            "dropped_or_rushed_bars": dropped_bars,
            "rank_score": rank_score,
            "bar_stats": bar_stats,
            "words": words,
        }
        take_evaluations.append(eval_entry)
        if best_eval is None or rank_score > best_eval["rank_score"]:
            best_eval = eval_entry

    if best_eval is None:
        raise RuntimeError(f"No valid audio takes could be aligned in {run_dir}")

    selected_src = Path(best_eval["take_path"])
    raw_dur = float(best_eval["raw_duration_sec"])
    first_word_start = best_eval["words"][0].start if best_eval["words"] else 2.0
    last_word_end = best_eval["words"][-1].end if best_eval["words"] else raw_dur

    selected_audio_name = best_eval["take_name"]
    trim_offset = 0.0
    final_duration = raw_dur

    if raw_dur > cfg.video.duration_max_sec or (raw_dur - last_word_end) > 4.0:
        trimmed_path = run_dir / "selected_take.mp3"
        trim_offset, final_duration = smart_trim_audio_around_vocals(
            selected_src,
            trimmed_path,
            first_word_start=first_word_start,
            last_word_end=last_word_end,
            raw_duration=raw_dur,
            min_dur=float(cfg.video.duration_min_sec),
            max_dur=float(cfg.video.duration_max_sec),
        )
        selected_audio_name = trimmed_path.name

    # Shift word timestamps if intro was trimmed
    final_words: list[WordTimestamp] = []
    for w in best_eval["words"]:
        new_s = round(max(0.0, w.start - trim_offset), 3)
        new_e = round(max(new_s + 0.05, w.end - trim_offset), 3)
        if new_s < final_duration:
            final_words.append(
                WordTimestamp(w=w.w, start=new_s, end=min(round(final_duration, 3), new_e), confidence=w.confidence)
            )

    first_w_start = final_words[0].start if final_words else None
    detected_bpm, beats, downbeats = extract_beats_and_downbeats(
        run_dir / selected_audio_name,
        float(lyrics.bpm or cfg.audio.bpm),
        final_duration,
        first_word_start=first_w_start,
    )

    timeline = TimelineArtifact(
        selected_take=selected_audio_name,
        bpm=detected_bpm,
        duration_sec=round(final_duration, 3),
        key_term_confidence=best_eval["key_term_confidence"],
        lyric_drift_score=best_eval["lyric_drift_score"],
        words=final_words,
        beats=beats,
        downbeats=downbeats,
    )

    out_path.write_text(timeline.model_dump_json(indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")

    candidates_summary = [
        {k: v for k, v in ev.items() if k not in ("words", "bar_stats")}
        | {"word_count": len(ev["words"]), "bars": ev["bar_stats"]}
        for ev in take_evaluations
    ]
    (run_dir / "align_candidates.json").write_text(
        json.dumps({"selected": best_eval["take_name"], "candidates": candidates_summary}, indent=2),
        encoding="utf-8",
    )

    elapsed_ms = round((time.perf_counter() - t0) * 1000)
    record_stage_metric(
        run_dir,
        lyrics.concept,
        StageMetric(
            stage="align",
            model="whisperx+librosa",
            cached=False,
            latency_ms=elapsed_ms,
            estimated_cost_usd=0.0,
            input_hash=stage_hash,
        ),
    )
    return timeline
