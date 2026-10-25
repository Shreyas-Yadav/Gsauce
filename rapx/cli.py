"""CLI entrypoint for rapx."""

from __future__ import annotations

import re
import typer
from rich.console import Console

app = typer.Typer(
    name="rapx",
    help="AI rap explainer video generator (1080x1920, 30fps) powered by Gemini 4 Argon & Lyria.",
    no_args_is_help=True,
)
console = Console()

STAGES = [
    "outline",
    "lyrics",
    "verify",
    "fix",
    "factcheck",
    "audio",
    "align",
    "direct",
    "code",
    "render",
    "critique",
]


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:40] or "run"


@app.command()
def spike() -> None:
    """Run Phase 0 access spike (Argon text, Argon audio input, Lyria track, HyperFrames 5s render)."""
    from rapx.stages.spike import run_phase0_spike

    run_phase0_spike()


@app.command()
def make(
    concept: str = typer.Argument(..., help="Technical concept to explain (e.g. 'explain consistent hashing')"),
    run_id: str | None = typer.Option(None, "--run-id", help="Optional custom run ID"),
    force: bool = typer.Option(False, "--force", help="Ignore stage cache and recompute"),
) -> None:
    """Run the rapx pipeline for a concept (currently Phase 1: outline -> lyrics -> verify -> fix -> factcheck)."""
    from rapx.stages.eval_runner import run_phase1_for_concept

    rid = run_id or _slugify(concept)
    console.print(f"[bold cyan]rapx make[/bold cyan]: {concept} -> runs/{rid}/")
    outline, lyrics, verify_res, factcheck_res = run_phase1_for_concept(concept, rid, force=force)
    console.print(
        f"[green]Phase 1 complete[/green] — {len(outline.key_points)} key points, "
        f"{len(lyrics.bars)} bars, verify score={verify_res.score:.1f} (passed={verify_res.passed}), "
        f"factcheck accurate={factcheck_res.accurate}"
    )


@app.command()
def rerun(
    run_id: str = typer.Argument(..., help="Run ID inside runs/<run_id>"),
    from_stage: str = typer.Option(..., "--from", help=f"Stage to rerun from ({', '.join(STAGES)})"),
) -> None:
    """Rerun an existing run starting from a specific stage."""
    console.print(f"[bold cyan]rapx rerun[/bold cyan]: {run_id} --from {from_stage}")
    raise NotImplementedError("Rerun-from-stage is built in Phase 5.")


@app.command(name="eval")
def run_eval(
    limit: int | None = typer.Option(None, "--limit", help="Optional limit on number of concepts to evaluate"),
    force: bool = typer.Option(False, "--force", help="Ignore stage cache"),
) -> None:
    """Run evals/concepts.yaml and print a score table."""
    from rapx.stages.eval_runner import run_eval_suite

    run_eval_suite(limit=limit, force=force)


if __name__ == "__main__":
    app()
