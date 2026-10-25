"""Stage 6: audio — Lyria 3 Pro with our lyrics and a style prompt (BPM, genre, mood).

Describe the style only, never name real artists. Generate 3 takes (`take_1.mp3`, `take_2.mp3`, `take_3.mp3`).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
from pathlib import Path

from rapx.clients.argon import compute_stage_hash, create_genai_client, record_stage_metric
from rapx.clients.lyria import generate_music_take
from rapx.config import AppConfig, load_prompt
from rapx.schemas import LyricsArtifact, StageMetric


def format_bars_with_sections(bars: list[str]) -> str:
    """Split >8 bars into [Verse 1] and [Verse 2] per Lyria best practices so no bars are rushed."""
    if len(bars) <= 8:
        return "[Verse 1]\n" + "\n".join(bars)
    mid = (len(bars) // 2)
    # Keep couplets together (even split)
    if mid % 2 != 0:
        mid += 1
    v1 = "\n".join(bars[:mid])
    v2 = "\n".join(bars[mid:])
    return f"[Verse 1]\n{v1}\n\n[Verse 2]\n{v2}"


def build_lyria_prompt(lyrics: LyricsArtifact, cfg: AppConfig) -> str:
    template = load_prompt("audio")
    structured_bars = format_bars_with_sections([bar.text for bar in lyrics.bars])
    return (
        template.replace("{{bpm}}", str(lyrics.bpm or cfg.audio.bpm))
        .replace("{{time_signature}}", lyrics.time_signature or cfg.audio.time_signature)
        .replace("{{genre}}", cfg.audio.genre)
        .replace("{{mood}}", cfg.audio.mood)
        .replace("{{structured_bars_text}}", structured_bars)
    )


def run_audio(
    run_dir: Path,
    cfg: AppConfig,
    *,
    force: bool = False,
) -> list[dict[str, object]]:
    lyrics_path = run_dir / "lyrics.json"
    if not lyrics_path.exists():
        raise FileNotFoundError(f"Missing lyrics.json in {run_dir}")
    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))

    manifest_path = run_dir / "audio_takes.json"
    hash_path = run_dir / ".audio.hash"

    prompt = build_lyria_prompt(lyrics, cfg)
    num_takes = cfg.audio.takes
    stage_hash = compute_stage_hash(cfg.models.music, prompt, [str(num_takes)])

    take_paths = [run_dir / f"take_{i}.mp3" for i in range(1, num_takes + 1)]
    if (
        not force
        and cfg.pipeline.cache_enabled
        and manifest_path.exists()
        and hash_path.exists()
        and hash_path.read_text(encoding="utf-8").strip() == stage_hash
        and all(p.exists() for p in take_paths)
    ):
        takes_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        record_stage_metric(
            run_dir,
            lyrics.concept,
            StageMetric(stage="audio", model=cfg.models.music, cached=True, input_hash=stage_hash),
        )
        return takes_data

    def _generate_one(take_idx: int) -> dict[str, object]:
        out_file = run_dir / f"take_{take_idx}.mp3"
        meta_file = out_file.with_suffix(".json")
        if (
            not force
            and out_file.exists()
            and out_file.stat().st_size > 50_000
            and hash_path.exists()
            and hash_path.read_text(encoding="utf-8").strip() == stage_hash
        ):
            if meta_file.exists():
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            else:
                meta = {
                    "model": cfg.models.music,
                    "output_path": str(out_file),
                    "audio_bytes": out_file.stat().st_size,
                    "lyrics_text": None,
                }
            meta["take_index"] = take_idx
            meta["take_name"] = out_file.name
            meta.setdefault("latency_ms", 0)
            return meta

        t0 = time.perf_counter()
        client = create_genai_client(cfg)
        res = generate_music_take(client, cfg, prompt, out_file)
        res["take_index"] = take_idx
        res["take_name"] = out_file.name
        res["latency_ms"] = round((time.perf_counter() - t0) * 1000)
        return res

    t_start = time.perf_counter()
    takes_results: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=num_takes) as pool:
        futures = {pool.submit(_generate_one, i): i for i in range(1, num_takes + 1)}
        for fut in as_completed(futures):
            takes_results.append(fut.result())

    takes_results.sort(key=lambda x: int(x["take_index"]))  # type: ignore[arg-type]
    wall_ms = round((time.perf_counter() - t_start) * 1000)

    manifest_path.write_text(json.dumps(takes_results, indent=2), encoding="utf-8")
    hash_path.write_text(stage_hash, encoding="utf-8")

    record_stage_metric(
        run_dir,
        lyrics.concept,
        StageMetric(
            stage="audio",
            model=cfg.models.music,
            cached=False,
            latency_ms=wall_ms,
            estimated_cost_usd=round(num_takes * cfg.pricing.lyria_per_take, 6),
            input_hash=stage_hash,
        ),
    )
    return takes_results
