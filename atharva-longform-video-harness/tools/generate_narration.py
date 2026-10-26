import asyncio
import json
import os
import subprocess
import edge_tts

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "+2%"
OUT_DIR = "build/audio/segments"
os.makedirs(OUT_DIR, exist_ok=True)

SEGMENTS = [
    {
        "id": "s01_intro",
        "act": 1,
        "pause_before": 1.2,
        "text": "Inside your brain, eighty-six billion neurons are firing in a storm of electro-chemical pulses.",
    },
    {
        "id": "s02_authors",
        "act": 1,
        "pause_before": 0.6,
        "text": "In nineteen forty-three, neurophysiologist Warren McCulloch and an eighteen-year-old logician named Walter Pitts asked a radical question: beneath all that messy biology, what is a single neuron actually doing?",
    },
    {
        "id": "s03_strip",
        "act": 2,
        "pause_before": 0.8,
        "text": "Their answer launched artificial intelligence. They stripped away the chemistry and noticed one fundamental property: a neuron's signal is all-or-none.",
    },
    {
        "id": "s04_binary",
        "act": 2,
        "pause_before": 0.5,
        "text": "At any tick of the clock, a cell either stays silent, zero, or fires a pulse, one.",
    },
    {
        "id": "s05_rules",
        "act": 3,
        "pause_before": 0.8,
        "text": "The McCulloch-Pitts neuron follows three strict rules. First, excitatory inputs send positive signals into the cell, where they are simply added together.",
    },
    {
        "id": "s06_threshold",
        "act": 3,
        "pause_before": 0.5,
        "text": "Second, the cell holds a fixed threshold, theta. If the sum reaches theta, the neuron fires on the very next time step.",
    },
    {
        "id": "s07_inhibitory",
        "act": 3,
        "pause_before": 0.6,
        "text": "Third, inhibitory inputs act as an absolute veto. Drawn as a small loop on the cell, a single active inhibitory input silences the neuron completely, no matter how strong the excitation.",
    },
    {
        "id": "s08_logic",
        "act": 4,
        "pause_before": 0.8,
        "text": "Why does this matter? Because by tuning the threshold, this simple cell becomes a universal logic gate.",
    },
    {
        "id": "s09_or_and",
        "act": 4,
        "pause_before": 0.5,
        "text": "Set theta to one with two inputs, and either signal triggers it: an OR gate. Raise theta to two, and both inputs must arrive together: an AND gate.",
    },
    {
        "id": "s10_not_net",
        "act": 4,
        "pause_before": 0.5,
        "text": "Attach an inhibitory veto, and you get NOT. Chain these cells into a network, and they can compute any logical proposition.",
    },
    {
        "id": "s11_limits",
        "act": 5,
        "pause_before": 0.8,
        "text": "Yet the model had a fatal flaw. Every input had equal strength, and every threshold had to be wired by hand. A McCulloch-Pitts neuron could compute, but it could never learn.",
    },
    {
        "id": "s12_outro",
        "act": 5,
        "pause_before": 0.6,
        "text": "Still, by translating living cells into pure logic, McCulloch and Pitts laid the cornerstone for everything that followed: from the Perceptron to modern deep learning.",
    },
]

def get_duration(path):
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True
    )
    return float(res.stdout.strip())

async def synth_all():
    timeline = []
    cursor = 0.0
    for seg in SEGMENTS:
        cursor += seg["pause_before"]
        mp3_path = os.path.join(OUT_DIR, f"{seg['id']}.mp3")
        wav_path = os.path.join(OUT_DIR, f"{seg['id']}.wav")
        comm = edge_tts.Communicate(seg["text"], VOICE, rate=RATE, boundary="WordBoundary")
        words = []
        with open(mp3_path, "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    w_start = chunk["offset"] / 10_000_000.0
                    w_dur = chunk["duration"] / 10_000_000.0
                    words.append({
                        "word": chunk["text"],
                        "rel_start": round(w_start, 3),
                        "rel_end": round(w_start + w_dur, 3),
                        "start": round(cursor + w_start, 3),
                        "end": round(cursor + w_start + w_dur, 3),
                    })
        # Convert to 48kHz stereo wav and trim trailing silence slightly
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-i", mp3_path,
            "-af", "silenceremove=start_periods=1:start_silence=0.02:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB,areverse",
            "-ar", "48000", "-ac", "2", wav_path
        ], check=True)
        dur = get_duration(wav_path)
        seg_info = {
            "id": seg["id"],
            "act": seg["act"],
            "text": seg["text"],
            "start": round(cursor, 3),
            "end": round(cursor + dur, 3),
            "duration": round(dur, 3),
            "wav": wav_path,
            "words": words,
        }
        timeline.append(seg_info)
        print(f"{seg['id']}: {seg_info['start']:.2f}s -> {seg_info['end']:.2f}s ({dur:.2f}s) | {seg['text'][:50]}...")
        cursor += dur

    total_duration = round(cursor + 2.5, 2)
    out_data = {
        "voice": VOICE,
        "total_duration": total_duration,
        "segments": timeline,
    }
    os.makedirs("src/data", exist_ok=True)
    with open("src/data/narration.json", "w") as f:
        json.dump(out_data, f, indent=2)
    print(f"\nTotal video duration with tail: {total_duration}s")

if __name__ == "__main__":
    asyncio.run(synth_all())
