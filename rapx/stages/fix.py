"""Stage 4: fix — Failing bars go back to Argon with exact errors. Max 3 retries, then re-verify."""

from __future__ import annotations

import json
from pathlib import Path
from google import genai

from rapx.clients.argon import call_argon_json, record_stage_metric
from rapx.config import AppConfig, load_prompt
from rapx.schemas import LyricsArtifact, VerifyArtifact
from rapx.stages.lyrics import normalize_lyrics_bars
from rapx.stages.verify import run_verify


def run_fix(
    run_dir: Path,
    cfg: AppConfig,
    client: genai.Client,
    *,
    extra_errors: list[dict[str, object]] | None = None,
) -> tuple[LyricsArtifact, VerifyArtifact]:
    lyrics_path = run_dir / "lyrics.json"
    verify_path = run_dir / "verify.json"
    if not lyrics_path.exists():
        raise FileNotFoundError(f"Missing lyrics.json in {run_dir}")

    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    verify_res = (
        VerifyArtifact.model_validate_json(verify_path.read_text(encoding="utf-8"))
        if verify_path.exists()
        else run_verify(run_dir)
    )

    if verify_res.passed and not extra_errors:
        return lyrics, verify_res

    template = load_prompt("fix")
    max_retries = cfg.pipeline.max_fix_retries

    for attempt in range(1, max_retries + 1):
        failing_bars = [
            {"bar_index": b.bar_index, "text": b.text, "errors": b.errors}
            for b in verify_res.bars
            if b.errors
        ]
        if extra_errors:
            failing_bars.extend(extra_errors)

        if not failing_bars:
            break

        prompt = (
            template.replace("{{concept}}", lyrics.concept)
            .replace("{{lyrics_json}}", lyrics.model_dump_json(indent=2))
            .replace("{{errors_json}}", json.dumps(failing_bars, indent=2))
        )

        fixed_lyrics, metric = call_argon_json(
            client,
            cfg,
            f"fix_attempt_{attempt}",
            prompt,
            LyricsArtifact,
            thinking_level="low",
            model_override=cfg.models.fast_llm or cfg.models.llm,
        )
        fixed_lyrics = normalize_lyrics_bars(fixed_lyrics)

        # Preserve passing bars from previous iteration unless partner in same rhyme_group was modified
        failing_idx_set = {
            b.bar_index for b in verify_res.bars if b.errors
        } | {
            int(item["bar_index"]) for item in (extra_errors or []) if "bar_index" in item
        }
        failing_groups = {
            b.rhyme_group for b in lyrics.bars if b.index in failing_idx_set
        }
        if len(fixed_lyrics.bars) == len(lyrics.bars):
            for idx, old_bar in enumerate(lyrics.bars):
                if old_bar.rhyme_group not in failing_groups and old_bar.index not in failing_idx_set:
                    fixed_lyrics.bars[idx] = old_bar

        lyrics = normalize_lyrics_bars(fixed_lyrics)
        lyrics_path.write_text(lyrics.model_dump_json(indent=2), encoding="utf-8")
        record_stage_metric(run_dir, lyrics.concept, metric)

        verify_res = run_verify(run_dir)
        extra_errors = None
        if verify_res.passed:
            break

    return lyrics, verify_res
