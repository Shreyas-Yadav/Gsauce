"""Gemini 4 Argon client wrapper with Vertex AI (ADC), structured JSON output, caching, and metrics."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import TypeVar

import google.auth
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

from rapx.config import AppConfig
from rapx.schemas import RunMetricsArtifact, StageMetric

T = TypeVar("T", bound=BaseModel)


def resolve_project_id(cfg: AppConfig) -> str | None:
    if cfg.gcp.project_id:
        return cfg.gcp.project_id
    env_proj = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT")
    if env_proj:
        return env_proj
    try:
        _, adc_proj = google.auth.default()
        if adc_proj:
            return adc_proj
    except Exception:
        pass
    try:
        res = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


def create_genai_client(cfg: AppConfig, location_override: str | None = None) -> genai.Client:
    if cfg.gcp.vertexai:
        project_id = resolve_project_id(cfg)
        location = location_override or cfg.gcp.location
        return genai.Client(vertexai=True, project=project_id, location=location)
    return genai.Client()


def compute_stage_hash(model_id: str, prompt_text: str, extra_inputs: list[str] | None = None) -> str:
    h = hashlib.sha256()
    h.update(model_id.encode("utf-8"))
    h.update(b"\x00")
    h.update(prompt_text.encode("utf-8"))
    for item in extra_inputs or []:
        h.update(b"\x00")
        h.update(item.encode("utf-8"))
    return h.hexdigest()[:16]


def record_stage_metric(run_dir: Path, concept: str, metric: StageMetric) -> None:
    metrics_path = run_dir / "metrics.json"
    if metrics_path.exists():
        try:
            run_metrics = RunMetricsArtifact.model_validate_json(metrics_path.read_text(encoding="utf-8"))
        except Exception:
            run_metrics = RunMetricsArtifact(run_id=run_dir.name, concept=concept)
    else:
        run_metrics = RunMetricsArtifact(run_id=run_dir.name, concept=concept)

    run_metrics.stages.append(metric)
    run_metrics.total_latency_ms = sum(s.latency_ms for s in run_metrics.stages)
    run_metrics.total_estimated_cost_usd = round(
        sum(s.estimated_cost_usd for s in run_metrics.stages), 6
    )
    metrics_path.write_text(run_metrics.model_dump_json(indent=2), encoding="utf-8")


def _extract_json_str(raw_text: str) -> str:
    text = raw_text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", text, flags=re.DOTALL)
    if fence:
        return fence.group(1).strip()
    return text


def _estimate_llm_cost(cfg: AppConfig, model_id: str, in_tok: int, out_tok: int) -> float:
    if "flash" in model_id.lower():
        return (in_tok / 1_000_000) * cfg.pricing.flash_input_per_1m + (
            out_tok / 1_000_000
        ) * cfg.pricing.flash_output_per_1m
    return (in_tok / 1_000_000) * cfg.pricing.argon_input_per_1m + (
        out_tok / 1_000_000
    ) * cfg.pricing.argon_output_per_1m


RETRYABLE_STATUS = {429, 500, 502, 503, 504}
RETRY_DELAYS_SEC = (8.0, 20.0, 45.0)


def _generate_with_retry(client: genai.Client, **kwargs: object) -> types.GenerateContentResponse:
    """`generate_content` with backoff on quota (429) and transient server errors, so one rate-limit blip
    late in the pipeline doesn't throw away minutes of finished work."""
    for attempt, delay in enumerate((*RETRY_DELAYS_SEC, None), start=1):
        try:
            return client.models.generate_content(**kwargs)  # type: ignore[arg-type]
        except genai_errors.APIError as e:
            if delay is None or getattr(e, "code", None) not in RETRYABLE_STATUS:
                raise
            print(f"[rapx] {kwargs.get('model')} returned {e.code}; retry {attempt}/{len(RETRY_DELAYS_SEC)} in {delay:.0f}s")
            time.sleep(delay)
    raise RuntimeError("unreachable")


def call_argon_json(
    client: genai.Client,
    cfg: AppConfig,
    stage_name: str,
    prompt_text: str,
    schema_cls: type[T],
    *,
    thinking_level: str = "low",
    multimodal_parts: list[types.Part] | None = None,
    input_hash: str | None = None,
    model_override: str | None = None,
) -> tuple[T, StageMetric]:
    """Call Gemini (`model_override` or `cfg.models.llm`) and return a validated Pydantic model + StageMetric."""
    active_model = model_override or cfg.models.llm
    contents: list[object] = []
    if multimodal_parts:
        contents.extend(multimodal_parts)
    contents.append(prompt_text)

    t0 = time.perf_counter()
    response = _generate_with_retry(
        client,
        model=active_model,
        contents=contents,
        config=types.GenerateContentConfig(
            max_output_tokens=32768,
            thinking_config=types.ThinkingConfig(thinking_level=thinking_level),
            response_mime_type="application/json",
            response_schema=schema_cls,
        ),
    )
    elapsed_ms = round((time.perf_counter() - t0) * 1000)

    usage = getattr(response, "usage_metadata", None)
    in_tok = getattr(usage, "prompt_token_count", 0) or 0
    out_tok = (getattr(usage, "candidates_token_count", 0) or 0) + (
        getattr(usage, "thoughts_token_count", 0) or 0
    )
    cost = _estimate_llm_cost(cfg, active_model, in_tok, out_tok)

    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, schema_cls):
        artifact = parsed
    else:
        raw = response.text or ""
        json_str = _extract_json_str(raw)
        artifact = schema_cls.model_validate_json(json_str)

    metric = StageMetric(
        stage=stage_name,
        model=active_model,
        cached=False,
        latency_ms=elapsed_ms,
        input_tokens=in_tok,
        output_tokens=out_tok,
        estimated_cost_usd=round(cost, 6),
        input_hash=input_hash,
    )
    return artifact, metric


def _extract_html_str(raw_text: str) -> str:
    text = raw_text.strip()
    fence = re.search(r"```(?:html)?\s*(<!doctype html>.*</html>)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        return fence.group(1).strip()
    idx = text.lower().find("<!doctype html>")
    end_idx = text.lower().rfind("</html>")
    if idx != -1 and end_idx != -1:
        return text[idx : end_idx + 7].strip()
    return text


def call_argon_text(
    client: genai.Client,
    cfg: AppConfig,
    stage_name: str,
    prompt_text: str,
    *,
    thinking_level: str = "low",
    multimodal_parts: list[types.Part] | None = None,
    input_hash: str | None = None,
    model_override: str | None = None,
    extract_html: bool = True,
) -> tuple[str, StageMetric]:
    """Call Gemini (`model_override` or `cfg.models.llm`) for raw text/HTML output and return (text, StageMetric)."""
    active_model = model_override or cfg.models.llm
    contents: list[object] = []
    if multimodal_parts:
        contents.extend(multimodal_parts)
    contents.append(prompt_text)

    t0 = time.perf_counter()
    response = _generate_with_retry(
        client,
        model=active_model,
        contents=contents,
        config=types.GenerateContentConfig(
            max_output_tokens=32768,
            thinking_config=types.ThinkingConfig(thinking_level=thinking_level),
        ),
    )
    elapsed_ms = round((time.perf_counter() - t0) * 1000)

    usage = getattr(response, "usage_metadata", None)
    in_tok = getattr(usage, "prompt_token_count", 0) or 0
    out_tok = (getattr(usage, "candidates_token_count", 0) or 0) + (
        getattr(usage, "thoughts_token_count", 0) or 0
    )
    cost = _estimate_llm_cost(cfg, active_model, in_tok, out_tok)

    raw = response.text or ""
    metric = StageMetric(
        stage=stage_name,
        model=active_model,
        cached=False,
        latency_ms=elapsed_ms,
        input_tokens=in_tok,
        output_tokens=out_tok,
        estimated_cost_usd=round(cost, 6),
        input_hash=input_hash,
    )
    return (_extract_html_str(raw) if extract_html else raw), metric
