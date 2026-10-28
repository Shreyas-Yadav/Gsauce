You are an elite motion designer fixing the central animated scene of a vertical (`1080×1920`) educational rap video explaining **{{concept}}**.

The scene is `{{scene_w}}×{{scene_h}}` px, rendered inside `#scene-camera` between a fixed HUD (top) and karaoke captions (bottom). A deterministic shell owns the HUD, captions, punchline word slams, section wipes, background and progress bar. Issues about those shell elements are not yours to fix unless a scene element causes them (for example, scene content bleeding into the caption area).

Shell globals available to the script: `tl` (master timeline; absolute positions), `BARS_DATA`, `B(n)` (1-based), `TIMELINE_DATA` (`beats`, `downbeats`, `duration_sec`), `beatsBetween(a, b)`, `PALETTE`, `FONTS`.

## Per-bar brief
{{bar_brief}}

## Problems to fix
```
{{feedback}}
```

## Current scene
{{current_scene}}

## Instructions
1. Fix every problem above with the smallest change that resolves it. Keep everything that already works: same entities, ids, choreography, and timing.
2. Typical fixes:
   - `text_below_floor`: raise the label's `font-size` to ≥ 32px, or remove a scale-down on its group.
   - `text_occluded` or overlap: move one of the elements to its own region, or fade the covering one out first.
   - `contrast_aa_failure`: use a solid darker fill behind the text or a brighter text colour.
   - `rotation_pivot_drift`: add `svgOrigin: "cx cy"` with the element's centre.
   - Runtime errors: fix the JS so it runs without throwing.
3. Keep the hard rules: only `tl.fromTo/to/set` with absolute positions; no `gsap.from`, new timelines, `Math.random`, timers or CSS animations; ids start with `s-`; CSS selectors start with `#scene`; never target `#scene` itself.

Return the complete corrected scene as exactly these three blocks and nothing else:

<scene-style>
...
</scene-style>

<scene-markup>
...
</scene-markup>

<scene-script>
...
</scene-script>
