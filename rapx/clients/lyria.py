"""Lyria music generation client wrapper."""

from __future__ import annotations

import base64
from pathlib import Path
from google import genai
from rapx.config import AppConfig


def generate_music_take(
    client: genai.Client,
    cfg: AppConfig,
    style_and_lyrics_prompt: str,
    output_path: Path,
) -> dict[str, object]:
    """Generate a single music take using Lyria on the Interactions API."""
    interaction = client.interactions.create(
        model=cfg.models.music,
        input=style_and_lyrics_prompt,
    )
    audio_obj = getattr(interaction, "output_audio", None)
    if not audio_obj or not getattr(audio_obj, "data", None):
        raise RuntimeError(f"No audio returned from model {cfg.models.music}")

    raw_bytes = base64.b64decode(audio_obj.data)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(raw_bytes)
    return {
        "model": cfg.models.music,
        "output_path": str(output_path),
        "audio_bytes": len(raw_bytes),
        "lyrics_text": getattr(interaction, "output_text", None),
    }
