"""Stage 10: render — pre-render gate (static scene checks + `hyperframes check`) -> `hyperframes render` -> `final.mp4`.

The gate catches contract violations, runtime errors, unreadable text, occlusion and contrast
problems in seconds, before paying for a render. Scene-owned findings go back to the fast model
for a surgical scene fix; the best scene version seen is kept, so a fix can never make it worse.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from rich.console import Console

from rapx.clients.argon import compute_stage_hash, record_stage_metric
from rapx.config import AppConfig
from rapx.schemas import LyricsArtifact, SceneParts, StageMetric
from rapx.stages.code import assemble_index, load_scene, run_code
from rapx.stages.shell import SHELL_ID_PREFIXES, SHELL_IDS, scene_element_ids, validate_scene_parts

console = Console()

CHECK_SECTIONS = ("lint", "runtime", "layout", "contrast", "craft", "motion")
# Findings that cannot be acted on (structure warnings the shell intentionally triggers).
IGNORED_CODES = {"composition_file_too_large", "nested_structure_needs_subcomposition"}
# Non-error findings worth one fix pass when they come from scene elements.
ADVISORY_CODES = {
    "text_below_floor",
    "contrast_aa_failure",
    "rotation_pivot_drift",
    "gsap_timeline_set_initial_hide",
    "text_occluded",
    "text_box_overflow",
    "canvas_overflow",
}


@dataclass
class PreflightReport:
    contract: list[str] = field(default_factory=list)  # Static scene contract violations: can break the page; abort if unfixed
    fatal: list[str] = field(default_factory=list)  # Lint/runtime errors: the scene may not animate; fixed if possible
    quality: list[str] = field(default_factory=list)  # Layout/readability problems: the video renders but looks worse
    quality_errors: int = 0
    check_ms: int = 0  # Total time spent in checks (excludes fix calls, which record their own metrics)
    check_error: str = ""  # `hyperframes check` itself failed; not the scene's fault, so never sent to the model
    shell_findings: list[str] = field(default_factory=list)  # Not fixable by the scene model; recorded only

    @property
    def blocking(self) -> list[str]:
        return self.contract + self.fatal

    @property
    def clean(self) -> bool:
        return not self.blocking and not self.quality

    def score_key(self) -> tuple[int, int, int, int]:
        return (len(self.contract), len(self.fatal), self.quality_errors, len(self.quality))

    def feedback_text(self) -> str:
        lines: list[str] = []
        if self.blocking:
            lines.append("BLOCKING (must fix):")
            lines.extend(self.blocking)
        if self.quality:
            lines.append("QUALITY (fix these too):")
            lines.extend(self.quality)
        return "\n".join(lines)


def _is_scene_selector(selector: str | None, scene_ids: set[str]) -> bool:
    # `#scene` itself is a shell container (the shell fades/scales it during slams); only its contents are the scene's.
    if not selector:
        return False
    if "#scene-camera" in selector or "#s-" in selector:
        return True
    if not selector.startswith("#") and re.search(r"\bsvg\b", selector):
        return True  # id-less path through an <svg>: the shell renders no SVG, so this is scene content
    return any(f"#{i}" in selector for i in scene_ids)


def _involves_shell_layer(selector: str | None) -> bool:
    """True when a finding's other party is a shell layer (slam word, wipe, background, HUD, captions)."""
    if not selector or not selector.startswith("#"):
        return False
    head = selector[1:].split(" ", 1)[0].split(">", 1)[0].split(":", 1)[0].split(".", 1)[0].strip()
    return head not in ("scene", "scene-camera") and (head in SHELL_IDS or head.startswith(SHELL_ID_PREFIXES))


def _format_finding(section: str, f: dict[str, Any], elements: list[dict[str, Any]] | None = None) -> str:
    sev = str(f.get("severity", "")).upper()
    t = f.get("time")
    when = f" @{float(t):.2f}s" if isinstance(t, (int, float)) else ""
    parts = [f"- [{sev} {f.get('code')}]{when} {f.get('selector') or ''}".rstrip()]
    msg = str(f.get("message", ""))[:260]
    if f.get("code") == "contrast_aa_failure":
        msg += f" (text {f.get('fg')} on {f.get('bg')}, ratio {f.get('ratio')}, text \"{f.get('text', '')}\")"
    if f.get("containerSelector"):
        msg += f" (involves {f['containerSelector']})"
    parts.append(f"  {msg}")
    for el in (elements or [])[:12]:
        parts.append(f"    · {el.get('selector')} \"{el.get('text', '')}\" at {el.get('fontPx')}px")
    if f.get("fixHint"):
        parts.append(f"  hint: {str(f['fixHint'])[:200]}")
    return "\n".join(parts)


def classify_check_findings(check_json: dict[str, Any], scene: SceneParts | None) -> PreflightReport:
    """Split `hyperframes check --json` output into fatal / quality (scene-owned) / shell findings."""
    report = PreflightReport()
    scene_ids = scene_element_ids(scene.markup) if scene else set()
    for section in CHECK_SECTIONS:
        for f in (check_json.get(section) or {}).get("findings", []) or []:
            code = f.get("code")
            severity = f.get("severity")
            if code in IGNORED_CODES:
                continue
            if section in ("lint", "runtime"):
                if severity == "error":
                    report.fatal.append(_format_finding(section, f))
                continue
            elements = None
            if code == "text_below_floor" and f.get("elements"):
                elements = [e for e in f["elements"] if scene is None or _is_scene_selector(e.get("selector"), scene_ids)]
                owned = bool(elements)
            else:
                owned = scene is None or _is_scene_selector(f.get("selector"), scene_ids)
                # Overlap with a shell layer (e.g. a punchline slam) is by design and not fixable in the scene.
                if owned and _involves_shell_layer(f.get("containerSelector")):
                    owned = False
            if severity != "error" and code not in ADVISORY_CODES:
                continue
            line = _format_finding(section, f, elements)
            if owned:
                report.quality.append(line)
                if severity == "error":
                    report.quality_errors += 1
            else:
                report.shell_findings.append(line)
    return report


def run_hyperframes_check(hf_dir: Path) -> tuple[dict[str, Any] | None, str]:
    """Run `npx --yes hyperframes check --json` (lint + runtime + layout + contrast + craft) on `hf_dir`."""
    try:
        res = subprocess.run(
            [
                "npx", "--yes", "hyperframes", "check", str(hf_dir), "--json",
                "--samples", "12", "--at-transitions", "--max-transition-samples", "48",
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return None, "hyperframes check timed out after 300s"
    stdout = res.stdout.strip()
    idx = stdout.find("{")
    if idx != -1:
        try:
            # raw_decode tolerates trailing output (e.g. npm notices) after the JSON document.
            data, _ = json.JSONDecoder().raw_decode(stdout[idx:])
            if isinstance(data, dict):
                return data, ""
        except json.JSONDecodeError:
            pass
    return None, f"hyperframes check produced no JSON (exit {res.returncode}):\nSTDOUT:\n{stdout[-2000:]}\nSTDERR:\n{res.stderr[-2000:]}"


def collect_preflight_findings(hf_dir: Path, scene: SceneParts | None) -> PreflightReport:
    static_problems = validate_scene_parts(scene) if scene else []
    check_json, check_err = run_hyperframes_check(hf_dir)
    if check_json is None:
        report = PreflightReport(check_error=check_err)
    else:
        report = classify_check_findings(check_json, scene)
    report.contract = [f"- [ERROR static_contract] {p}" for p in static_problems]
    return report


def run_preflight(run_dir: Path, cfg: AppConfig, hf_dir: Path, *, label: str = "") -> PreflightReport:
    """Check -> fix the scene (fast model) -> re-check, keeping the best scene version seen."""
    scene = load_scene(run_dir)
    fixes_left = cfg.pipeline.max_preflight_fixes if scene else 0
    quality_fix_used = False
    versions: list[tuple[tuple[int, int, int, int], SceneParts | None, PreflightReport]] = []
    check_ms_total = 0

    for round_num in range(1, cfg.pipeline.max_preflight_fixes + 2):
        t0 = time.perf_counter()
        report = collect_preflight_findings(hf_dir, scene)
        check_ms = round((time.perf_counter() - t0) * 1000)
        check_ms_total += check_ms
        versions.append((report.score_key(), scene, report))
        (run_dir / f"preflight{label}_{round_num}.json").write_text(
            json.dumps({
                "contract": report.contract,
                "fatal": report.fatal,
                "quality": report.quality,
                "check_error": report.check_error,
                "shell_findings": report.shell_findings,
                "check_ms": check_ms,
            }, indent=2),
            encoding="utf-8",
        )
        console.print(
            f"  [dim]preflight {round_num}: {len(report.blocking)} blocking, {len(report.quality)} quality, "
            f"{len(report.shell_findings)} shell-owned[/dim]"
        )
        if report.check_error:
            console.print(f"  [yellow]hyperframes check did not run cleanly; continuing without it: {report.check_error[:300]}[/yellow]")
        if report.clean or fixes_left <= 0:
            break
        if not report.blocking:
            # Quality-only findings get a single fix pass; rendering beats chasing marginal warnings.
            if quality_fix_used:
                break
            quality_fix_used = True
        fixes_left -= 1
        try:
            run_code(
                run_dir,
                cfg,
                force=True,
                error_feedback=report.feedback_text(),
                stage_label=f"code_preflight_fix{label}_{round_num}",
            )
        except Exception as e:  # A failed fix must not lose the scene we already have
            console.print(f"  [yellow]preflight fix failed ({e}); keeping the best scene so far[/yellow]")
            break
        scene = load_scene(run_dir)

    best_key, best_scene, best_report = min(
        enumerate(versions), key=lambda iv: (iv[1][0], -iv[0])
    )[1]
    if best_scene is not None and best_scene is not scene:
        console.print(f"  [yellow]preflight: restoring best scene version {best_key}[/yellow]")
        assemble_index(run_dir, best_scene)
    best_report.check_ms = check_ms_total
    return best_report


def run_hyperframes_render_cmd(hf_dir: Path, output_mp4: Path, fps: int = 30, quality: str = "looks") -> tuple[bool, str]:
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
            quality,
        ],
        capture_output=True,
        text=True,
        timeout=900,
    )
    if res.returncode == 0 and output_mp4.exists() and output_mp4.stat().st_size > 50_000:
        return True, ""

    err_msg = (
        f"hyperframes render failed (exit {res.returncode}):\n"
        f"STDOUT:\n{res.stdout[-2500:]}\n"
        f"STDERR:\n{res.stderr[-2500:]}"
    )
    return False, err_msg


def _render_hash(index_path: Path, cfg: AppConfig) -> str:
    return compute_stage_hash(
        "hyperframes_render_v2",
        index_path.read_text(encoding="utf-8"),
        [str(cfg.video.fps), cfg.video.render_quality],
    )


def mark_render_current(run_dir: Path, index_path: Path, cfg: AppConfig, output_filename: str = "final.mp4") -> None:
    """Record that `output_filename` was rendered from the current `index_path` (render cache key)."""
    (run_dir / f".render_{output_filename}.hash").write_text(_render_hash(index_path, cfg), encoding="utf-8")


def run_render(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
    output_filename: str = "final.mp4",
    label: str = "",
) -> Path:
    lyrics_path = run_dir / "lyrics.json"
    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))

    hf_dir = run_dir / "hf_project"
    index_path = hf_dir / "index.html"
    if not index_path.exists():
        index_path = run_code(run_dir, cfg, force=force)

    out_mp4 = run_dir / output_filename
    hash_path = run_dir / f".render_{output_filename}.hash"

    if (
        not force
        and cfg.pipeline.cache_enabled
        and out_mp4.exists()
        and out_mp4.stat().st_size > 50_000
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == _render_hash(index_path, cfg)
    ):
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(stage="render", model="hyperframes", cached=True, input_hash=hash_path.read_text().strip()),
        )
        return out_mp4

    max_attempts = max(1, cfg.pipeline.max_render_retries)
    last_error = ""

    for attempt in range(1, max_attempts + 1):
        report = run_preflight(run_dir, cfg, hf_dir, label=f"{label}_r{attempt}" if attempt > 1 else label)
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(
                stage=f"preflight{label}" if attempt == 1 else f"preflight{label}_attempt_{attempt}",
                model="hyperframes check",
                latency_ms=report.check_ms,
            ),
        )
        if report.contract:
            # Contract violations can break the shell page itself (e.g. unbalanced markup hiding the captions).
            raise RuntimeError("Scene still violates the shell contract after fixes:\n" + "\n".join(report.contract))
        if report.fatal:
            # Lint/runtime errors (possibly a flaky font/CDN load) only affect the scene; captions still work.
            console.print("  [yellow]rendering despite unresolved check errors:[/yellow]\n" + "\n".join(report.fatal)[:1200])

        t0 = time.perf_counter()
        render_ok, render_err = run_hyperframes_render_cmd(
            hf_dir, out_mp4, fps=cfg.video.fps, quality=cfg.video.render_quality
        )
        elapsed_ms = round((time.perf_counter() - t0) * 1000)

        if render_ok:
            mark_render_current(run_dir, index_path, cfg, output_filename)
            final_hash = hash_path.read_text(encoding="utf-8").strip()
            record_stage_metric(
                run_dir,
                lyrics.concept,
                StageMetric(
                    stage="render" if attempt == 1 else f"render_attempt_{attempt}",
                    model=f"hyperframes ({cfg.video.render_quality})",
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
