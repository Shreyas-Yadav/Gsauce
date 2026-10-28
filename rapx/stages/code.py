"""Stage 9: code — Argon writes only the central scene; Python assembles the HyperFrames `index.html`.

The deterministic shell (`rapx.stages.shell`) owns captions, HUD, punchline slams, background,
timing data, and timeline registration. The LLM returns `SceneParts` (scoped CSS, markup, and a
script that adds tweens to the shared `tl`), saved to `scene.json`. Fix passes (pre-render check
findings or critique issues) rewrite only the scene with the fast model.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import json
import re
import shutil
from pathlib import Path
from typing import Any

from rapx.clients.argon import (
    call_argon_text,
    compute_stage_hash,
    create_genai_client,
    record_stage_metric,
)
from rapx.config import AppConfig, load_prompt
from rapx.schemas import (
    LyricsArtifact,
    OutlineArtifact,
    SceneParts,
    StageMetric,
    TimelineArtifact,
    TreatmentArtifact,
)
from rapx.stages.shell import (
    SCENE_H,
    SCENE_W,
    build_shell_html,
    format_scene_parts,
    parse_scene_parts,
)

HYPERFRAMES_CONFIG = {
    "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
    "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    "paths": {
        "blocks": "compositions",
        "components": "compositions/components",
        "assets": "assets",
    },
    "media": {"autoProxy": True},
}

ENERGY_FPS = 8
SCENE_PARSE_ATTEMPTS = 2


def _clean_word(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.lower())


def find_hit_word_index(words: list[dict[str, Any]], hit_word: str) -> int | None:
    """Index of the director's `visual_hit_word` inside a bar's aligned words (exact, then partial match)."""
    target = _clean_word(hit_word or "")
    if not target:
        return None
    cleaned = [_clean_word(w["w"]) for w in words]
    for j, c in enumerate(cleaned):
        if c == target:
            return j
    # Fallback: inflections such as "transformers" ~ "Transformer" or "attend" ~ "attending".
    # Require a shared prefix covering most of the target so short fillers ("for", "ten") never match.
    best: tuple[int, int] | None = None
    for j, c in enumerate(cleaned):
        if len(c) < 4 or not (c.startswith(target) or target.startswith(c)):
            continue
        shared = min(len(c), len(target))
        if shared >= 0.7 * len(target) and (best is None or shared > best[0]):
            best = (shared, j)
    return best[1] if best else None


def build_bars_compact_data(
    lyrics: LyricsArtifact,
    timeline: TimelineArtifact,
    treatment: TreatmentArtifact,
    point_titles: dict[int, str] | None = None,
) -> list[dict[str, Any]]:
    """Per-bar structure with exact words[{w, start, end}], lyric text, and visual treatment.

    `visual_hit_time_sec` is snapped to the aligned start of `visual_hit_word` so hits stay
    frame-accurate even if the director copied a timestamp wrong or alignment was recomputed.
    """
    treat_by_idx = {b.bar_index: b for b in treatment.bars}
    titles = point_titles or {}
    bars_out: list[dict[str, Any]] = []
    w_idx = 0
    total_words = len(timeline.words)

    for bar in lyrics.bars:
        tokens = [t for t in bar.text.split() if t.strip()]
        n_tok = len(tokens)
        bar_words = timeline.words[w_idx : min(total_words, w_idx + n_tok)]
        w_idx += n_tok

        t_bar = treat_by_idx.get(bar.index)
        start_s = bar_words[0].start if bar_words else (t_bar.start_sec if t_bar else 0.0)
        end_s = bar_words[-1].end if bar_words else (t_bar.end_sec if t_bar else start_s + 2.5)
        words = [{"w": w.w, "start": round(w.start, 3), "end": round(w.end, 3)} for w in bar_words]

        hit_word = t_bar.visual_hit_word if t_bar else ""
        hit_idx = find_hit_word_index(words, hit_word)
        if hit_idx is not None:
            hit_time = words[hit_idx]["start"]
        elif t_bar:
            hit_time = min(max(t_bar.visual_hit_time_sec, start_s), end_s)
        else:
            hit_time = start_s

        bars_out.append(
            {
                "index": bar.index,
                "text": bar.text,
                "point_order": bar.point_order,
                "point_title": titles.get(bar.point_order, ""),
                "key_terms": bar.key_terms_used,
                "start": round(start_s, 3),
                "end": round(end_s, 3),
                "action_verb": t_bar.action_verb if t_bar else "",
                "visual_hit_word": hit_word,
                "visual_hit_time_sec": round(hit_time, 3),
                "hit_word_index": hit_idx,
                "camera_move": t_bar.camera_move if t_bar else "steady",
                "kinetic_punchline": bool(t_bar.kinetic_typography_punchline) if t_bar else False,
                "protagonist_state": t_bar.protagonist_state if t_bar else "",
                "secondary_offbeat_element": t_bar.secondary_offbeat_element if t_bar else "",
                "words": words,
            }
        )
    return bars_out


@lru_cache(maxsize=8)
def _energy_cached(audio_path: str, mtime_ns: int, duration_sec: float, fps: int) -> tuple[float, ...]:
    import librosa
    import numpy as np

    y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=duration_sec)
    hop = max(1, int(sr / fps))
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
    if rms.size == 0:
        return ()
    lo, hi = np.percentile(rms, 10), np.percentile(rms, 97)
    norm = np.clip((rms - lo) / max(1e-6, hi - lo), 0.0, 1.0)
    smooth = np.convolve(norm, np.ones(3) / 3.0, mode="same")
    n = int(duration_sec * fps)
    return tuple(round(float(v), 2) for v in smooth[:n])


def compute_energy_envelope(audio_path: Path, duration_sec: float, fps: int = ENERGY_FPS) -> dict[str, Any]:
    """Normalised loudness envelope (0..1 at `fps` Hz) that drives the shell's background glow."""
    try:
        values = _energy_cached(str(audio_path), audio_path.stat().st_mtime_ns, float(duration_sec), fps)
    except Exception:
        values = ()
    return {"fps": fps, "values": list(values)}


def load_point_titles(run_dir: Path) -> dict[int, str]:
    outline_path = run_dir / "outline.json"
    if not outline_path.exists():
        return {}
    outline = OutlineArtifact.model_validate_json(outline_path.read_text(encoding="utf-8"))
    return {kp.order: kp.title for kp in outline.key_points}


def scaffold_hyperframes_project(run_dir: Path, timeline: TimelineArtifact) -> Path:
    """Create `runs/<run_id>/hf_project/` with `hyperframes.json` and copy the selected audio take into `assets/`."""
    hf_dir = run_dir / "hf_project"
    assets_dir = hf_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    (hf_dir / "hyperframes.json").write_text(
        json.dumps(HYPERFRAMES_CONFIG, indent=2),
        encoding="utf-8",
    )

    src_audio = run_dir / timeline.selected_take
    if not src_audio.exists():
        raise FileNotFoundError(f"Selected audio file not found: {src_audio}")

    dst_audio = assets_dir / src_audio.name
    src_stat = src_audio.stat()
    if not dst_audio.exists() or dst_audio.stat().st_size != src_stat.st_size or dst_audio.stat().st_mtime < src_stat.st_mtime:
        shutil.copy2(src_audio, dst_audio)
    return hf_dir


@dataclass
class CodeContext:
    lyrics: LyricsArtifact
    timeline: TimelineArtifact
    treatment: TreatmentArtifact
    point_titles: dict[int, str]
    bars_compact: list[dict[str, Any]]
    timeline_compact: dict[str, Any]
    energy: dict[str, Any]


def load_code_context(run_dir: Path) -> CodeContext:
    lyrics_path = run_dir / "lyrics.json"
    timeline_path = run_dir / "timeline.json"
    treatment_path = run_dir / "treatment.json"
    for p in (lyrics_path, timeline_path, treatment_path):
        if not p.exists():
            raise FileNotFoundError(f"Missing required artifact {p} in {run_dir}")

    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    timeline = TimelineArtifact.model_validate_json(timeline_path.read_text(encoding="utf-8"))
    treatment = TreatmentArtifact.model_validate_json(treatment_path.read_text(encoding="utf-8"))
    point_titles = load_point_titles(run_dir)
    return CodeContext(
        lyrics=lyrics,
        timeline=timeline,
        treatment=treatment,
        point_titles=point_titles,
        bars_compact=build_bars_compact_data(lyrics, timeline, treatment, point_titles),
        timeline_compact={
            "bpm": timeline.bpm,
            "duration_sec": timeline.duration_sec,
            "beats": timeline.beats,
            "downbeats": timeline.downbeats,
        },
        energy=compute_energy_envelope(run_dir / timeline.selected_take, timeline.duration_sec),
    )


def load_scene(run_dir: Path) -> SceneParts | None:
    scene_path = run_dir / "scene.json"
    if not scene_path.exists():
        return None
    return SceneParts.model_validate_json(scene_path.read_text(encoding="utf-8"))


def assemble_index(run_dir: Path, scene: SceneParts, ctx: CodeContext | None = None) -> Path:
    """Write `scene.json` and the assembled `hf_project/index.html` (plus a root copy)."""
    ctx = ctx or load_code_context(run_dir)
    hf_dir = scaffold_hyperframes_project(run_dir, ctx.timeline)
    html_code = build_shell_html(
        concept=ctx.lyrics.concept,
        treatment=ctx.treatment,
        timeline_compact=ctx.timeline_compact,
        bars_data=ctx.bars_compact,
        point_titles=ctx.point_titles,
        energy=ctx.energy,
        audio_filename=ctx.timeline.selected_take,
        scene=scene,
    )
    (run_dir / "scene.json").write_text(scene.model_dump_json(indent=2), encoding="utf-8")
    index_path = hf_dir / "index.html"
    index_path.write_text(html_code, encoding="utf-8")
    (run_dir / "index.html").write_text(html_code, encoding="utf-8")
    return index_path


def build_bar_brief(ctx: CodeContext) -> str:
    """Compact per-bar brief for the scene prompt (the script reads exact times from `BARS_DATA`)."""
    lines: list[str] = []
    for i, b in enumerate(ctx.bars_compact):
        slam = " | SHELL SLAMS HIT WORD" if b["kinetic_punchline"] else ""
        lines.append(
            f"- B({i + 1}) [{b['start']:.2f}s-{b['end']:.2f}s] section {b['point_order']} "
            f"\"{b['point_title']}\": \"{b['text']}\"\n"
            f"  hit \"{b['visual_hit_word']}\" @ {b['visual_hit_time_sec']:.2f}s{slam}\n"
            f"  action: {b['action_verb']}\n"
            f"  camera: {b['camera_move']} | state: {b['protagonist_state']}"
        )
    return "\n".join(lines)


def _render_scene_prompt(template: str, ctx: CodeContext) -> str:
    treatment_core = {
        "central_metaphor": ctx.treatment.central_metaphor,
        "metaphor_evolution": ctx.treatment.metaphor_evolution,
        "palette": ctx.treatment.palette.model_dump(),
        "typography": ctx.treatment.typography.model_dump(),
    }
    first_start = ctx.bars_compact[0]["start"] if ctx.bars_compact else 0.0
    return (
        template.replace("{{concept}}", ctx.lyrics.concept)
        .replace("{{duration_sec}}", str(ctx.timeline.duration_sec))
        .replace("{{bpm}}", str(ctx.timeline.bpm))
        .replace("{{num_bars}}", str(len(ctx.bars_compact)))
        .replace("{{intro_end}}", f"{first_start:.2f}")
        .replace("{{scene_w}}", str(SCENE_W))
        .replace("{{scene_h}}", str(SCENE_H))
        .replace("{{treatment_core_json}}", json.dumps(treatment_core, indent=2))
        .replace("{{bar_brief}}", build_bar_brief(ctx))
    )


def _call_scene_model(
    cfg: AppConfig,
    run_dir: Path,
    concept: str,
    stage_label: str,
    prompt_text: str,
    model_id: str,
    stage_hash: str,
) -> SceneParts:
    client = create_genai_client(cfg)
    last_err: Exception | None = None
    for attempt in range(1, SCENE_PARSE_ATTEMPTS + 1):
        prompt = prompt_text
        if attempt > 1:
            prompt += (
                "\n\nYOUR PREVIOUS RESPONSE COULD NOT BE PARSED: "
                f"{last_err}. Return exactly the three tagged blocks and nothing else."
            )
        raw, metric = call_argon_text(
            client,
            cfg,
            stage_label if attempt == 1 else f"{stage_label}_retry",
            prompt,
            thinking_level="low",
            input_hash=stage_hash,
            model_override=model_id,
            extract_html=False,
        )
        record_stage_metric(run_dir, concept, metric)
        try:
            return parse_scene_parts(raw)
        except ValueError as e:
            last_err = e
    raise RuntimeError(f"Scene generation failed after {SCENE_PARSE_ATTEMPTS} attempts: {last_err}")


def run_code(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
    error_feedback: str | None = None,
    stage_label: str = "code",
) -> Path:
    ctx = load_code_context(run_dir)
    index_path = run_dir / "hf_project" / "index.html"
    hash_path = run_dir / ".code.hash"

    base_prompt = _render_scene_prompt(load_prompt("code"), ctx)
    base_hash = compute_stage_hash(
        cfg.models.llm,
        base_prompt,
        [ctx.treatment.model_dump_json(), ctx.timeline.model_dump_json()],
    )

    current_scene = load_scene(run_dir)
    if (
        not force
        and not error_feedback
        and cfg.pipeline.cache_enabled
        and current_scene is not None
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == base_hash
    ):
        # Re-assemble so shell improvements apply without paying for a new scene.
        assemble_index(run_dir, current_scene, ctx)
        record_stage_metric(
            run_dir,
            ctx.lyrics.concept,
            StageMetric(stage=stage_label, model=cfg.models.llm, cached=True, input_hash=base_hash),
        )
        return index_path

    if error_feedback and current_scene is not None:
        # Surgical fix: the fast model rewrites only the scene, given the findings and the current scene.
        fix_prompt = (
            load_prompt("scene_fix")
            .replace("{{concept}}", ctx.lyrics.concept)
            .replace("{{scene_w}}", str(SCENE_W))
            .replace("{{scene_h}}", str(SCENE_H))
            .replace("{{bar_brief}}", build_bar_brief(ctx))
            .replace("{{feedback}}", error_feedback.strip())
            .replace("{{current_scene}}", format_scene_parts(current_scene))
        )
        model_id = cfg.models.fast_llm or cfg.models.llm
        fix_hash = compute_stage_hash(model_id, fix_prompt)
        scene = _call_scene_model(cfg, run_dir, ctx.lyrics.concept, stage_label, fix_prompt, model_id, fix_hash)
    else:
        prompt = base_prompt
        if error_feedback:
            prompt += f"\n\n### Fix these problems from the previous attempt\n```\n{error_feedback.strip()}\n```"
        scene = _call_scene_model(
            cfg, run_dir, ctx.lyrics.concept, stage_label, prompt, cfg.models.llm, base_hash
        )

    assemble_index(run_dir, scene, ctx)
    # The base hash always tracks the inputs, so a later non-forced run reuses the (possibly fixed) scene.
    hash_path.write_text(base_hash, encoding="utf-8")
    return index_path
