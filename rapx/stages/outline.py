"""Stage 1: outline — Argon picks 3-5 key points and order to explain them -> outline.json."""

from __future__ import annotations

from pathlib import Path
from google import genai

from rapx.clients.argon import call_argon_json, compute_stage_hash, record_stage_metric
from rapx.config import AppConfig, load_prompt
from rapx.schemas import OutlineArtifact, StageMetric


def run_outline(
    run_dir: Path,
    concept: str,
    cfg: AppConfig,
    client: genai.Client,
    *,
    force: bool = False,
) -> OutlineArtifact:
    run_dir.mkdir(parents=True, exist_ok=True)
    out_path = run_dir / "outline.json"
    hash_path = run_dir / ".outline.hash"

    template = load_prompt("outline")
    prompt = template.replace("{{concept}}", concept)
    stage_hash = compute_stage_hash(cfg.models.llm, prompt)

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        artifact = OutlineArtifact.model_validate_json(out_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            concept,
            StageMetric(stage="outline", model=cfg.models.llm, cached=True, input_hash=stage_hash),
        )
        return artifact

    artifact, metric = call_argon_json(
        client,
        cfg,
        "outline",
        prompt,
        OutlineArtifact,
        thinking_level="low",
        input_hash=stage_hash,
    )
    out_path.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")
    record_stage_metric(run_dir, concept, metric)
    return artifact
