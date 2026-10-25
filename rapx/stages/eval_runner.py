"""Phase 1 pipeline runner and `rapx eval` table generator."""

from __future__ import annotations

from pathlib import Path
import yaml
from rich.console import Console
from rich.table import Table

from rapx.clients.argon import create_genai_client
from rapx.config import ROOT_DIR, AppConfig, load_config
from rapx.schemas import FactCheckArtifact, LyricsArtifact, OutlineArtifact, VerifyArtifact
from rapx.stages.factcheck import run_factcheck
from rapx.stages.fix import run_fix
from rapx.stages.lyrics import run_lyrics
from rapx.stages.outline import run_outline
from rapx.stages.verify import run_verify

console = Console()


def run_phase1_for_concept(
    concept: str,
    run_id: str,
    cfg: AppConfig | None = None,
    *,
    force: bool = False,
) -> tuple[OutlineArtifact, LyricsArtifact, VerifyArtifact, FactCheckArtifact]:
    cfg = cfg or load_config()
    client = create_genai_client(cfg)
    run_dir = ROOT_DIR / cfg.pipeline.runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    outline = run_outline(run_dir, concept, cfg, client, force=force)
    lyrics = run_lyrics(run_dir, cfg, client, force=force)
    verify_res = run_verify(run_dir)
    if not verify_res.passed:
        lyrics, verify_res = run_fix(run_dir, cfg, client)
    factcheck_res = run_factcheck(run_dir, cfg, client, force=force)
    # Re-read final lyrics and verify in case factcheck triggered a fix
    lyrics = LyricsArtifact.model_validate_json((run_dir / "lyrics.json").read_text(encoding="utf-8"))
    verify_res = VerifyArtifact.model_validate_json((run_dir / "verify.json").read_text(encoding="utf-8"))
    return outline, lyrics, verify_res, factcheck_res


def run_eval_suite(limit: int | None = None, force: bool = False) -> list[dict[str, object]]:
    cfg = load_config()
    eval_file = ROOT_DIR / "evals" / "concepts.yaml"
    data = yaml.safe_load(eval_file.read_text(encoding="utf-8"))
    concepts = data.get("concepts", [])
    if limit is not None:
        concepts = concepts[:limit]

    results: list[dict[str, object]] = []
    table = Table(title="rapx Phase 1 Eval Score Table (outline → lyrics → verify → fix → factcheck)")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Concept", style="white")
    table.add_column("Bars", justify="right")
    table.add_column("Syl OK", justify="right")
    table.add_column("Rhyme OK", justify="right")
    table.add_column("Stress OK", justify="right")
    table.add_column("Terms Hit", justify="right")
    table.add_column("FactCheck", justify="center")
    table.add_column("Score", justify="right", style="bold green")

    for entry in concepts:
        cid = entry["id"]
        concept_text = entry["concept"]
        must_terms = [t.lower() for t in entry.get("must_include_terms", [])]
        run_id = f"eval_{cid}"
        console.print(f"[dim]Running Phase 1 for[/dim] [bold]{cid}[/bold]: {concept_text}...")

        _, lyrics, verify_res, factcheck_res = run_phase1_for_concept(
            concept_text, run_id, cfg, force=force
        )

        total_bars = len(verify_res.bars)
        syl_ok_count = sum(1 for b in verify_res.bars if 10 <= b.syllable_count <= 14)
        rhyme_ok_count = sum(1 for b in verify_res.bars if b.end_rhyme_ok)
        stress_ok_count = sum(1 for b in verify_res.bars if b.stress_beats_ok)

        all_lyrics_lower = " ".join(b.text.lower() for b in lyrics.bars)
        terms_hit = sum(1 for t in must_terms if t in all_lyrics_lower)

        row = {
            "id": cid,
            "concept": concept_text,
            "bars": total_bars,
            "syl_ok": f"{syl_ok_count}/{total_bars}",
            "rhyme_ok": f"{rhyme_ok_count}/{total_bars}",
            "stress_ok": f"{stress_ok_count}/{total_bars}",
            "terms_hit": f"{terms_hit}/{len(must_terms)}",
            "factcheck": "PASS" if factcheck_res.accurate else "FIXED",
            "score": verify_res.score,
            "passed": verify_res.passed,
        }
        results.append(row)

        table.add_row(
            cid,
            concept_text,
            str(total_bars),
            f"{syl_ok_count}/{total_bars}",
            f"{rhyme_ok_count}/{total_bars}",
            f"{stress_ok_count}/{total_bars}",
            f"{terms_hit}/{len(must_terms)}",
            "[green]PASS[/green]" if factcheck_res.accurate else "[yellow]FIXED[/yellow]",
            f"{verify_res.score:.1f}",
        )

    console.print(table)
    return results
