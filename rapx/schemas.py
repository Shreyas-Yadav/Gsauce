"""Pydantic schemas for every JSON artifact in `runs/<run_id>/`."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


# 1. outline.json
class KeyPoint(BaseModel):
    order: int = Field(ge=1, le=5)
    title: str
    core_idea: str
    key_terms: list[str] = Field(min_length=1)
    analogy_or_visual_hook: str


class OutlineArtifact(BaseModel):
    concept: str
    summary: str
    key_points: list[KeyPoint] = Field(min_length=3, max_length=5)


# 2. lyrics.json
class Bar(BaseModel):
    index: int = Field(ge=1)
    text: str
    point_order: int = Field(ge=1, le=5)
    end_word: str
    rhyme_group: str = Field(description="e.g. 'A', 'B', 'C'")
    key_terms_used: list[str] = Field(default_factory=list)


class LyricsArtifact(BaseModel):
    concept: str
    bpm: int = 92
    time_signature: str = "4/4"
    bars: list[Bar] = Field(min_length=8, max_length=16)


# 3. verify.json
class BarVerification(BaseModel):
    bar_index: int
    text: str
    syllable_count: int
    end_rhyme_ok: bool
    internal_rhyme_count: int
    stress_beats_ok: bool
    errors: list[str] = Field(default_factory=list)


class VerifyArtifact(BaseModel):
    passed: bool
    score: float = Field(ge=0.0, le=100.0)
    bars: list[BarVerification]
    failing_bar_indices: list[int] = Field(default_factory=list)


# 5. factcheck.json
class BarFactIssue(BaseModel):
    bar_index: int
    issue: str
    suggested_fix_direction: str


class FactCheckArtifact(BaseModel):
    accurate: bool
    flagged_bars: list[BarFactIssue] = Field(default_factory=list)
    overall_notes: str = ""


# 7. timeline.json
class WordTimestamp(BaseModel):
    w: str
    start: float
    end: float
    confidence: float | None = None


class TimelineArtifact(BaseModel):
    selected_take: str
    bpm: float
    duration_sec: float
    key_term_confidence: float
    lyric_drift_score: float
    words: list[WordTimestamp]
    beats: list[float]
    downbeats: list[float]


# 8. treatment.json
class ColorPalette(BaseModel):
    background: str
    primary: str
    secondary: str
    accent: str
    text: str


class TypographySpec(BaseModel):
    heading_font: str
    body_font: str
    mono_font: str


class BarDirection(BaseModel):
    bar_index: int
    start_sec: float
    end_sec: float
    action_verb: str = Field(description="One on-screen action stated as a verb")
    visual_hit_word: str
    visual_hit_time_sec: float
    camera_move: str
    transition_to_next: str
    kinetic_typography_punchline: bool = False
    background_motion: str
    secondary_offbeat_element: str
    protagonist_state: str


class TreatmentArtifact(BaseModel):
    central_metaphor: str
    metaphor_evolution: str
    palette: ColorPalette
    typography: TypographySpec
    bars: list[BarDirection]


# 9. scene.json — the LLM-authored part of `index.html` (the shell around it is built in Python)
class SceneParts(BaseModel):
    style: str = ""
    markup: str
    script: str


# 11. critique_<n>.json
GridCell = Literal[
    "A1", "A2", "A3", "A4", "A5", "A6",
    "B1", "B2", "B3", "B4", "B5", "B6",
    "C1", "C2", "C3", "C4", "C5", "C6",
    "D1", "D2", "D3", "D4", "D5", "D6",
    "E1", "E2", "E3", "E4", "E5", "E6",
    "F1", "F2", "F3", "F4", "F5", "F6",
]


class CritiqueIssue(BaseModel):
    category: Literal[
        "sync_drift",
        "unreadable_text",
        "dead_air",
        "overlap",
        "empty_frame",
        "inaccurate_visual",
    ]
    timestamp_start_sec: float
    timestamp_end_sec: float
    grid_positions: list[GridCell] = Field(min_length=1)
    description: str
    concrete_fix: str


class CritiqueArtifact(BaseModel):
    round: int = Field(ge=1)
    passed: bool
    overall_score: float = Field(ge=0.0, le=100.0)
    issues: list[CritiqueIssue] = Field(default_factory=list)


# metrics.json
class StageMetric(BaseModel):
    stage: str
    model: str | None = None
    cached: bool = False
    latency_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: float = 0.0
    input_hash: str | None = None


class RunMetricsArtifact(BaseModel):
    run_id: str
    concept: str
    total_latency_ms: int = 0
    total_estimated_cost_usd: float = 0.0
    stages: list[StageMetric] = Field(default_factory=list)
