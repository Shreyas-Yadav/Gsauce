# atharva-longform-video-harness

Atharva's generation harness for long-form (30–180 second) 9:16 explainer videos. It sits
alongside the main Gsauce pipeline and runs on its own.

Gemini 4 Argon plans the scenes and writes each one as a JavaScript animation.
Gemini 3.8 Flash reviews the rendered frames, timing, captions and narration and
reports timestamped findings. Argon then repairs only the scenes that failed.
Retries, repair rounds and time are capped.

## Layout

- `src/harness/`: planning, scene generation, verification, repair, audio, project state
- `src/server/` + `src/ui/`: the Gsauce studio (creations, inspector, frame and transcript timeline)
- `tools/`: CLI (`lit.js`), renderer, narration, subtitles and audio mixing
- `tests/`: unit and integration tests

## Run

Requires Node 22.16+, Python 3, and Chrome (set `CHROME_PATH` if it is not in the default location).

```bash
cd atharva-longform-video-harness
npm install
export GEMINI_API_KEY=...
npm test
npm run preflight
node tools/lit.js create "How a Kalman filter works" --duration=120 --style=risograph
```

Studio UI: `node src/server/index.js`, then open http://127.0.0.1:4173 (or the
port set in `PORT`).

Create in the studio runs the same `lit.js create` pipeline as a background
process (at most two at once). The studio polls
`GET /api/creations/:id/status` for the current stage and log, and Stop calls
`POST /api/creations/:id/cancel`.

The Progress tab (`GET /api/creations/:id/progress`) shows the request budget,
each pipeline stage per scene, and every Argon and Flash request. When a run
stops, Resume (`POST /api/creations/:id/resume`) restarts it from where it left
off. It can raise the request budget by up to 50 (logged as an approved
increase) and approve one uncertain Flash review retry.

Archive hides a creation from the list without touching its run folder; the ids
are kept in `build/runs/studio-archive.json`.
