"""Stage 5: factcheck — Separate Argon call reviews technical accuracy and flags bars to rewrite."""

from __future__ import annotations

from pathlib import Path
from google import genai

from rapx.clients.argon import call_argon_json, compute_stage_hash, record_stage_metric
from rapx.config import AppConfig, load_prompt
from rapx.schemas import FactCheckArtifact, LyricsArtifact, OutlineArtifact, StageMetric
from rapx.stages.fix import run_fix


def run_factcheck(
    run_dir: Path,
    cfg: AppConfig,
    client: genai.Client,
    *,
    force: bool = False,
) -> FactCheckArtifact:
    outline_path = run_dir / "outline.json"
    lyrics_path = run_dir / "lyrics.json"
    if not outline_path.exists() or not lyrics_path.exists():
        raise FileNotFoundError(f"Missing outline.json or lyrics.json in {run_dir}")

    outline = OutlineArtifact.model_validate_json(outline_path.read_text(encoding="utf-8"))
    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))

    out_path = run_dir / "factcheck.json"
    hash_path = run_dir / ".factcheck.hash"

    template = load_prompt("factcheck")
    prompt = (
        template.replace("{{concept}}", outline.concept)
        .replace("{{outline_json}}", outline.model_dump_json(indent=2))
        .replace("{{lyrics_json}}", lyrics.model_dump_json(indent=2))
    )
    stage_hash = compute_stage_hash(cfg.models.llm, prompt)

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        artifact = FactCheckArtifact.model_validate_json(out_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            outline.concept,
            StageMetric(stage="factcheck", model=cfg.models.llm, cached=True, input_hash=stage_hash),
        )
        return artifact

    artifact, metric = call_argon_json(
        client,
        cfg,
        "factcheck",
        prompt,
        FactCheckArtifact,
        thinking_level="low",
        input_hash=stage_hash,
    )
    out_path.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")
    record_stage_metric(run_dir, outline.concept, metric)

    # If factcheck flagged bars, rewrite them via fix + verify
    if not artifact.accurate and artifact.flagged_bars:
        fact_errors = [
            {
                "bar_index": fb.bar_index,
                "errors": [f"FACTCHECK ISSUE: {fb.issue}. Fix: {fb.suggested_fix_direction}"],
            }
            for fb in artifact.flagged_bars
        ]
        run_fix(run_dir, cfg, client, extra_errors=fact_errors)

    return artifact
