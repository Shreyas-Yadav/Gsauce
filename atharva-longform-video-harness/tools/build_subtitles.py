import json
import os
import re

with open("src/data/narration.json") as f:
    data = json.load(f)

def fmt_srt(sec):
    ms = int(round((sec % 1) * 1000))
    s = int(sec) % 60
    m = (int(sec) // 60) % 60
    h = int(sec) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def fmt_vtt(sec):
    ms = int(round((sec % 1) * 1000))
    s = int(sec) % 60
    m = (int(sec) // 60) % 60
    h = int(sec) // 3600
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

cues = []
MAX_WORDS = 9
MAX_CHARS = 58

for seg in data["segments"]:
    tokens = seg["text"].split()
    words = seg["words"]
    enriched = []
    t_idx = 0
    for w in words:
        w_copy = dict(w)
        if t_idx < len(tokens):
            clean_tok = re.sub(r"[^\w\-']", "", tokens[t_idx]).lower()
            clean_w = re.sub(r"[^\w\-']", "", w["word"]).lower()
            if clean_tok == clean_w or clean_tok.startswith(clean_w) or clean_w.startswith(clean_tok):
                w_copy["display"] = tokens[t_idx]
                t_idx += 1
            else:
                w_copy["display"] = w["word"]
        else:
            w_copy["display"] = w["word"]
        enriched.append(w_copy)

    seg_cues = []
    chunk = []
    for i, w in enumerate(enriched):
        chunk.append(w)
        text_len = sum(len(x["display"]) for x in chunk) + len(chunk) - 1
        rem_words = len(enriched) - 1 - i
        is_strong_break = w["display"].endswith((".", ":", ";", "?"))
        is_comma = w["display"].endswith(",")

        # Split if strong break, or comma with at least 3 words and at least 3 words remaining
        should_split = False
        if is_strong_break and rem_words >= 2:
            should_split = True
        elif is_comma and len(chunk) >= 3 and rem_words >= 3:
            should_split = True
        elif (len(chunk) >= MAX_WORDS or text_len >= MAX_CHARS) and rem_words >= 3:
            should_split = True

        if should_split:
            seg_cues.append(chunk)
            chunk = []
    if chunk:
        seg_cues.append(chunk)

    # Merge any short 1-2 word chunk into its neighbor
    merged_cues = []
    for ch in seg_cues:
        if merged_cues and len(ch) <= 2 and (len(merged_cues[-1]) + len(ch) <= 11):
            merged_cues[-1].extend(ch)
        else:
            merged_cues.append(ch)
    seg_cues = merged_cues

    for chunk in seg_cues:
        cues.append({
            "act": seg["act"],
            "segment_id": seg["id"],
            "start": round(chunk[0]["start"], 3),
            "end": round(min(seg["end"] + 0.18, chunk[-1]["end"] + 0.18), 3),
            "words": chunk,
            "text": " ".join(x["display"] for x in chunk)
        })

for i in range(len(cues) - 1):
    if cues[i]["end"] > cues[i + 1]["start"] - 0.04:
        cues[i]["end"] = round(cues[i + 1]["start"] - 0.04, 3)

os.makedirs("out", exist_ok=True)
os.makedirs("src/data", exist_ok=True)

with open("src/data/subtitles.json", "w") as f:
    json.dump(cues, f, indent=2)

with open("out/mcculloch_pitts_neuron.srt", "w") as f:
    for idx, c in enumerate(cues, 1):
        f.write(f"{idx}\n{fmt_srt(c['start'])} --> {fmt_srt(c['end'])}\n{c['text']}\n\n")

with open("out/mcculloch_pitts_neuron.vtt", "w") as f:
    f.write("WEBVTT\n\n")
    for idx, c in enumerate(cues, 1):
        f.write(f"{idx}\n{fmt_vtt(c['start'])} --> {fmt_vtt(c['end'])}\n{c['text']}\n\n")

print(f"Generated {len(cues)} clean subtitle cues:")
for c in cues:
    print(f"[{c['start']:6.2f} - {c['end']:6.2f}] {c['text']}")
