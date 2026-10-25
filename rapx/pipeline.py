"""Full 11-stage pipeline orchestrator, rerun-from-stage handler, caching, and metrics summary."""

from __future__ import annotations

from pathlib import Path
from rich.console import Console
from rich.table import Table

from rapx.clients.argon import create_genai_client
from rapx.config import ROOT_DIR, AppConfig, load_config
from rapx.schemas import (
    LyricsArtifact,
    OutlineArtifact,
    RunMetricsArtifact,
    VerifyArtifact,
)
from rapx.stages.align import run_align
from rapx.stages.audio import run_audio
from rapx.stages.code import run_code
from rapx.stages.critique import run_critique_loop
from rapx.stages.direct import run_direct
from rapx.stages.factcheck import run_factcheck
from rapx.stages.fix import run_fix
from rapx.stages.lyrics import run_lyrics
from rapx.stages.outline import run_outline
from rapx.stages.render import run_render
from rapx.stages.verify import run_verify

console = Console()

STAGES_ORDER = [
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


def print_run_metrics_table(run_dir: Path) -> None:
    metrics_path = run_dir / "metrics.json"
    if not metrics_path.exists():
        return
    try:
        m = RunMetricsArtifact.model_validate_json(metrics_path.read_text(encoding="utf-8"))
    except Exception:
        return

    table = Table(title=f"rapx Run Metrics Summary — runs/{run_dir.name}/metrics.json")
    table.add_column("#", justify="right", style="dim")
    table.add_column("Stage", style="cyan")
    table.add_column("Model / Tool", style="white")
    table.add_column("Cached", justify="center")
    table.add_column("Latency (ms)", justify="right")
    table.add_column("In Tokens", justify="right")
    table.add_column("Out Tokens", justify="right")
    table.add_column("Est. Cost ($)", justify="right", style="green")

    for idx, s in enumerate(m.stages, start=1):
        table.add_row(
            str(idx),
            s.stage,
            s.model or "-",
            "[green]YES[/green]" if s.cached else "no",
            f"{s.latency_ms:,}",
            f"{s.input_tokens:,}" if s.input_tokens else "-",
            f"{s.output_tokens:,}" if s.output_tokens else "-",
            f"${s.estimated_cost_usd:.4f}",
        )

    table.add_section()
    table.add_row(
        "",
        "[bold]TOTAL[/bold]",
        "",
        "",
        f"[bold]{m.total_latency_ms:,} ms[/bold]",
        "",
        "",
        f"[bold green]${m.total_estimated_cost_usd:.4f}[/bold green]",
    )
    console.print(table)


def run_full_pipeline(
    run_dir: Path,
    concept: str | None = None,
    *,
    from_stage: str = "outline",
    force: bool = False,
    cfg: AppConfig | None = None,
) -> Path:
    """Execute the 11-stage rapx pipeline from `from_stage` through `critique`."""
    cfg = cfg or load_config()
    if from_stage not in STAGES_ORDER:
        raise ValueError(f"Unknown stage '{from_stage}'. Valid stages: {', '.join(STAGES_ORDER)}")

    run_dir.mkdir(parents=True, exist_ok=True)
    start_idx = STAGES_ORDER.index(from_stage)
    client = create_genai_client(cfg)

    # Resolve concept from existing outline.json or lyrics.json if rerunning from a later stage
    if concept is None:
        if (run_dir / "outline.json").exists():
            concept = OutlineArtifact.model_validate_json(
                (run_dir / "outline.json").read_text(encoding="utf-8")
            ).concept
        elif (run_dir / "lyrics.json").exists():
            concept = LyricsArtifact.model_validate_json(
                (run_dir / "lyrics.json").read_text(encoding="utf-8")
            ).concept
        else:
            raise ValueError(f"Cannot infer concept in {run_dir}; run from 'outline' with a concept.")

    def _should_force(stage_idx: int) -> bool:
        # When rerunning `--from <stage>`, force recomputation of `<stage>` and all downstream stages
        return force or (from_stage != "outline" and stage_idx >= start_idx)

    # Stage 1: outline
    if start_idx <= 0:
        console.print("[bold cyan][1/11] Stage: outline[/bold cyan]")
        run_outline(run_dir, concept, cfg, client, force=_should_force(0))

    # Stage 2: lyrics
    if start_idx <= 1:
        console.print("[bold cyan][2/11] Stage: lyrics[/bold cyan]")
        run_lyrics(run_dir, cfg, client, force=_should_force(1))

    # Stage 3 & 4: verify + fix
    if start_idx <= 3:
        console.print("[bold cyan][3/11] Stage: verify[/bold cyan]")
        verify_res = run_verify(run_dir)
        if not verify_res.passed or start_idx == 3:
            console.print("[bold yellow][4/11] Stage: fix (retrying failing bars)[/bold yellow]")
            _, verify_res = run_fix(run_dir, cfg, client)
        else:
            console.print(f"[green][4/11] Stage: fix — skipped (verify passed with {verify_res.score:.1f})[/green]")

    # Stage 5: factcheck
    if start_idx <= 4:
        console.print("[bold cyan][5/11] Stage: factcheck[/bold cyan]")
        run_factcheck(run_dir, cfg, client, force=_should_force(4))

    # Stage 6: audio
    if start_idx <= 5:
        console.print("[bold cyan][6/11] Stage: audio (Lyria 3 Pro — 3 takes)[/bold cyan]")
        run_audio(run_dir, cfg, force=_should_force(5))

    # Stage 7: align
    if start_idx <= 6:
        console.print("[bold cyan][7/11] Stage: align (Hybrid WhisperX ASR + CTC + librosa)[/bold cyan]")
        tl = run_align(run_dir, cfg, force=_should_force(6))
        console.print(
            f"  [dim]Selected:[/dim] {tl.selected_take} ({tl.duration_sec}s, {tl.bpm} BPM, "
            f"kt_conf={tl.key_term_confidence:.3f}, drift={tl.lyric_drift_score:.3f})"
        )

    # Stage 8: direct
    if start_idx <= 7:
        console.print("[bold cyan][8/11] Stage: direct (Multimodal audio + timeline -> treatment.json)[/bold cyan]")
        run_direct(run_dir, cfg, force=_should_force(7))

    # Stage 9: code
    if start_idx <= 8:
        console.print("[bold cyan][9/11] Stage: code (HyperFrames GSAP index.html)[/bold cyan]")
        run_code(run_dir, cfg, force=_should_force(8))

    # Stage 10: render
    if start_idx <= 9:
        console.print("[bold cyan][10/11] Stage: render (npx hyperframes render -> final.mp4)[/bold cyan]")
        run_render(run_dir, cfg, force=_should_force(9))

    # Stage 11: critique
    if start_idx <= 10:
        console.print("[bold cyan][11/11] Stage: critique (6x6 grid multimodal QA loop)[/bold cyan]")
        critiques = run_critique_loop(run_dir, cfg, force=_should_force(10))
        if critiques:
            last_c = critiques[-1]
            console.print(
                f"  [dim]Critique finished at round {last_c.round}:[/dim] "
                f"score={last_c.overall_score:.1f}/100, passed={last_c.passed}"
            )

    final_mp4 = run_dir / "final.mp4"
    console.print(f"\n[bold green]Pipeline complete![/bold green] Final video: [underline]{final_mp4}[/underline]")
    print_run_metrics_table(run_dir)
    return final_mp4
