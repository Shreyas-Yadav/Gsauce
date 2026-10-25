"""Stage 11: critique — Send `final.mp4` (video + audio) and `timeline.json` to Argon.

Returns structured issues on a 6x6 grid (`A1`-`F6`) saved to `critique_<n>.json`.
Feeds issues back to Stage 9 (`code`), re-renders (`render`), up to `cfg.pipeline.max_critique_rounds` (3) rounds.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from google.genai import types

from rapx.clients.argon import (
    call_argon_json,
    compute_stage_hash,
    create_genai_client,
    record_stage_metric,
)
from rapx.config import AppConfig, load_prompt
from rapx.schemas import (
    CritiqueArtifact,
    LyricsArtifact,
    StageMetric,
    TimelineArtifact,
    TreatmentArtifact,
)
from rapx.stages.code import run_code
from rapx.stages.direct import build_bar_timing_summary
from rapx.stages.render import run_render


def format_critique_for_coder(critique: CritiqueArtifact, current_html: str) -> str:
    """Format `CritiqueArtifact` issues + current `index.html` so Argon can apply targeted surgical fixes."""
    issue_lines: list[str] = [
        f"Critique Round {critique.round} Score: {critique.overall_score}/100 (Passed: {critique.passed})",
        "You MUST fix every single visual/sync issue listed below on the 6x6 grid (A1-F6):",
    ]
    for i, iss in enumerate(critique.issues, start=1):
        cells = ", ".join(iss.grid_positions)
        issue_lines.append(
            f"{i}. [{iss.category.upper()}] @ {iss.timestamp_start_sec:.2f}s-{iss.timestamp_end_sec:.2f}s "
            f"(Grid: {cells}):\n"
            f"   - Problem: {iss.description}\n"
            f"   - Concrete Fix: {iss.concrete_fix}"
        )

    issue_lines.append(
        "\nBelow is your current `index.html` that produced the video above. "
        "Modify it to fix all the issues above while keeping everything that already works intact:\n"
        f"```html\n{current_html}\n```"
    )
    return "\n".join(issue_lines)


def evaluate_video_critique(
    run_dir: Path,
    cfg: AppConfig,
    round_num: int,
    video_path: Path,
    lyrics: LyricsArtifact,
    timeline: TimelineArtifact,
    treatment: TreatmentArtifact,
    *,
    force: bool = False,
) -> CritiqueArtifact:
    critique_path = run_dir / f"critique_{round_num}.json"
    hash_path = run_dir / f".critique_{round_num}.hash"

    bar_summary = build_bar_timing_summary(lyrics, timeline)
    prompt_template = load_prompt("critique")
    prompt_text = (
        prompt_template.replace("{{concept}}", lyrics.concept)
        .replace("{{round_num}}", str(round_num))
        .replace("{{bar_timing_summary}}", bar_summary)
        + f"\n\n### Treatment Reference\n```json\n{treatment.model_dump_json(indent=2)}\n```"
    )

    model_id = cfg.models.fast_llm or cfg.models.llm
    video_size = video_path.stat().st_size
    stage_hash = compute_stage_hash(
        model_id,
        prompt_text,
        [str(round_num), str(video_size), timeline.model_dump_json()],
    )

    if (
        not force
        and cfg.pipeline.cache_enabled
        and critique_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        artifact = CritiqueArtifact.model_validate_json(critique_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(
                stage=f"critique_{round_num}",
                model=model_id,
                cached=True,
                input_hash=stage_hash,
            ),
        )
        return artifact

    video_bytes = video_path.read_bytes()
    video_part = types.Part.from_bytes(data=video_bytes, mime_type="video/mp4")

    client = create_genai_client(cfg)
    artifact, metric = call_argon_json(
        client,
        cfg,
        f"critique_{round_num}",
        prompt_text,
        CritiqueArtifact,
        thinking_level="low",
        multimodal_parts=[video_part],
        input_hash=stage_hash,
        model_override=model_id,
    )
    artifact.round = round_num

    critique_path.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")
    record_stage_metric(run_dir, lyrics.concept, metric)
    return artifact


def run_critique_loop(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
) -> list[CritiqueArtifact]:
    """Run up to `cfg.pipeline.max_critique_rounds` (3) rounds of multimodal video critique -> code fix -> re-render."""
    lyrics_path = run_dir / "lyrics.json"
    timeline_path = run_dir / "timeline.json"
    treatment_path = run_dir / "treatment.json"
    final_mp4 = run_dir / "final.mp4"

    for p in (lyrics_path, timeline_path, treatment_path, final_mp4):
        if not p.exists():
            raise FileNotFoundError(f"Missing required file {p} for critique loop in {run_dir}")

    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    timeline = TimelineArtifact.model_validate_json(timeline_path.read_text(encoding="utf-8"))
    treatment = TreatmentArtifact.model_validate_json(treatment_path.read_text(encoding="utf-8"))

    max_rounds = cfg.pipeline.max_critique_rounds
    critiques: list[CritiqueArtifact] = []

    loop_hash_path = run_dir / ".critique_loop.hash"
    loop_hash = compute_stage_hash(
        cfg.models.llm,
        "critique_loop_v1",
        [str(final_mp4.stat().st_size), timeline.model_dump_json(), treatment.model_dump_json()],
    )
    if (
        not force
        and cfg.pipeline.cache_enabled
        and loop_hash_path.exists()
        and loop_hash_path.read_text(encoding="utf-8").strip() == loop_hash
    ):
        for r in range(1, max_rounds + 1):
            cp = run_dir / f"critique_{r}.json"
            if cp.exists():
                critiques.append(CritiqueArtifact.model_validate_json(cp.read_text(encoding="utf-8")))
        if critiques:
            record_stage_metric(
                run_dir,
                lyrics.concept,
                StageMetric(
                    stage="critique",
                    model=cfg.models.llm,
                    cached=True,
                    input_hash=loop_hash,
                ),
            )
            return critiques

    for round_num in range(1, max_rounds + 1):
        critique = evaluate_video_critique(
            run_dir,
            cfg,
            round_num,
            final_mp4,
            lyrics,
            timeline,
            treatment,
            force=force,
        )
        critiques.append(critique)

        # Save a snapshot of the render that was evaluated in this round
        round_mp4_snapshot = run_dir / f"render_round_{round_num}.mp4"
        if final_mp4.exists():
            shutil.copy2(final_mp4, round_mp4_snapshot)

        if critique.passed or not critique.issues:
            break

        # Feed structured issues on the 6x6 grid back to Stage 9 (`code`) and re-render Stage 10 (`render`)
        index_path = run_dir / "hf_project" / "index.html"
        current_html = index_path.read_text(encoding="utf-8") if index_path.exists() else ""
        feedback_str = format_critique_for_coder(critique, current_html)

        run_code(
            run_dir,
            cfg,
            force=True,
            error_feedback=feedback_str,
            stage_label=f"code_critique_fix_{round_num}",
        )
        run_render(run_dir, cfg, force=True, output_filename="final.mp4")

    final_loop_hash = compute_stage_hash(
        cfg.models.llm,
        "critique_loop_v1",
        [str(final_mp4.stat().st_size), timeline.model_dump_json(), treatment.model_dump_json()],
    )
    loop_hash_path.write_text(final_loop_hash, encoding="utf-8")
    return critiques
