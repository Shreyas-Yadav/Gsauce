# Gsauce — Studio Web UI

Photoshop-style 2-menu creative studio for **Gsauce** — an AI informational film generation engine with frame-layer mark-out and audio/transcript timeline editing.

## Color Palette & Visual Language
- **Accent:** Crimson Red `#E00000`
- **Surface:** Matte Black `#181818`
- **Text:** Crea Beige `#F5E6CC`
- **Typography:**
  - Headings: `Anton`
  - Body & UI: `Archivo`
- **Layout:** one continuous surface; selection is shown with red bars and underlines, not boxed cards.

## Features
1. **2-Menu Studio Shell:**
   - **Menu 1 (Left):** Creations library with live thumbnail previews, durations, and status badges.
   - **Menu 2 (Right):** Scene & 10s Boundary Cut inspector, `entry_anchor` / `exit_anchor` handoff data, Flash reviewer findings, and direct `scene.js` code editor.
2. **Central Stage:**
   - **Prompt View:** Large headline with topic input, style pills (`Risograph`, `Watercolor`, `Line`), duration selectors (`30s`, `60s`, `120s`, `180s`).
   - **Canvas & Frame View:** Interactive stage showing the assembled film, individual scene MP4, or high-res frame stills.
3. **Mark-Out & Fix Frame:**
   - Click any frame in the bottom timeline to load it onto the stage.
   - Drag a red bounding box directly over any visual element (`x, y, w, h`).
   - Type an instruction in the bottom surgical bar and click **Fix Frame** to surgically patch only that scene.
4. **Bottom NLE Timeline Dock:**
   - **Track 1 (Frames):** Horizontal scrollbar of individual rendered frames (`f00000.jpg` …) with density filter (`1.0s`, `0.5s`, `0.25s`, `1f`) and 10s boundary cut inspection badges.
   - **Track 2 (Audio / TTS):** Synchronized spoken clauses and pauses. Click any clause to edit words inline and click **Update Voice & Timing** to re-synthesize audio and update subtitle cues.

## Quickstart

```bash
cd frontend
npm start
# Opens at http://localhost:4173
```
