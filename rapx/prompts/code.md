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

### 5. Mandatory HyperFrames Contract & Zero-Overlap Layout Rules (CRITICAL)
1. **Required `<head>` & GSAP Script**:
   - Include `<meta charset="UTF-8" />`, `<meta name="viewport" content="width=1080, height=1920" />`
   - Include Google Fonts `<link>` for the fonts in `treatment.json` (plus fallback to `system-ui, sans-serif` / `monospace`)
   - Include `<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>`
2. **Root Container (`#root`) & Audio (`#bgm`)**:
   ```html
   <div id="root" data-composition-id="main" data-start="0" data-duration="{{duration_sec}}" data-width="1080" data-height="1920" data-resolution="portrait">
     <audio id="bgm" class="clip" src="assets/{{audio_filename}}" data-start="0" data-duration="{{duration_sec}}" data-volume="1" data-track-index="0"></audio>
   ```
3. **Clips & Deterministic GSAP Rules (NEVER VIOLATE)**:
   - Every timed container inside `#root` must have `id`, `class="clip"`, `data-start`, `data-duration`, and `data-track-index`.
   - **NEVER animate a `.clip` element directly with GSAP**. Always animate **child elements inside** a `.clip` container!
   - **NEVER use `gsap.from()` or `tl.from()`** — ALWAYS use `tl.fromTo(target, fromVars, toVars, position)` or `tl.set(...)` / `tl.to(...)` with explicit baseline state at `t = 0`.
   - **NEVER set CSS `transform` on an element that you also animate with GSAP `x`/`y`/`scale`/`rotation`**.
   - **NEVER use `requestAnimationFrame`, `setInterval`, `setTimeout`, or unseeded `Math.random()`**.
4. **Concise, Data-Driven Code (< 650 lines total for fast generation)**:
   - Keep the HTML + CSS + JS compact and clean (**under 650 lines total**, omit verbose comments).
   - Generate repeated SVG grids, cells, nodes, ticks, and karaoke DOM pages dynamically using compact JavaScript loops (`for` / `forEach`) rather than repeating hundreds of lines of static HTML/SVG markup.
5. **Strict 3-Zone Non-Overlapping Vertical Layout (`1080×1920`, Safe Zone `x: 108..972`, `y: 192..1728`)**:
   - **Zone 1: Top HUD Header (`top: 192px`, `left: 108px`, `width: 864px`, `height: 170px`)**:
     - Contains concept badge, `BAR XX / 16` counter, current section title, AND the kinetic hit-word callout badge (`#kinetic-hit-badge`).
     - **CRITICAL ANTI-OVERLAP RULE**: Place `#kinetic-hit-badge` / `#punchline-badge` **inside Zone 1 (Top HUD Header)** or in a dedicated top callout slot—**NEVER place giant floating punchline banners over the center of Zone 2's SVG diagram**.
   - **Zone 2: Center Interactive Visual Metaphor Arena (`top: 390px`, `left: 108px`, `width: 864px`, `height: 920px`, `overflow: hidden`)**:
     - Sub-divided vertically into 3 strict non-overlapping bands inside the `864×920` arena:
       - **Top Formula & Status Strip (`y: 20px..80px`)**: Single-line formula box on the left and status pill on the right. Never stack two title banners at the same `y` coordinate!
       - **Main SVG Diagram Canvas (`y: 95px..780px`)**: Keep all SVG shapes, matrices, rings, and node labels strictly within `x: 60..804` and `y: 110..760`. When animating camera pan/zoom on `#camera-rig`, clamp `scale` between `0.94` and `1.05` and `x`/`y` translation within `±20px` so diagram elements NEVER touch the top formula strip (`y < 95`) or bottom telemetry strip (`y > 780`).
       - **Bottom Telemetry Meters Strip (`y: 790px..896px`)**: 3 side-by-side metric bars with short numeric value labels (e.g. `33%`, `88%`, never long strings that overflow into adjacent columns).
     - **SVG Label Isolation Rule**: Every node/cell badge must use a wide pill/rounded-rect (`width >= 100px`) with its title and coordinate/weight text stacked cleanly inside the shape, or hide underlying static text whenever a moving lens/badge passes over it.
     - **Intro Animation (`0.0s` to `BARS_DATA[0].start`)**: Animate the diagram blueprint assembling, scanning, and pulsing on every beat during the instrumental intro so there is **zero dead air** before Bar 1 starts!
   - **Zone 3: Bottom Karaoke Caption Box (`top: 1350px`, `left: 108px`, `width: 864px`, `height: 360px`)**:
     - **CRITICAL CAPTION ISOLATION RULE**:
       - In CSS, every bar's lyric page (`.bar-lyric-page`) MUST default to `display: none; opacity: 0; visibility: hidden;`.
       - At `t = 0`, call `tl.set(".bar-lyric-page", { autoAlpha: 0, display: "none" }, 0);` and during `BARS_DATA[0]` intro (`0` to `BARS_DATA[0].start`), show an intro title card inside the caption box that hides at `BARS_DATA[0].start - 0.02`.
       - At each `bar.start`, strictly hide the previous bar (`display: "none", autoAlpha: 0`) before showing the current bar (`display: "flex", autoAlpha: 1`) so two bars NEVER stack or overlap!
       - Use `font-size: 44px`, `line-height: 1.24`, `gap: 10px 14px`, and `padding-bottom: 24px` so 3-line lyrics fit with generous room above the bottom progress bar.
6. **Master Timeline Registration**:
   - End the `<script>` with:
   ```javascript
   window.__timelines = window.__timelines || {};
   window.__timelines["main"] = tl;
   tl.seek(0);
   ```

Output ONLY the raw HTML document starting with `<!doctype html>` and ending with `</html>`.
