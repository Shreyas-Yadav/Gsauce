"""Lyria music generation client wrapper with automatic retry on transient/stochastic blocks."""

from __future__ import annotations

import base64
import time
from pathlib import Path
from google import genai
from rapx.config import AppConfig


def generate_music_take(
    client: genai.Client,
    cfg: AppConfig,
    style_and_lyrics_prompt: str,
    output_path: Path,
    *,
    max_attempts: int = 3,
) -> dict[str, object]:
    """Generate a single music take using Lyria on the Interactions API with retry on stochastic block."""
    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            prompt_variant = style_and_lyrics_prompt
            if attempt > 1:
                prompt_variant = (
                    style_and_lyrics_prompt
                    + f"\n\n(Take variation {attempt}: clean educational studio mix.)"
                )
            interaction = client.interactions.create(
                model=cfg.models.music,
                input=prompt_variant,
            )
            audio_obj = getattr(interaction, "output_audio", None)
            if not audio_obj or not getattr(audio_obj, "data", None):
                raise RuntimeError(f"No audio returned from model {cfg.models.music}")

            raw_bytes = base64.b64decode(audio_obj.data)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(raw_bytes)
            lyrics_text = getattr(interaction, "output_text", None)
            meta = {
                "model": cfg.models.music,
                "output_path": str(output_path),
                "audio_bytes": len(raw_bytes),
                "lyrics_text": lyrics_text,
                "attempts": attempt,
            }
            meta_path = output_path.with_suffix(".json")
            import json

            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
            return meta
        except Exception as e:
            last_err = e
            if attempt < max_attempts:
                time.sleep(2.0 * attempt)
    raise RuntimeError(f"Lyria take generation failed after {max_attempts} attempts: {last_err}") from last_err
