"""Stage 9: code — Argon writes a HyperFrames composition (`index.html`) keyed to exact word/beat timestamps from `timeline.json`."""

from __future__ import annotations

import json
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
from rapx.schemas import LyricsArtifact, StageMetric, TimelineArtifact, TreatmentArtifact

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


def build_bars_compact_data(
    lyrics: LyricsArtifact,
    timeline: TimelineArtifact,
    treatment: TreatmentArtifact,
) -> list[dict[str, Any]]:
    """Build per-bar combined structure with exact words[{w, start, end}], lyric text, and visual treatment."""
    treat_by_idx = {b.bar_index: b for b in treatment.bars}
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

        bars_out.append(
            {
                "index": bar.index,
                "text": bar.text,
                "point_order": bar.point_order,
                "key_terms": bar.key_terms_used,
                "start": round(start_s, 3),
                "end": round(end_s, 3),
                "action_verb": t_bar.action_verb if t_bar else "",
                "visual_hit_word": t_bar.visual_hit_word if t_bar else "",
                "visual_hit_time_sec": round(t_bar.visual_hit_time_sec, 3) if t_bar else round(start_s, 3),
                "camera_move": t_bar.camera_move if t_bar else "steady",
                "kinetic_punchline": bool(t_bar.kinetic_typography_punchline) if t_bar else False,
                "protagonist_state": t_bar.protagonist_state if t_bar else "",
                "secondary_offbeat_element": t_bar.secondary_offbeat_element if t_bar else "",
                "words": [
                    {"w": w.w, "start": round(w.start, 3), "end": round(w.end, 3)}
                    for w in bar_words
                ],
            }
        )
    return bars_out


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
    shutil.copy2(src_audio, dst_audio)
    return hf_dir


def run_code(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
    error_feedback: str | None = None,
    stage_label: str = "code",
) -> Path:
    lyrics_path = run_dir / "lyrics.json"
    timeline_path = run_dir / "timeline.json"
    treatment_path = run_dir / "treatment.json"
    for p in (lyrics_path, timeline_path, treatment_path):
        if not p.exists():
            raise FileNotFoundError(f"Missing required artifact {p} in {run_dir}")

    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    timeline = TimelineArtifact.model_validate_json(timeline_path.read_text(encoding="utf-8"))
    treatment = TreatmentArtifact.model_validate_json(treatment_path.read_text(encoding="utf-8"))

    hf_dir = scaffold_hyperframes_project(run_dir, timeline)
    index_path = hf_dir / "index.html"
    root_index_copy = run_dir / "index.html"
    hash_path = run_dir / ".code.hash"

    compact_timeline = {
        "bpm": timeline.bpm,
        "duration_sec": timeline.duration_sec,
        "beats": timeline.beats,
        "downbeats": timeline.downbeats,
    }
    bars_compact = build_bars_compact_data(lyrics, timeline, treatment)

    feedback_block = ""
    if error_feedback:
        feedback_block = (
            "### CRITICAL FIX INSTRUCTIONS (Previous Attempt Failed or Needs Revision)\n"
            "Fix EVERY issue listed below while preserving all HyperFrames contract rules:\n"
            f"```\n{error_feedback.strip()}\n```"
        )

    prompt_template = load_prompt("code")
    prompt_text = (
        prompt_template.replace("{{concept}}", lyrics.concept)
        .replace("{{duration_sec}}", str(timeline.duration_sec))
        .replace("{{audio_filename}}", timeline.selected_take)
        .replace("{{bpm}}", str(timeline.bpm))
        .replace("{{treatment_json}}", treatment.model_dump_json(indent=2))
        .replace("{{lyrics_json}}", lyrics.model_dump_json(indent=2))
        .replace("{{timeline_compact_json}}", json.dumps(compact_timeline))
        .replace("{{bars_compact_json}}", json.dumps(bars_compact))
        .replace("{{error_feedback_block}}", feedback_block)
    )

    stage_hash = compute_stage_hash(
        cfg.models.llm,
        prompt_text,
        [treatment.model_dump_json(), timeline.model_dump_json(), error_feedback or ""],
    )

    if (
        not force
        and not error_feedback
        and cfg.pipeline.cache_enabled
        and index_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
    ):
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(stage=stage_label, model=cfg.models.llm, cached=True, input_hash=stage_hash),
        )
        return index_path

    client = create_genai_client(cfg)
    html_code, metric = call_argon_text(
        client,
        cfg,
        stage_label,
        prompt_text,
        thinking_level="low",
        input_hash=stage_hash,
    )

    index_path.write_text(html_code, encoding="utf-8")
    root_index_copy.write_text(html_code, encoding="utf-8")
    if not error_feedback:
        hash_path.write_text(stage_hash, encoding="utf-8")
    else:
        # Update base .code.hash so a subsequent non-forced run_code knows index.html is up to date
        base_prompt = (
            prompt_template.replace("{{concept}}", lyrics.concept)
            .replace("{{duration_sec}}", str(timeline.duration_sec))
            .replace("{{audio_filename}}", timeline.selected_take)
            .replace("{{bpm}}", str(timeline.bpm))
            .replace("{{treatment_json}}", treatment.model_dump_json(indent=2))
            .replace("{{lyrics_json}}", lyrics.model_dump_json(indent=2))
            .replace("{{timeline_compact_json}}", json.dumps(compact_timeline))
            .replace("{{bars_compact_json}}", json.dumps(bars_compact))
            .replace("{{error_feedback_block}}", "")
        )
        base_hash = compute_stage_hash(
            cfg.models.llm,
            base_prompt,
            [treatment.model_dump_json(), timeline.model_dump_json(), ""],
        )
        hash_path.write_text(base_hash, encoding="utf-8")
    record_stage_metric(run_dir, lyrics.concept, metric)
    return index_path
