"""CLI entrypoint for rapx."""

from __future__ import annotations

import re
import time
import typer
from rich.console import Console

from rapx.config import ROOT_DIR, load_config
from rapx.pipeline import STAGES_ORDER, format_elapsed, run_full_pipeline

app = typer.Typer(
    name="rapx",
    help="AI rap explainer video generator (1080x1920, 30fps) powered by Gemini 4 Argon & Lyria.",
    no_args_is_help=True,
)
console = Console()


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:40] or "run"


@app.command()
def spike() -> None:
    """Run Phase 0 access spike (Argon text, Argon audio input, Lyria track, HyperFrames 5s render)."""
    from rapx.stages.spike import run_phase0_spike

    t0 = time.perf_counter()
    console.print("[bold cyan]rapx spike[/bold cyan]: starting Phase 0 access spike...")
    try:
        run_phase0_spike()
    finally:
        elapsed = time.perf_counter() - t0
        console.print(f"[bold magenta]⏱ Total command time (rapx spike): {format_elapsed(elapsed)}[/bold magenta]")


@app.command()
def make(
    concept: str = typer.Argument(..., help="Technical concept to explain (e.g. 'explain consistent hashing')"),
    run_id: str | None = typer.Option(None, "--run-id", help="Optional custom run ID"),
    force: bool = typer.Option(False, "--force", help="Ignore stage cache and recompute all stages"),
) -> None:
    """Run the full 11-stage rapx pipeline for a concept -> runs/<run_id>/final.mp4."""
    t0 = time.perf_counter()
    cfg = load_config()
    rid = run_id or _slugify(concept)
    run_dir = ROOT_DIR / cfg.pipeline.runs_dir / rid
    console.print(f"[bold cyan]rapx make[/bold cyan]: {concept} -> runs/{rid}/")
    try:
        run_full_pipeline(run_dir, concept=concept, from_stage="outline", force=force, cfg=cfg)
    finally:
        elapsed = time.perf_counter() - t0
        console.print(f"[bold magenta]⏱ Total command time (rapx make): {format_elapsed(elapsed)}[/bold magenta]")


@app.command()
def rerun(
    run_id: str = typer.Argument(..., help="Run ID inside runs/<run_id>"),
    from_stage: str = typer.Option(
        ...,
        "--from",
        help=f"Stage to rerun from ({', '.join(STAGES_ORDER)})",
    ),
) -> None:
    """Rerun an existing run starting from a specific stage (reusing earlier cached artifacts)."""
    t0 = time.perf_counter()
    cfg = load_config()
    run_dir = ROOT_DIR / cfg.pipeline.runs_dir / run_id
    if not run_dir.exists():
        raise typer.BadParameter(f"Run directory does not exist: {run_dir}")
    if from_stage not in STAGES_ORDER:
        raise typer.BadParameter(
            f"Invalid stage '{from_stage}'. Must be one of: {', '.join(STAGES_ORDER)}"
        )

    console.print(f"[bold cyan]rapx rerun[/bold cyan]: {run_id} --from {from_stage}")
    try:
        run_full_pipeline(run_dir, concept=None, from_stage=from_stage, force=False, cfg=cfg)
    finally:
        elapsed = time.perf_counter() - t0
        console.print(
            f"[bold magenta]⏱ Total command time (rapx rerun --from {from_stage}): {format_elapsed(elapsed)}[/bold magenta]"
        )


@app.command(name="eval")
def run_eval(
    limit: int | None = typer.Option(None, "--limit", help="Optional limit on number of concepts to evaluate"),
    force: bool = typer.Option(False, "--force", help="Ignore stage cache"),
) -> None:
    """Run evals/concepts.yaml and print a score table."""
    from rapx.stages.eval_runner import run_eval_suite

    t0 = time.perf_counter()
    try:
        run_eval_suite(limit=limit, force=force)
    finally:
        elapsed = time.perf_counter() - t0
        console.print(f"[bold magenta]⏱ Total command time (rapx eval): {format_elapsed(elapsed)}[/bold magenta]")


if __name__ == "__main__":
    app()
