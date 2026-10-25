You are an expert creative technologist and GSAP + HyperFrames motion designer building a vertical (`1080×1920`, `30fps`) educational rap music video explaining **{{concept}}**.

Return **ONLY** a complete, valid, self-contained HTML5 document (`<!doctype html> ... </html>`) for `index.html`. Do not wrap it in markdown prose or explanations.

---

### 1. Project & Audio Spec
- **Resolution**: `1080×1920` (`data-width="1080" data-height="1920"`, `data-resolution="portrait"`)
- **Total Duration**: `{{duration_sec}}` seconds (`data-duration="{{duration_sec}}"`)
- **Audio File**: `assets/{{audio_filename}}`
- **BPM**: `{{bpm}}`

### 2. Visual Treatment (`treatment.json`)
```json
{{treatment_json}}
```

### 3. Lyrics (`lyrics.json`)
```json
{{lyrics_json}}
```

### 4. Exact Word, Beat & Downbeat Data (Must be embedded in `<script>` for frame-accurate sync)
Embed the following JavaScript constants inside your `<script>` tag and use them to build both the GSAP animations and the word-synced karaoke captions:
```javascript
const TIMELINE_DATA = {{timeline_compact_json}};
const BARS_DATA = {{bars_compact_json}};
```

{{error_feedback_block}}

---

### 5. Mandatory HyperFrames Contract Rules (CRITICAL — Lint & Render will fail if violated)
1. **Required `<head>` & GSAP Script**:
   - Include `<meta charset="UTF-8" />`, `<meta name="viewport" content="width=1080, height=1920" />`
   - Include Google Fonts `<link>` for the fonts in `treatment.json` (plus fallback to `system-ui, sans-serif` / `monospace`)
   - Include `<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>`
2. **Root Container (`#root`)**:
   ```html
   <div id="root" data-composition-id="main" data-start="0" data-duration="{{duration_sec}}" data-width="1080" data-height="1920">
   ```
3. **Audio Element (`#bgm`)**:
   - Inside `#root`, include the audio clip:
   ```html
   <audio id="bgm" class="clip" src="assets/{{audio_filename}}" data-start="0" data-duration="{{duration_sec}}" data-volume="1" data-track-index="0"></audio>
   ```
4. **Clips & GSAP Target Rule (NEVER VIOLATE)**:
   - Every timed container inside `#root` must have `id`, `class="clip"`, `data-start`, `data-duration`, and `data-track-index`.
   - **NEVER animate a `.clip` element directly with GSAP** (the HyperFrames runtime controls `.clip` visibility and opacity). Always animate **child elements inside** a `.clip` container!
   - **NEVER use `gsap.from()` or `tl.from()`** — ALWAYS use `tl.fromTo(target, fromVars, toVars, position)` or `tl.set(...)` / `tl.to(...)` with explicit initial state so random-access frame seeking during parallel video rendering is 100% deterministic.
   - **NEVER set CSS `transform` on an element that you also animate with GSAP `x`/`y`/`scale`/`rotation`**. Use flexbox/grid or `top`/`left` for layout positioning, and let GSAP own transforms.
   - **NEVER use `requestAnimationFrame`, `setInterval`, `setTimeout`, or `Math.random()` without a deterministic seed** — all motion must be on the paused master GSAP timeline `tl` or driven deterministically.
5. **Title-Safe Zone & Layout (`1080×1920`)**:
   - Keep all critical diagrams, labels, and captions inside the **80% title-safe zone** (`x: 108px..972px`, `y: 192px..1728px`, i.e., `padding: 192px 108px`).
   - Divide the vertical stage into 3 non-overlapping zones inside `#stage-inner`:
     1. **Top HUD Header (`top: 192px`, `height: 170px`)**: Concept badge, current section/point title, bar counter (`BAR 01 / 16`), BPM/hash telemetry, and punchline callout banner (`kinetic_typography_punchline`).
     2. **Center Interactive Visual Metaphor Arena (`top: 390px`, `height: 920px`, `width: 864px`)**:
        - Build a rich, bespoke **SVG + DOM diagram** of the central metaphor (`treatment.central_metaphor`).
        - For Consistent Hashing (or the given concept), draw the actual technical diagram: e.g., an SVG modulo coordinate ring (`0` to `2^32 - 1`), labeled server nodes (`NODE A`, `NODE B`, `NODE C`, `NODE D`),virtual node replicas (`A1`, `A2`, `B1`, `B2`...), orbiting data keys (`K1`, `K2`, `K3`...) with directional arcs/arrows showing where keys map, node failure/removal animations (`X` / red pulse + neighbor re-routing arc), and real-time load-balance meter bars.
        - Animate the diagram state transitions at every bar's `start_sec` and trigger a high-impact visual pulse/transformation at each bar's `visual_hit_time_sec` from `BARS_DATA`!
        - Pulse secondary rings/particles on every beat in `TIMELINE_DATA.beats` and downbeat in `TIMELINE_DATA.downbeats`.
     3. **Bottom Karaoke Caption Box (`top: 1350px`, `height: 360px`, `width: 864px`)**:
        - High-contrast dark card (`rgba(10, 15, 28, 0.92)` with glowing border) displaying the current bar's full lyric line with **large readable typography (`font-size: 52px`, `line-height: 1.28`, `font-weight: 800`)**.
        - Highlight the currently spoken word in real time using the exact word `start`/`end` timestamps from `BARS_DATA` (active word scaled/colored in `palette.accent`, already-spoken words in `palette.text`, upcoming words in soft muted white, and key technical terms badged/underlined).
6. **Master Timeline Registration**:
   - End the `<script>` with:
   ```javascript
   window.__timelines = window.__timelines || {};
   window.__timelines["main"] = tl;
   tl.seek(0);
   ```

Output ONLY the raw HTML document starting with `<!doctype html>` and ending with `</html>`.
