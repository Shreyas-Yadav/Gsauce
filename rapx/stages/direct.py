"""Stage 8: direct — Argon receives `lyrics.json`, `timeline.json`, AND the audio file itself -> `treatment.json`."""

from __future__ import annotations

from pathlib import Path

from google.genai import types

from rapx.clients.argon import (
    call_argon_json,
    compute_stage_hash,
    create_genai_client,
    record_stage_metric,
)
from rapx.config import AppConfig, load_prompt
from rapx.schemas import LyricsArtifact, StageMetric, TimelineArtifact, TreatmentArtifact


def build_bar_timing_summary(lyrics: LyricsArtifact, timeline: TimelineArtifact) -> str:
    """Map aligned words from `timeline.json` back to each bar so Argon gets exact bar windows and word timestamps."""
    lines: list[str] = []
    w_idx = 0
    total_words = len(timeline.words)

    for bar in lyrics.bars:
        tokens = [t for t in bar.text.split() if t.strip()]
        n_tok = len(tokens)
        bar_words = timeline.words[w_idx : min(total_words, w_idx + n_tok)]
        w_idx += n_tok

        if bar_words:
            start_s = bar_words[0].start
            end_s = bar_words[-1].end
            words_str = ", ".join(f'"{w.w}"@{w.start:.2f}s' for w in bar_words)
        else:
            start_s = 0.0
            end_s = 0.0
            words_str = "(no aligned words)"

        lines.append(
            f"- Bar {bar.index} [{start_s:.2f}s - {end_s:.2f}s] (Point {bar.point_order}, terms={bar.key_terms_used}): "
            f'"{bar.text}"\n  Words: {words_str}'
        )
    return "\n".join(lines)


def run_direct(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
) -> TreatmentArtifact:
    lyrics_path = run_dir / "lyrics.json"
    timeline_path = run_dir / "timeline.json"
    if not lyrics_path.exists() or not timeline_path.exists():
        raise FileNotFoundError(f"Missing lyrics.json or timeline.json in {run_dir}")

    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    timeline = TimelineArtifact.model_validate_json(timeline_path.read_text(encoding="utf-8"))

    audio_path = run_dir / timeline.selected_take
    if not audio_path.exists():
        raise FileNotFoundError(f"Missing selected audio file {audio_path}")

    out_path = run_dir / "treatment.json"
    hash_path = run_dir / ".direct.hash"

    bar_summary = build_bar_timing_summary(lyrics, timeline)
    prompt_template = load_prompt("direct")
    prompt_text = (
        prompt_template.replace("{{concept}}", lyrics.concept)
        .replace("{{bar_timing_summary}}", bar_summary)
    )

    stage_hash = compute_stage_hash(
        cfg.models.llm,
        prompt_text,
        [lyrics.model_dump_json(), timeline.model_dump_json(), str(audio_path.stat().st_size)],
    )

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        artifact = TreatmentArtifact.model_validate_json(out_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(stage="direct", model=cfg.models.llm, cached=True, input_hash=stage_hash),
        )
        return artifact

    audio_bytes = audio_path.read_bytes()
    audio_part = types.Part.from_bytes(data=audio_bytes, mime_type="audio/mp3")

    client = create_genai_client(cfg)
    artifact, metric = call_argon_json(
        client,
        cfg,
        "direct",
        prompt_text,
        TreatmentArtifact,
        thinking_level="low",
        multimodal_parts=[audio_part],
        input_hash=stage_hash,
    )

    out_path.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")
    record_stage_metric(run_dir, lyrics.concept, metric)
    return artifact
