"""Stage 2: lyrics — Argon writes 8-16 bars at fixed BPM -> lyrics.json."""

from __future__ import annotations

import re
from pathlib import Path
from google import genai

from rapx.clients.argon import call_argon_json, compute_stage_hash, record_stage_metric
from rapx.config import AppConfig, load_prompt
from rapx.schemas import LyricsArtifact, OutlineArtifact, StageMetric


def normalize_lyrics_bars(artifact: LyricsArtifact) -> LyricsArtifact:
    """Ensure bar indices are sequential 1..N and end_word matches the actual final word of text."""
    for i, bar in enumerate(artifact.bars, start=1):
        bar.index = i
        words = re.findall(r"[A-Za-z0-9']+", bar.text)
        if words:
            bar.end_word = words[-1].lower().strip("'")
    return artifact


def run_lyrics(
    run_dir: Path,
    cfg: AppConfig,
    client: genai.Client,
    *,
    force: bool = False,
) -> LyricsArtifact:
    outline_path = run_dir / "outline.json"
    if not outline_path.exists():
        raise FileNotFoundError(f"Missing outline.json in {run_dir}")
    outline = OutlineArtifact.model_validate_json(outline_path.read_text(encoding="utf-8"))

    out_path = run_dir / "lyrics.json"
    hash_path = run_dir / ".lyrics.hash"

    template = load_prompt("lyrics")
    prompt = (
        template.replace("{{concept}}", outline.concept)
        .replace("{{bpm}}", str(cfg.audio.bpm))
        .replace("{{time_signature}}", cfg.audio.time_signature)
        .replace("{{outline_json}}", outline.model_dump_json(indent=2))
    )
    stage_hash = compute_stage_hash(cfg.models.llm, prompt)

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        artifact = LyricsArtifact.model_validate_json(out_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            outline.concept,
            StageMetric(stage="lyrics", model=cfg.models.llm, cached=True, input_hash=stage_hash),
        )
        return artifact

    artifact, metric = call_argon_json(
        client,
        cfg,
        "lyrics",
        prompt,
        LyricsArtifact,
        thinking_level="low",
        input_hash=stage_hash,
    )
    artifact = normalize_lyrics_bars(artifact)
    out_path.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")
    record_stage_metric(run_dir, outline.concept, metric)
    return artifact
