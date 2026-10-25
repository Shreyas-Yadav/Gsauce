"""Phase 0 Access Spike stage (`rapx spike`)."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types
from rich.console import Console

from rapx.clients.argon import resolve_project_id
from rapx.config import ROOT_DIR, load_config

console = Console()

SPIKE_DIR = ROOT_DIR / "runs" / "phase0_spike"

HANDWRITTEN_LYRICS = """Create a 92 BPM boom-bap hip-hop rap track with crisp drums, warm bassline, and clear rhythmic vocals.

[Verse]
Ring of hashes spinning round the cluster state
Keys and servers mapping to the same coordinate
Drop a single node and watch the neighbors take the load
Only K divided by N keys ever hit the road
Virtual replicas keep the distribution tight
Consistent hashing keeps the cache hits shining bright
"""


def ensure_test_audio(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-ac",
                "2",
                "-ar",
                "44100",
                str(path),
            ],
            check=True,
            capture_output=True,
        )
    return path


def test_argon_text(client: genai.Client, label: str, model_id: str) -> dict[str, Any]:
    res: dict[str, Any] = {"label": label, "model": model_id}
    t0 = time.perf_counter()
    try:
        interaction = client.interactions.create(
            model=model_id,
            input="Reply in one sentence: what is consistent hashing?",
            generation_config={"thinking_level": "low"},
        )
        res["interactions_create"] = {
            "status": "ok",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "interaction_id": getattr(interaction, "id", None),
            "output_text": interaction.output_text,
        }
    except Exception as e:
        res["interactions_create"] = {
            "status": "error",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "error": f"{type(e).__name__}: {e}",
        }

    t0 = time.perf_counter()
    try:
        resp = client.models.generate_content(
            model=model_id,
            contents="Reply in one sentence: what is consistent hashing?",
        )
        res["generate_content"] = {
            "status": "ok",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "output_text": resp.text,
        }
    except Exception as e:
        res["generate_content"] = {
            "status": "error",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "error": f"{type(e).__name__}: {e}",
        }
    return res


def test_argon_audio(client: genai.Client, label: str, model_id: str, audio_path: Path) -> dict[str, Any]:
    audio_bytes = audio_path.read_bytes()
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    res: dict[str, Any] = {
        "label": label,
        "model": model_id,
        "audio_file": audio_path.name,
        "audio_bytes": len(audio_bytes),
    }

    t0 = time.perf_counter()
    try:
        interaction = client.interactions.create(
            model=model_id,
            input=[
                {"type": "text", "text": "Describe this audio file concisely in 1-2 sentences."},
                {"type": "audio", "data": audio_b64, "mime_type": "audio/mp3"},
            ],
            generation_config={"thinking_level": "low"},
        )
        res["interactions_create"] = {
            "status": "ok",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "output_text": interaction.output_text,
        }
    except Exception as e:
        res["interactions_create"] = {
            "status": "error",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "error": f"{type(e).__name__}: {e}",
        }

    t0 = time.perf_counter()
    try:
        resp = client.models.generate_content(
            model=model_id,
            contents=[
                "Describe this audio file concisely in 1-2 sentences.",
                types.Part.from_bytes(data=audio_bytes, mime_type="audio/mp3"),
            ],
        )
        res["generate_content"] = {
            "status": "ok",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "output_text": resp.text,
        }
    except Exception as e:
        res["generate_content"] = {
            "status": "error",
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "error": f"{type(e).__name__}: {e}",
        }
    return res


def test_lyria_candidates(client: genai.Client, label: str) -> list[dict[str, Any]]:
    candidates = ["lyria-3.5", "lyria-3-pro-preview", "lyria-3-pro", "lyria-3-clip-preview"]
    results: list[dict[str, Any]] = []
    for model_id in candidates:
        item: dict[str, Any] = {"label": label, "model": model_id}
        t0 = time.perf_counter()
        try:
            interaction = client.interactions.create(
                model=model_id,
                input=HANDWRITTEN_LYRICS,
            )
            elapsed = round((time.perf_counter() - t0) * 1000)
            audio_obj = getattr(interaction, "output_audio", None)
            text_out = getattr(interaction, "output_text", None)
            saved_path = None
            size = 0
            if audio_obj and getattr(audio_obj, "data", None):
                raw = base64.b64decode(audio_obj.data)
                size = len(raw)
                out_file = SPIKE_DIR / f"lyria_{label}_{model_id}.mp3"
                out_file.write_bytes(raw)
                saved_path = str(out_file)
            item["interactions_create"] = {
                "status": "ok",
                "latency_ms": elapsed,
                "audio_bytes": size,
                "saved_path": saved_path,
                "output_text_preview": text_out[:400] if text_out else None,
            }
        except Exception as e:
            item["interactions_create"] = {
                "status": "error",
                "latency_ms": round((time.perf_counter() - t0) * 1000),
                "error": f"{type(e).__name__}: {e}",
            }
        results.append(item)
    return results


def run_phase0_spike() -> dict[str, Any]:
    SPIKE_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    project_id = resolve_project_id(cfg)
    tone_path = ensure_test_audio(SPIKE_DIR / "test_tone.mp3")
    has_api_key = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))

    report: dict[str, Any] = {
        "sdk_version": genai.__version__,
        "project_id": project_id,
        "has_gemini_api_key": has_api_key,
        "gemini_api": {},
        "vertex_ai": {},
    }

    if has_api_key:
        try:
            api_client = genai.Client()
            report["gemini_api"]["argon_text"] = test_argon_text(api_client, "gemini_api", cfg.models.llm)
            report["gemini_api"]["lyria"] = test_lyria_candidates(api_client, "gemini_api")
            report["gemini_api"]["argon_audio"] = test_argon_audio(
                api_client, "gemini_api", cfg.models.llm, tone_path
            )
        except Exception as e:
            report["gemini_api"]["error"] = f"{type(e).__name__}: {e}"
    else:
        report["gemini_api"]["skipped"] = "GEMINI_API_KEY / GOOGLE_API_KEY not set in env"

    for loc in ["global", "us-central1"]:
        try:
            v_client = genai.Client(vertexai=True, project=project_id, location=loc)
            report["vertex_ai"][loc] = {
                "argon_text": test_argon_text(v_client, f"vertex_{loc}", cfg.models.llm),
                "lyria": test_lyria_candidates(v_client, f"vertex_{loc}"),
                "argon_audio": test_argon_audio(v_client, f"vertex_{loc}", cfg.models.llm, tone_path),
            }
        except Exception as e:
            report["vertex_ai"][loc] = {"error": f"{type(e).__name__}: {e}"}

    out_path = SPIKE_DIR / "phase0_report.json"
    out_path.write_text(json.dumps(report, indent=2))
    console.print_json(data=report)
    return report


if __name__ == "__main__":
    run_phase0_spike()
