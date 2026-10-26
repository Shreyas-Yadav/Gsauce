import json
import math
import os
import subprocess
import wave
import numpy as np
from scipy import signal

SR = 48000

with open("src/data/narration.json") as f:
    narration = json.load(f)

DURATION = float(narration["total_duration"])
N_SAMPLES = int(round(DURATION * SR))

def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))

def make_stereo_reverb_ir(duration=2.4, decay=2.8, seed=42):
    rng = np.random.default_rng(seed)
    length = int(duration * SR)
    t = np.linspace(0, duration, length, endpoint=False)
    env = np.exp(-t * decay)
    # Early reflections + diffuse tail
    ir_l = rng.normal(0, 1, length) * env
    ir_r = rng.normal(0, 1, length) * env
    # Lowpass the reverb tail at 2800 Hz for warm room sound
    b, a = signal.butter(2, 2800.0 / (SR / 2), btype="low")
    ir_l = signal.lfilter(b, a, ir_l)
    ir_r = signal.lfilter(b, a, ir_r)
    # Normalize IR energy
    norm = np.sqrt(np.sum(ir_l ** 2) + 1e-9)
    return ir_l / norm * 0.28, ir_r / norm * 0.28

def add_stereo_note(buf_l, buf_r, start_s, dur_s, freq, amp=0.1, pan=0.0, timbre="pad", attack=0.05, release=0.4):
    i0 = max(0, int(round(start_s * SR)))
    length = int(round(dur_s * SR))
    if i0 >= N_SAMPLES or length <= 10:
        return
    i1 = min(N_SAMPLES, i0 + length)
    actual_len = i1 - i0
    t = np.arange(actual_len, dtype=np.float64) / SR

    # Envelope
    env = np.ones(actual_len, dtype=np.float64)
    att_n = max(1, int(round(attack * SR)))
    rel_n = max(1, int(round(release * SR)))
    if att_n < actual_len:
        env[:att_n] = np.linspace(0.0, 1.0, att_n) ** 1.4
    else:
        env = np.linspace(0.0, 1.0, actual_len)

    if timbre in ("marimba", "bell", "pluck", "tick"):
        # Exponential decay after attack
        decay_rate = 5.5 / max(0.08, dur_s)
        env *= np.exp(-np.maximum(0.0, t - attack) * decay_rate)
        env[-min(rel_n, actual_len):] *= np.linspace(1.0, 0.0, min(rel_n, actual_len))
    else:
        # Sustained pad/bass envelope
        if rel_n < actual_len:
            env[-rel_n:] *= np.linspace(1.0, 0.0, rel_n) ** 1.6

    phase = 2.0 * np.pi * freq * t
    if timbre == "pad":
        # Warm detuned analog-style additive pad
        p1 = 2.0 * np.pi * (freq * 0.998) * t
        p2 = 2.0 * np.pi * (freq * 1.002) * t
        wave_sig = (
            0.55 * np.sin(phase)
            + 0.25 * np.sin(p1)
            + 0.25 * np.sin(p2)
            + 0.14 * np.sin(2.0 * phase + 0.3) * np.exp(-t * 0.4)
            + 0.05 * np.sin(3.0 * phase + 0.7) * np.exp(-t * 0.8)
        )
    elif timbre == "bass":
        wave_sig = (
            0.75 * np.sin(phase)
            + 0.25 * np.sin(2.0 * phase) * np.exp(-t * 0.8)
            + 0.08 * np.sin(3.0 * phase) * np.exp(-t * 1.5)
        )
    elif timbre == "marimba":
        # Warm wooden mallet: fundamental + 4th harmonic with fast decay + soft strike transient
        strike = np.sin(7.0 * phase) * np.exp(-t * 45.0) * 0.15
        wave_sig = (
            0.80 * np.sin(phase)
            + 0.22 * np.sin(2.0 * phase) * np.exp(-t * 6.0)
            + 0.12 * np.sin(4.0 * phase) * np.exp(-t * 14.0)
            + strike
        )
    elif timbre == "bell":
        # Crystalline FM / modal chime
        mod = 1.2 * np.sin(2.0 * phase) * np.exp(-t * 4.5)
        wave_sig = (
            0.70 * np.sin(phase + mod)
            + 0.25 * np.sin(2.756 * phase) * np.exp(-t * 7.0)
            + 0.12 * np.sin(5.404 * phase) * np.exp(-t * 12.0)
        )
    elif timbre == "pluck":
        wave_sig = (
            0.65 * np.sin(phase)
            + 0.30 * np.sin(2.0 * phase) * np.exp(-t * 5.0)
            + 0.15 * np.sin(3.0 * phase) * np.exp(-t * 9.0)
            + 0.08 * np.sin(4.0 * phase) * np.exp(-t * 14.0)
        )
    else:
        wave_sig = np.sin(phase)

    sig = wave_sig * env * amp
    # Equal-power stereo panning (-1.0 left to +1.0 right)
    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * (np.pi / 4.0)
    gain_l = math.cos(angle)
    gain_r = math.sin(angle)
    buf_l[i0:i1] += sig * gain_l
    buf_r[i0:i1] += sig * gain_r

def add_sfx(buf_l, buf_r, start_s, kind, amp=0.12, pan=0.0):
    i0 = max(0, int(round(start_s * SR)))
    if i0 >= N_SAMPLES:
        return
    rng = np.random.default_rng(int(round(start_s * 1000)) + 17)

    if kind == "tick":
        # Crisp mechanical clock / synapse tick (35 ms)
        dur = 0.045
        n = min(N_SAMPLES - i0, int(dur * SR))
        t = np.arange(n) / SR
        noise = rng.normal(0, 1, n) * np.exp(-t * 180.0) * 0.35
        tone = (np.sin(2 * np.pi * 1150 * t) * np.exp(-t * 110.0) * 0.65 +
                np.sin(2 * np.pi * 420 * t) * np.exp(-t * 75.0) * 0.45)
        sig = (noise + tone) * amp
    elif kind == "spike":
        # Bright golden firing impulse: upward chirp + warm harmonic bell tail
        dur = 0.55
        n = min(N_SAMPLES - i0, int(dur * SR))
        t = np.arange(n) / SR
        freq_sweep = 260.0 + 620.0 * np.exp(-t * 28.0)
        phase = 2 * np.pi * np.cumsum(freq_sweep) / SR
        ping = np.sin(phase) * np.exp(-t * 12.0) * 0.5
        chime = (np.sin(2 * np.pi * 587.33 * t) * 0.6 +
                 np.sin(2 * np.pi * 880.0 * t) * 0.4 +
                 np.sin(2 * np.pi * 1174.66 * t) * 0.25) * np.exp(-t * 6.5)
        env_a = np.minimum(1.0, t / 0.004)
        sig = (ping + chime) * env_a * amp
    elif kind == "veto":
        # Inhibitory veto clamp: firm low-mid downward thud + metallic mute
        dur = 0.65
        n = min(N_SAMPLES - i0, int(dur * SR))
        t = np.arange(n) / SR
        f_drop = 95.0 + 190.0 * np.exp(-t * 22.0)
        phase = 2 * np.pi * np.cumsum(f_drop) / SR
        thud = np.sin(phase) * np.exp(-t * 7.5) * 0.75
        clamp_click = (np.sin(2 * np.pi * 311.13 * t) + 0.5 * np.sin(2 * np.pi * 466.16 * t)) * np.exp(-t * 14.0) * 0.4
        env_a = np.minimum(1.0, t / 0.005)
        sig = (thud + clamp_click) * env_a * amp
    elif kind == "whoosh":
        # Soft filtered air transition swell
        dur = 0.85
        n = min(N_SAMPLES - i0, int(dur * SR))
        t = np.arange(n) / SR
        noise = rng.normal(0, 1, n)
        b, a = signal.butter(2, [220.0 / (SR / 2), 1400.0 / (SR / 2)], btype="band")
        filt = signal.lfilter(b, a, noise)
        env = np.sin(np.pi * (t / dur)) ** 2.0
        sig = filt * env * amp
    elif kind == "sum_step":
        # Subtle upward step tone when excitatory input adds to soma
        dur = 0.25
        n = min(N_SAMPLES - i0, int(dur * SR))
        t = np.arange(n) / SR
        sig = (np.sin(2 * np.pi * 440.0 * t) * 0.7 + np.sin(2 * np.pi * 659.25 * t) * 0.3) * np.exp(-t * 14.0) * np.minimum(1.0, t / 0.005) * amp
    else:
        return

    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * (np.pi / 4.0)
    buf_l[i0:i0 + len(sig)] += sig * math.cos(angle)
    buf_r[i0:i0 + len(sig)] += sig * math.sin(angle)

def build_music_and_sfx():
    music_l = np.zeros(N_SAMPLES, dtype=np.float64)
    music_r = np.zeros(N_SAMPLES, dtype=np.float64)
    sfx_l = np.zeros(N_SAMPLES, dtype=np.float64)
    sfx_r = np.zeros(N_SAMPLES, dtype=np.float64)

    # Chord progression across the 122.77s film (D Dorian / D minor -> D major resolution)
    # Each block is ~6 seconds (3 bars at 90 BPM, where 1 beat = 0.6667s, 1 bar = 2.6667s)
    chords = [
        # Act 1: Biological Storm & 1943 Question (0 - 21s)
        (0.0, 5.5, [38, 45, 50, 57, 60, 64], [62, 64, 65, 69]),    # Dm9
        (5.5, 11.0, [36, 48, 52, 55, 59, 64], [60, 64, 67, 71]),   # Cmaj7
        (11.0, 16.0, [34, 46, 50, 53, 57, 60], [58, 62, 65, 69]),  # Bbmaj7
        (16.0, 21.0, [33, 45, 52, 55, 57, 61], [57, 61, 64, 67]),  # A7sus4 -> A7

        # Act 2: All-or-None Abstraction (21 - 37.2s)
        (21.0, 26.5, [38, 45, 50, 53, 57, 62], [62, 65, 69, 72]),  # Dm7
        (26.5, 31.5, [43, 50, 53, 57, 60, 65], [62, 65, 69, 74]),  # Gm9 / D
        (31.5, 37.2, [36, 48, 52, 55, 60, 64], [60, 64, 67, 72]),  # Cadd9

        # Act 3: The Three Rules (37.2 - 70.8s)
        (37.2, 43.0, [38, 45, 50, 57, 60, 65], [62, 65, 69, 72]),  # Dm7
        (43.0, 48.0, [41, 48, 53, 57, 60, 64], [60, 65, 69, 72]),  # Fmaj7
        (48.0, 56.2, [36, 48, 55, 57, 60, 64], [60, 64, 67, 74]),  # C6/9 (Threshold lift)
        (56.2, 63.5, [34, 46, 50, 56, 59, 62], [58, 62, 65, 68]),  # Bbm6 / Diminished tension (Inhibitory rule)
        (63.5, 70.8, [33, 45, 52, 55, 58, 61], [57, 61, 64, 69]),  # A7b9 tension

        # Act 4: Universal Logic Gates (70.8 - 98.0s)
        (70.8, 77.8, [38, 45, 50, 57, 62, 64], [62, 64, 69, 74]),  # Dsus2 (Bright mathematical clarity)
        (77.8, 83.8, [41, 48, 53, 57, 60, 65], [65, 69, 72, 76]),  # Fmaj7 (OR gate)
        (83.8, 89.5, [36, 48, 52, 55, 60, 64], [64, 67, 72, 76]),  # Cmaj7 (AND gate)
        (89.5, 98.0, [43, 50, 55, 58, 62, 67], [62, 67, 70, 74]),  # Gm7 -> C9 (NOT & Network)

        # Act 5: Limitations & Legacy (98.0 - 122.77s)
        (98.0, 104.5, [38, 45, 50, 53, 57, 60], [62, 65, 69]),     # Dm (Somber reflection on limitations)
        (104.5, 109.8, [34, 46, 50, 53, 57, 62], [58, 62, 65]),    # Bbmaj7
        (109.8, 116.0, [38, 45, 50, 57, 62, 66], [62, 66, 69, 74]),# Dmaj7 (Warm major lift: The Cornerstone)
        (116.0, 122.77, [38, 45, 50, 57, 62, 66, 69], [62, 66, 69, 73, 74]), # Dmaj9 resonant finale
    ]

    for c_start, c_end, pad_notes, arp_notes in chords:
        dur = c_end - c_start
        # Deep bass root
        add_stereo_note(music_l, music_r, c_start, dur + 0.4, midi_to_hz(pad_notes[0]),
                        amp=0.14, pan=0.0, timbre="bass", attack=0.18, release=0.8)
        # Warm pad voices spread across stereo field
        for idx, m_note in enumerate(pad_notes[1:]):
            pan = (idx - 2.0) * 0.25
            add_stereo_note(music_l, music_r, c_start, dur + 0.6, midi_to_hz(m_note),
                            amp=0.045, pan=pan, timbre="pad", attack=0.45, release=1.1)

        # Gentle rhythmic marimba/pluck pulse (every 0.60s)
        step = 0.60
        n_steps = int(dur / step)
        for s_idx in range(n_steps):
            t_note = c_start + s_idx * step
            if t_note > DURATION - 1.2:
                break
            m_arp = arp_notes[s_idx % len(arp_notes)]
            # Alternate subtle accents
            vel = 0.048 if (s_idx % 4 == 0) else (0.032 if (s_idx % 2 == 0) else 0.022)
            # In Act 4 (Logic Gates), make the marimba slightly crisper
            timbre = "pluck" if (70.8 <= t_note < 98.0 and s_idx % 2 == 1) else "marimba"
            pan = math.sin(s_idx * 1.1) * 0.35
            add_stereo_note(music_l, music_r, t_note, 0.55, midi_to_hz(m_arp),
                            amp=vel, pan=pan, timbre=timbre, attack=0.008, release=0.25)

    # Final resolution bell chord at 120.2s
    for idx, m_bell in enumerate([62, 66, 69, 74, 78]):
        add_stereo_note(music_l, music_r, 120.2 + idx * 0.08, 2.4, midi_to_hz(m_bell),
                        amp=0.045, pan=(idx - 2) * 0.22, timbre="bell", attack=0.01, release=1.8)

    # Apply subtle stereo room reverb to music
    ir_l, ir_r = make_stereo_reverb_ir(duration=2.0, decay=2.6)
    wet_l = signal.fftconvolve(music_l, ir_l, mode="full")[:N_SAMPLES]
    wet_r = signal.fftconvolve(music_r, ir_r, mode="full")[:N_SAMPLES]
    music_l = music_l * 0.78 + wet_l * 0.42
    music_r = music_r * 0.78 + wet_r * 0.42

    # --- Synchronized Sound Design (SFX) ---
    sync_marks = [
        # Act 1: Storm spikes & 1943 stamp
        (2.60, "tick", 0.14, -0.2, "86 billion counter"),
        (4.45, "spike", 0.11, -0.3, "storm firing 1"),
        (4.85, "spike", 0.10, 0.25, "storm firing 2"),
        (5.30, "spike", 0.11, 0.0, "storm firing 3"),
        (7.60, "whoosh", 0.12, 0.0, "transition to 1943"),
        (8.48, "tick", 0.16, -0.25, "1943 stamp"),
        (10.62, "tick", 0.12, -0.35, "Warren McCulloch card"),
        (13.50, "tick", 0.12, 0.35, "Walter Pitts card"),
        (15.40, "sum_step", 0.13, 0.0, "radical question reticle"),

        # Act 2: Stripping chemistry & binary clock
        (21.00, "whoosh", 0.14, 0.0, "transition to Act 2"),
        (24.50, "whoosh", 0.15, 0.0, "strip away chemistry morph"),
        (30.00, "spike", 0.16, 0.0, "all-or-none snap"),
        (31.50, "tick", 0.16, 0.0, "clock tick 1"),
        (32.50, "tick", 0.14, -0.2, "clock tick 2"),
        (33.50, "tick", 0.14, -0.4, "silent 0 state"),
        (34.72, "veto", 0.11, -0.4, "zero badge"),
        (35.80, "spike", 0.20, 0.4, "fires a pulse 1"),

        # Act 3: Three Rules
        (37.20, "whoosh", 0.14, 0.0, "transition to Act 3"),
        (41.62, "tick", 0.15, -0.3, "Rule 1 excitatory"),
        (44.00, "sum_step", 0.15, -0.2, "excitatory input x1"),
        (44.60, "sum_step", 0.16, -0.1, "excitatory input x2"),
        (47.00, "sum_step", 0.18, 0.0, "added together sum=2"),
        (48.38, "tick", 0.15, -0.3, "Rule 2 threshold"),
        (50.89, "sum_step", 0.16, 0.0, "theta barrier"),
        (52.90, "sum_step", 0.16, 0.1, "reaches theta"),
        (54.30, "spike", 0.22, 0.3, "neuron fires on next step"),
        (56.62, "tick", 0.15, -0.3, "Rule 3 inhibitory"),
        (61.17, "sum_step", 0.14, 0.0, "drawn as small loop"),
        (64.30, "veto", 0.18, -0.1, "inhibitory input active"),
        (65.70, "veto", 0.24, 0.0, "silences neuron completely"),

        # Act 4: Logic Gates
        (70.80, "whoosh", 0.15, 0.0, "transition to Act 4"),
        (72.80, "tick", 0.14, 0.0, "tuning threshold dial"),
        (78.40, "sum_step", 0.15, -0.4, "theta = 1 OR gate"),
        (81.90, "spike", 0.18, -0.4, "OR gate triggers"),
        (84.40, "sum_step", 0.15, 0.0, "theta = 2 AND gate"),
        (87.30, "sum_step", 0.15, 0.0, "both inputs arrive"),
        (88.80, "spike", 0.20, 0.0, "AND gate fires"),
        (90.90, "veto", 0.18, 0.4, "inhibitory veto NOT gate"),
        (94.30, "spike", 0.14, -0.3, "network cascade 1"),
        (94.75, "spike", 0.14, 0.0, "network cascade 2"),
        (95.20, "spike", 0.16, 0.35, "network cascade 3"),

        # Act 5: Fatal Flaw & Legacy
        (98.00, "whoosh", 0.15, 0.0, "transition to Act 5"),
        (99.60, "veto", 0.18, 0.0, "fatal flaw stamp"),
        (101.70, "tick", 0.15, -0.25, "equal strength clamp"),
        (104.40, "tick", 0.15, 0.25, "wired by hand clamp"),
        (109.10, "veto", 0.16, 0.0, "never learn"),
        (110.00, "whoosh", 0.15, 0.0, "transition to legacy"),
        (116.00, "sum_step", 0.16, -0.2, "cornerstone 1943"),
        (118.70, "spike", 0.17, 0.1, "Perceptron 1958"),
        (119.80, "spike", 0.20, 0.35, "modern deep learning"),
    ]

    for t_mark, kind, amp, pan, _label in sync_marks:
        add_sfx(sfx_l, sfx_r, t_mark, kind, amp=amp, pan=pan)

    # Save sync marks metadata
    with open("src/data/audio_marks.json", "w") as f:
        json.dump([{"time": m[0], "kind": m[1], "label": m[4]} for m in sync_marks], f, indent=2)

    return music_l, music_r, sfx_l, sfx_r

def load_wav_stereo(path):
    with wave.open(path, "rb") as wf:
        n_ch = wf.getnchannels()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
        if n_ch == 2:
            arr = arr.reshape(-1, 2)
            return arr[:, 0], arr[:, 1]
        else:
            return arr, arr.copy()

def assemble_master():
    os.makedirs("build/audio", exist_ok=True)
    music_l, music_r, sfx_l, sfx_r = build_music_and_sfx()

    narr_l = np.zeros(N_SAMPLES, dtype=np.float64)
    narr_r = np.zeros(N_SAMPLES, dtype=np.float64)

    for seg in narration["segments"]:
        i0 = int(round(seg["start"] * SR))
        wl, wr = load_wav_stereo(seg["wav"])
        n = min(len(wl), N_SAMPLES - i0)
        if n > 0:
            narr_l[i0:i0 + n] += wl[:n]
            narr_r[i0:i0 + n] += wr[:n]

    # Normalize narration RMS to a clear broadcast level
    narr_peak = max(np.max(np.abs(narr_l)), np.max(np.abs(narr_r)), 1e-6)
    narr_l = (narr_l / narr_peak) * 0.82
    narr_r = (narr_r / narr_peak) * 0.82

    # Compute smooth voice activity envelope for sidechain ducking of music using O(N) uniform_filter1d
    from scipy.ndimage import uniform_filter1d
    voice_energy = np.abs(narr_l) + np.abs(narr_r)
    smooth_env = uniform_filter1d(voice_energy, size=int(0.18 * SR))
    speaking_mask = np.clip(smooth_env / 0.06, 0.0, 1.0)
    duck_curve = uniform_filter1d(speaking_mask, size=int(0.28 * SR))
    # Music gain is 1.0 in pauses, ducks to 0.34 when narrator speaks
    music_gain = 1.0 - 0.66 * duck_curve

    # Fade out master at very end (last 0.6s)
    fade_n = int(0.6 * SR)
    fade_env = np.ones(N_SAMPLES)
    fade_env[-fade_n:] = np.linspace(1.0, 0.0, fade_n)

    mix_l = (narr_l + music_l * music_gain * 0.85 + sfx_l * 0.75) * fade_env
    mix_r = (narr_r + music_r * music_gain * 0.85 + sfx_r * 0.75) * fade_env

    # Soft limiter to prevent any sample clipping above -1.0 dBTP (0.891)
    peak = max(np.max(np.abs(mix_l)), np.max(np.abs(mix_r)), 1e-6)
    if peak > 0.89:
        mix_l = np.tanh(mix_l / peak * 1.15) * 0.88
        mix_r = np.tanh(mix_r / peak * 1.15) * 0.88

    out_wav = "build/audio/master_audio.wav"
    stereo_int16 = np.empty((N_SAMPLES, 2), dtype=np.int16)
    stereo_int16[:, 0] = np.clip(mix_l * 32767.0, -32768, 32767).astype(np.int16)
    stereo_int16[:, 1] = np.clip(mix_r * 32767.0, -32768, 32767).astype(np.int16)

    with wave.open(out_wav, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(stereo_int16.tobytes())

    print(f"Wrote {out_wav} ({DURATION:.2f}s, {N_SAMPLES} samples)")
    # Measure integrated loudness with ffmpeg ebur128
    res = subprocess.run(
        ["ffmpeg", "-nostats", "-i", out_wav, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True
    )
    for line in res.stderr.splitlines()[-12:]:
        if any(k in line for k in ("I:", "LRA:", "Peak:", "Threshold:")):
            print("  ", line.strip())

if __name__ == "__main__":
    assemble_master()
