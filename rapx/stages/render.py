"""Stage 10: render — `npx --yes hyperframes lint` + `npx --yes hyperframes render` -> `final.mp4` (max 3 auto-fix attempts)."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from rapx.clients.argon import compute_stage_hash, record_stage_metric
from rapx.config import AppConfig
from rapx.schemas import LyricsArtifact, StageMetric
from rapx.stages.code import run_code


def run_hyperframes_lint(hf_dir: Path) -> tuple[bool, str]:
    """Run `npx --yes hyperframes lint --json` on `hf_dir` and return (passed, error_report)."""
    res = subprocess.run(
        ["npx", "--yes", "hyperframes", "lint", "--json", str(hf_dir)],
        capture_output=True,
        text=True,
        timeout=90,
    )
    stdout = res.stdout.strip()
    stderr = res.stderr.strip()

    try:
        idx = stdout.find("{")
        if idx != -1:
            data = json.loads(stdout[idx:])
            findings = data.get("findings", [])
            errors = [f for f in findings if f.get("severity") == "error"]
            if errors:
                return False, json.dumps(errors, indent=2)
            return True, ""
    except Exception:
        pass

    if res.returncode != 0:
        return False, f"hyperframes lint failed (exit {res.returncode}):\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
    return True, ""


def run_hyperframes_render_cmd(hf_dir: Path, output_mp4: Path, fps: int = 30) -> tuple[bool, str]:
    """Run `npx --yes hyperframes render` to produce `output_mp4`."""
    res = subprocess.run(
        [
            "npx",
            "--yes",
            "hyperframes",
            "render",
            str(hf_dir),
            "--output",
            str(output_mp4.resolve()),
            "--fps",
            str(fps),
            "--quality",
            "draft",
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if res.returncode == 0 and output_mp4.exists() and output_mp4.stat().st_size > 50_000:
        return True, ""

    err_msg = (
        f"hyperframes render failed (exit {res.returncode}):\n"
        f"STDOUT:\n{res.stdout[-2500:]}\n"
        f"STDERR:\n{res.stderr[-2500:]}"
    )
    return False, err_msg


def run_render(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
    output_filename: str = "final.mp4",
) -> Path:
    lyrics_path = run_dir / "lyrics.json"
    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))

    hf_dir = run_dir / "hf_project"
    index_path = hf_dir / "index.html"
    if not index_path.exists():
        index_path = run_code(run_dir, cfg, force=force)

    out_mp4 = run_dir / output_filename
    hash_path = run_dir / f".render_{output_filename}.hash"
    stage_hash = compute_stage_hash(
        "hyperframes_render_v1",
        index_path.read_text(encoding="utf-8"),
        [str(cfg.video.fps)],
    )

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_mp4.exists()
        and out_mp4.stat().st_size > 50_000
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(stage="render", model="hyperframes", cached=True, input_hash=stage_hash),
        )
        return out_mp4

    max_attempts = cfg.pipeline.max_render_retries
    last_error = ""

    for attempt in range(1, max_attempts + 1):
        t0 = time.perf_counter()
        lint_ok, lint_err = run_hyperframes_lint(hf_dir)
        if not lint_ok:
            last_error = f"Attempt {attempt} Lint Errors:\n{lint_err}"
            if attempt < max_attempts:
                run_code(
                    run_dir,
                    cfg,
                    force=True,
                    error_feedback=last_error,
                    stage_label=f"code_render_fix_{attempt}",
                )
                continue
            raise RuntimeError(f"HyperFrames lint failed after {max_attempts} attempts:\n{last_error}")

        render_ok, render_err = run_hyperframes_render_cmd(hf_dir, out_mp4, fps=cfg.video.fps)
        elapsed_ms = round((time.perf_counter() - t0) * 1000)

        if render_ok:
            final_hash = compute_stage_hash(
                "hyperframes_render_v1",
                index_path.read_text(encoding="utf-8"),
                [str(cfg.video.fps)],
            )
            hash_path.write_text(final_hash, encoding="utf-8")
            record_stage_metric(
                run_dir,
                lyrics.concept,
                StageMetric(
                    stage="render" if attempt == 1 else f"render_attempt_{attempt}",
                    model="hyperframes",
                    cached=False,
                    latency_ms=elapsed_ms,
                    estimated_cost_usd=0.0,
                    input_hash=final_hash,
                ),
            )
            return out_mp4

        last_error = f"Attempt {attempt} Render Errors:\n{render_err}"
        if attempt < max_attempts:
            run_code(
                run_dir,
                cfg,
                force=True,
                error_feedback=last_error,
                stage_label=f"code_render_fix_{attempt}",
            )

    raise RuntimeError(f"HyperFrames render failed after {max_attempts} attempts:\n{last_error}")
