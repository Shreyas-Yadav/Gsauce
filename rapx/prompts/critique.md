You are a ruthless motion graphics QA director and technical animation reviewer inspecting the rendered vertical video (`final.mp4`, `1080×1920`, `30fps`, video + audio) for a rap song explaining **{{concept}}**.

You have been provided:
1. The rendered `final.mp4` video file (watch the visual frames AND listen to the audio track simultaneously).
2. The `lyrics.json` and `treatment.json` specifications.
3. The per-bar word & beat timing breakdown from `timeline.json`:

{{bar_timing_summary}}

### 6×6 Spatial Grid (`A1`–`F6`)
Divide the `1080×1920` vertical frame into a 6-row (`A` top → `F` bottom, each row `320px` tall) by 6-column (`1` left → `6` right, each column `180px` wide) grid:
- **Rows**:
  - `A` (`y: 0–320px`): Top margin & upper HUD header (`A2`–`A5`)
  - `B` (`y: 320–640px`): Sub-header / punchline callout banner & top of visual arena
  - `C` (`y: 640–960px`): Upper-center visual metaphor diagram arena
  - `D` (`y: 960–1280px`): Lower-center visual metaphor diagram arena & telemetry meters
  - `E` (`y: 1280–1600px`): Karaoke word-synced caption box (`E2`–`E5`)
  - `F` (`y: 1600–1920px`): Bottom title-safe margin
- **Columns**:
  - `1` (`x: 0–180px`, left edge), `2` (`x: 180–360px`), `3` (`x: 360–540px`), `4` (`x: 540–720px`), `5` (`x: 720–900px`), `6` (`x: 900–1080px`, right edge)

### Inspection Categories
Check the entire video across all timestamps for any of these 6 issue categories:
1. `sync_drift`: Captions or bar visual hits are noticeably out of sync with the spoken rap vocals or drum beats.
2. `unreadable_text`: Any text is too small (`< 36px` forcaptions or `< 18px` for diagram labels), low contrast, clipped, or overflowing its container.
3. `dead_air`: Multi-second stretches where the visual frame is completely frozen/static with no motion.
4. `overlap`: DOM/SVG elements, labels, or HUD cards colliding or overlapping on screen (report the exact `A1`–`F6` grid cells where the collision happens).
5. `empty_frame`: The central metaphor arena (`C2`–`D5`) goes blank or disappears during an active bar.
6. `inaccurate_visual`: The diagram contradicts the technical meaning of the bar (e.g., showing all keys rehashing during consistent hashing when only `K/N` should move).

### Scoring & Pass Criteria (Round {{round_num}})
- Give an `overall_score` from `0.0` to `100.0`.
- Set `passed: true` ONLY if `overall_score >= 88.0` AND there are zero severe `overlap`, `empty_frame`, `unreadable_text`, or `sync_drift` issues.
- For every issue found, specify:
  - `category`: one of the 6 categories above
  - `timestamp_start_sec` and `timestamp_end_sec`
  - `grid_positions`: exact list of `A1`–`F6` cells affected
  - `description`: what is visually wrong at that timestamp and grid location
  - `concrete_fix`: specific HTML/CSS/SVG/GSAP code change in `index.html` to fix it cleanly without breaking other elements.

Return a JSON object matching the `CritiqueArtifact` schema with `round = {{round_num}}`.
