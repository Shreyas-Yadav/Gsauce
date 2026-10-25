# Gsauce (`rapx`) — Setup & Usage Guide

`rapx` turns any technical concept (e.g., `"explain consistent hashing"`, `"explain how convolution works"`) into a 30–60s vertical (`1080×1920`, `30fps`) animated rap explainer video powered by **Gemini 4 Argon**, **Gemini 3.8 Flash**, **Lyria 3 Pro**, **WhisperX + librosa**, and **HyperFrames (GSAP)**.

---

## 1. System Prerequisites

Ensure the following tools are installed on your machine (macOS / Linux):

```bash
# 1. uv (Python package & environment manager)
brew install uv

# 2. FFmpeg (required for audio trimming, WhisperX, and HyperFrames MP4 encoding)
brew install ffmpeg

# 3. Node.js 20+ & npx (required for `npx hyperframes lint` and `npx hyperframes render`)
brew install node

# 4. Google Cloud SDK (required for Vertex AI Application Default Credentials)
brew install --cask google-cloud-sdk
```

---

## 2. Clone & Install Dependencies

```bash
git clone git@github.com:Shreyas-Yadav/Gsauce.git
cd Gsauce

# Create .venv (Python 3.12) and install all locked dependencies from uv.lock
uv sync
```

---

## 3. Google Cloud / Vertex AI Authentication (ADC)

`rapx` connects to Vertex AI using **Application Default Credentials (ADC)**—no API keys are stored in code.

```bash
# 1. Authenticate your local environment with ADC
gcloud auth application-default login

# 2. Set your GCP project (or update `gcp.project_id` in config.yaml)
gcloud config set project clickwork-1d7f2a
```

---

## 4. Configuration (`config.yaml`)

All model IDs, audio settings, and pipeline parameters are configured in [`config.yaml`](./config.yaml):

```yaml
gcp:
  project_id: "clickwork-1d7f2a"
  location: "global"
  vertexai: true

models:
  llm: "gemini-4-argon"        # Core creative stages (lyrics, direct, initial codegen)
  fast_llm: "gemini-3.8-flash" # High-speed stages (outline, fix, factcheck, critique & surgical fixes)
  music: "lyria-3-pro-preview" # Lyria 3 Pro music & vocal generation
```

---

## 5. Verify Your Installation

```bash
# Check CLI commands
uv run rapx --help

# Run unit tests (syllable counting, rhymes, beat-2/4 stresses, Pydantic schemas)
uv run python -m unittest discover -s tests -v

# (Optional) Run Phase 0 access spike to verify Argon, Lyria, and HyperFrames 5s render
uv run rapx spike
```

---

## 6. Running the Application

### Generate a Full Video (`rapx make`)
Runs all **11 stages** (`outline` → `lyrics` → `verify` → `fix` → `factcheck` → `audio` → `align` → `direct` → `code` → `render` → `critique`) and outputs `runs/<run_id>/final.mp4`:

```bash
# Basic usage
uv run rapx make "explain consistent hashing"

# With a custom run ID
uv run rapx make "explain how convolution works" --run-id convolution

# Force recomputing all stages (ignore cache)
uv run rapx make "explain consistent hashing" --run-id hashing --force
```

### Rerun From a Specific Stage (`rapx rerun`)
Reuses cached upstream artifacts and re-runs from `--from <stage>` onward:

```bash
# Re-run only code generation, rendering, and critique (reusing audio & alignment)
uv run rapx rerun convolution --from code

# Re-run from visual direction onward
uv run rapx rerun convolution --from direct

# Re-run from audio generation onward
uv run rapx rerun convolution --from audio
```
**Valid stages**: `outline`, `lyrics`, `verify`, `fix`, `factcheck`, `audio`, `align`, `direct`, `code`, `render`, `critique`

### Run the Concept Evaluation Suite (`rapx eval`)
Evaluates concepts from `evals/concepts.yaml` and prints a verification & fact-check score table:

```bash
uv run rapx eval --limit 3
```

---

## 7. Output Artifacts (`runs/<run_id>/`)

Every run produces inspectable, Pydantic-validated artifacts inside `runs/<run_id>/`:
- `outline.json` — 3–5 ordered key points and visual hooks
- `lyrics.json` — 8–16 rap bars (`92 BPM`, `4/4`, rhyme groups, key terms)
- `verify.json` — Syllable counts (`10–14`/bar), end/internal rhymes, and beat 2 & 4 stresses
- `factcheck.json` — Technical accuracy review
- `take_1.mp3`, `take_2.mp3`, `selected_take.mp3` & `audio_takes.json` — Lyria 3 Pro tracks
- `timeline.json` & `align_candidates.json` — WhisperX word timestamps + `librosa` beats & downbeats
- `treatment.json` — Multimodal visual direction & per-bar choreography
- `hf_project/index.html` — Self-contained HyperFrames HTML5 + SVG + GSAP composition
- `critique_<n>.json` — 6×6 grid (`A1`–`F6`) visual & sync QA reports
- `metrics.json` — Per-stage model, cache status, latency, token usage, and estimated USD cost
- **`final.mp4`** — Final rendered `1080×1920` (`30fps`) vertical MP4 video
