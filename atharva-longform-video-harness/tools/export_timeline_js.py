import json
import os

with open("src/data/subtitles.json") as f:
    subs = json.load(f)

with open("src/data/narration.json") as f:
    narr = json.load(f)

with open("src/data/audio_marks.json") as f:
    marks = json.load(f)

js_content = f"""// Auto-generated timeline data from narration & audio pipeline
window.TIMELINE_DATA = {{
  duration: {narr["total_duration"]},
  fps: 30,
  subtitles: {json.dumps(subs, indent=2)},
  segments: {json.dumps(narr["segments"], indent=2)},
  marks: {json.dumps(marks, indent=2)}
}};
"""

os.makedirs("src", exist_ok=True)
with open("src/timeline_data.js", "w") as f:
    f.write(js_content)

print("Wrote src/timeline_data.js")
