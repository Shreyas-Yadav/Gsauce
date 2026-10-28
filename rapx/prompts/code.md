You are an elite motion designer writing the **central animated scene** of a vertical (`1080×1920`, `30fps`) educational rap music video explaining **{{concept}}** ({{duration_sec}}s, {{bpm}} BPM, {{num_bars}} bars).

A deterministic shell (already built, do NOT recreate it) renders: the top HUD (concept, section title, bar counter, beat dot), word-synced karaoke captions, full-screen punchline word slams, section wipes, the beat/energy-reactive background, the progress bar, and the HyperFrames/GSAP contract. **You write only the scene that lives in the middle of the frame.**

## Your canvas
- The scene box is `{{scene_w}}×{{scene_h}}` px (it sits between the HUD and the captions). Your markup goes inside `#scene-camera`, which fills that box. `overflow` is hidden.
- Use one root `<svg id="s-svg" viewBox="0 0 {{scene_w}} {{scene_h}}" width="{{scene_w}}" height="{{scene_h}}">` (1 SVG unit = 1 px). HTML overlays are allowed but rarely needed.
- Keep all resting content inside `x: 70..1010`, `y: 50..950`.

## Globals the shell provides (read-only)
- `tl` — the master paused GSAP timeline. Add every tween to it with an **absolute position** (3rd argument, seconds).
- `BARS_DATA[i]` (0-based) and `B(n)` (1-based bar lookup): `{index, text, point_order, point_title, start, end, visual_hit_word, visual_hit_time_sec, kinetic_punchline, action_verb, camera_move, protagonist_state, words:[{w,start,end}]}`.
- `TIMELINE_DATA`: `{bpm, duration_sec, beats:[...], downbeats:[...]}`; `beatsBetween(a, b)` returns the beat times in `[a, b)`.
- `PALETTE`: `{background, primary, secondary, accent, text}`; `FONTS`: `{heading, body, mono}` (CSS font stacks).
- **Always derive times from `B(n).start`, `B(n).end`, `B(n).visual_hit_time_sec`, and beat arrays. Never hard-code timestamps.**

## Visual direction
```json
{{treatment_core_json}}
```

### Per-bar brief
{{bar_brief}}

## Design rules (this is what makes it beautiful)
1. **One evolving metaphor.** Build a small cast of at most **6 persistent entities** (e.g. ring, nodes, packets, a matrix) and evolve them bar by bar. Reuse and transform entities; do not keep adding new ones. Remove or fade out what a bar no longer needs.
2. **One focal point per bar.** Each bar has a single clear visual action (its `action` above) that **lands exactly on `B(n).visual_hit_time_sec`**: a pop (`back.out`), a snap, a connection drawing on, a glow flare, a count-up. Everything else is quieter.
3. **Readable on a phone.** Every text label ≥ **32px** (key labels 40–56px), bold, high contrast on solid or near-solid fills. At most **8 text labels visible at once**. Prefer short labels (1–3 words or a number). No paragraphs, no formula strips, no meters, no title banners (the HUD already shows titles).
4. **No overlaps.** Give each entity its own region; label pills sit beside or inside their shape, never on top of another entity's label. When something moves into a region, fade or move out whatever was there first.
5. **Cinematic camera.** Animate `#scene-camera` (`scale` 1.0–1.35, `x`/`y` within ±180, `transformOrigin: "50% 50%"`) to push in on the focal entity and pull back at section changes. Never scale it below 1.0. Use `power2.inOut` / `expo.out` eases, 0.6–1.6s moves.
6. **Always alive.** Continuous slow motion (a slowly rotating ring, drifting particles, a flowing dashed connector), plus a small dedicated element that pulses on `TIMELINE_DATA.beats` (scale or opacity on its own element only).
7. **Intro (0 → {{intro_end}}s).** Assemble the scene (draw-on strokes, staggered pop-ins) so there is no dead air before bar 1.
8. **Motion quality.** Entrances use `expo.out`/`back.out(1.6)`, exits `power2.in`; stagger groups by 0.04–0.08s; give big moves a 0.1s anticipation. Use `stroke-dasharray`/`stroke-dashoffset` draw-ons for lines. Glow via SVG `filter` (`feGaussianBlur`) on a few accent elements only.
9. **Don't duplicate the shell.** No captions, no lyric text, no kinetic typography of the hit word (on bars marked `SHELL SLAMS HIT WORD` the shell cuts the scene away for ~1s at the hit time and slams the word full-screen, so land that bar's focal change just before or just after the slam).

## Hard technical rules (violations are rejected automatically)
- Only `tl.fromTo(target, from, to, position)`, `tl.to(...)`, `tl.set(...)`. Never `gsap.from`/`tl.from`, never create a timeline, never touch `window.__timelines`, never call `play()`.
- When several tweens animate the same property of the same element, pass `immediateRender: false` on all but the first and make each `from` equal the previous end value.
- Rotating/scaling SVG elements must set `svgOrigin: "cx cy"` (absolute SVG coordinates of their centre) or `transformOrigin: "50% 50%"`.
- No `requestAnimationFrame`, `setTimeout`, `setInterval`, `Math.random`, CSS `@keyframes`/`animation`/`transition`.
- Every element id must start with `s-`. Every CSS selector must start with `#scene`. Do not target `#scene` itself (the shell hides it during word slams) — target `#scene-camera` or your own elements.
- Do not declare `tl`, `BARS_DATA`, `TIMELINE_DATA`, `PALETTE`, `FONTS`, `B`, or `beatsBetween`. Your script runs inside a function, so local `const`s are fine.
- Build repeated shapes with compact JS loops (`document.createElementNS("http://www.w3.org/2000/svg", ...)`) when it saves lines. Keep the whole scene under ~350 lines.

## Output format
Return exactly these three blocks and nothing else:

<scene-style>
/* CSS; every selector starts with #scene */
</scene-style>

<scene-markup>
<!-- markup placed inside #scene-camera -->
</scene-markup>

<scene-script>
// JS that adds tweens to `tl`
</scene-script>
