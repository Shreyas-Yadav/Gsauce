"""Configuration loader for rapx."""

from __future__ import annotations

from pathlib import Path
import yaml
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = ROOT_DIR / "config.yaml"
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


class GCPConfig(BaseModel):
    project_id: str | None = None
    location: str = "global"
    vertexai: bool = True


class ModelsConfig(BaseModel):
    llm: str = "gemini-4-argon"
    music: str = "lyria-3.5"


class AudioConfig(BaseModel):
    bpm: int = 92
    time_signature: str = "4/4"
    takes: int = 3
    genre: str = "boom-bap hip-hop"
    mood: str = "confident, rhythmic, educational, crisp drums, warm bassline"


class VideoConfig(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: int = 30
    duration_min_sec: int = 30
    duration_max_sec: int = 60


class PipelineConfig(BaseModel):
    max_fix_retries: int = 3
    max_render_retries: int = 3
    max_critique_rounds: int = 3
    runs_dir: str = "runs"
    cache_enabled: bool = True


class PricingConfig(BaseModel):
    argon_input_per_1m: float = 2.00
    argon_output_per_1m: float = 10.00
    lyria_per_take: float = 0.08


class AppConfig(BaseModel):
    gcp: GCPConfig = Field(default_factory=GCPConfig)
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    audio: AudioConfig = Field(default_factory=AudioConfig)
    video: VideoConfig = Field(default_factory=VideoConfig)
    pipeline: PipelineConfig = Field(default_factory=PipelineConfig)
    pricing: PricingConfig = Field(default_factory=PricingConfig)


def load_config(path: Path | None = None) -> AppConfig:
    cfg_path = path or DEFAULT_CONFIG_PATH
    if not cfg_path.exists():
        return AppConfig()
    data = yaml.safe_load(cfg_path.read_text()) or {}
    return AppConfig.model_validate(data)


def load_prompt(name: str) -> str:
    prompt_path = PROMPTS_DIR / f"{name}.md"
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt file not found: {prompt_path}")
    return prompt_path.read_text(encoding="utf-8")
