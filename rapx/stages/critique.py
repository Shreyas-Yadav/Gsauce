"""Stage 11: critique — Send a 720p proxy of `final.mp4` (video + audio) and `timeline.json` to the critic.

Returns structured issues on a 6x6 grid (`A1`-`F6`) saved to `critique_<n>.json`.
Feeds issues back to Stage 9 (`code`, scene-only fix) and re-renders, up to `cfg.pipeline.max_critique_rounds`
critiques. The best-scoring round is kept as `final.mp4`, so a fix can never leave a worse video behind.
"""

from __future__ import annotations

import shutil
import subprocess
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
    SceneParts,
    StageMetric,
    TimelineArtifact,
    TreatmentArtifact,
)
from rapx.stages.code import assemble_index, run_code
from rapx.stages.direct import build_bar_timing_summary
from rapx.stages.render import mark_render_current, run_render

PROXY_WIDTH = 720


def decide_critique_pass(critique: CritiqueArtifact, threshold: float) -> bool:
    """The model's own `passed` flag is not trusted on its own: the score must clear the threshold too."""
    return bool(critique.passed) and critique.overall_score >= threshold


def make_critique_proxy(video_path: Path, proxy_path: Path) -> Path:
    """Downscale the final render for critique so inline request size stays small at high render quality."""
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path),
                "-vf", f"scale={PROXY_WIDTH}:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-c:a", "aac", "-b:a", "96k", str(proxy_path),
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )
        return proxy_path
    except Exception:
        return video_path


def format_critique_for_coder(critique: CritiqueArtifact) -> str:
    """Format `CritiqueArtifact` issues for a surgical scene fix (the fix prompt carries the current scene)."""
    issue_lines: list[str] = [
        f"Critique Round {critique.round} Score: {critique.overall_score}/100 (Passed: {critique.passed})",
        "Fix every visual/sync issue below that the scene causes (grid A1-F6 on the 1080x1920 frame; "
        "the scene occupies rows B-E, y 330-1330):",
    ]
    for i, iss in enumerate(critique.issues, start=1):
        cells = ", ".join(iss.grid_positions)
        issue_lines.append(
            f"{i}. [{iss.category.upper()}] @ {iss.timestamp_start_sec:.2f}s-{iss.timestamp_end_sec:.2f}s "
            f"(Grid: {cells}):\n"
            f"   - Problem: {iss.description}\n"
            f"   - Concrete Fix: {iss.concrete_fix}"
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
        .replace("{{pass_score}}", f"{cfg.pipeline.critique_pass_score:.1f}")
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

    proxy_path = make_critique_proxy(video_path, run_dir / f"critique_proxy_{round_num}.mp4")
    video_part = types.Part.from_bytes(data=proxy_path.read_bytes(), mime_type="video/mp4")

    client = create_genai_client(cfg)
    artifact, metric = call_argon_json(
        client,
        cfg,
        f"critique_{round_num}",
        prompt_text,
        CritiqueArtifact,
        thinking_level="medium",
        multimodal_parts=[video_part],
        input_hash=stage_hash,
        model_override=model_id,
    )
    artifact.round = round_num
    artifact.passed = decide_critique_pass(artifact, cfg.pipeline.critique_pass_score)

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

    index_path = run_dir / "hf_project" / "index.html"
    scored_rounds: list[tuple[float, int]] = []
    diverged = False  # True when scene/index changed after the last reviewed render
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
        scored_rounds.append((critique.overall_score, round_num))

        # Snapshot the render (and the scene that produced it) evaluated in this round
        shutil.copy2(final_mp4, run_dir / f"render_round_{round_num}.mp4")
        if index_path.exists():
            shutil.copy2(index_path, run_dir / f"index_round_{round_num}.html")
        if (run_dir / "scene.json").exists():
            shutil.copy2(run_dir / "scene.json", run_dir / f"scene_round_{round_num}.json")

        # No blind fix after the last critique: the delivered video is always one that was reviewed.
        if critique.passed or not critique.issues or round_num == max_rounds:
            break

        try:
            run_code(
                run_dir,
                cfg,
                force=True,
                error_feedback=format_critique_for_coder(critique),
                stage_label=f"code_critique_fix_{round_num}",
            )
            run_render(run_dir, cfg, force=True, output_filename="final.mp4", label=f"_critique{round_num}")
        except Exception as e:
            print(f"critique fix round {round_num} failed ({e}); keeping the best reviewed render")
            diverged = True
            break

    _, best_round = max(scored_rounds, key=lambda sr: (sr[0], sr[1]))
    last_round = scored_rounds[-1][1]
    if best_round != last_round or diverged:
        # A later fix scored worse (or failed midway): restore the best reviewed render and its scene.
        shutil.copy2(run_dir / f"render_round_{best_round}.mp4", final_mp4)
        scene_snapshot = run_dir / f"scene_round_{best_round}.json"
        index_snapshot = run_dir / f"index_round_{best_round}.html"
        if scene_snapshot.exists():
            shutil.copy2(scene_snapshot, run_dir / "scene.json")
        if index_snapshot.exists():
            # Restore the exact composition that produced the reviewed render (not a re-assembly).
            shutil.copy2(index_snapshot, index_path)
            shutil.copy2(index_snapshot, run_dir / "index.html")
        elif scene_snapshot.exists():
            assemble_index(run_dir, SceneParts.model_validate_json(scene_snapshot.read_text(encoding="utf-8")))
        mark_render_current(run_dir, index_path, cfg, "final.mp4")

    final_loop_hash = compute_stage_hash(
        cfg.models.llm,
        "critique_loop_v1",
        [str(final_mp4.stat().st_size), timeline.model_dump_json(), treatment.model_dump_json()],
    )
    loop_hash_path.write_text(final_loop_hash, encoding="utf-8")
    return critiques
