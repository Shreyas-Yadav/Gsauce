"""Deterministic HyperFrames shell for Stage 9 (`code`).

Python owns everything that is identical across videos and easy to get wrong: the HyperFrames
contract, embedded timing data, the HUD, karaoke captions, punchline word slams, section wipes,
beat/energy-reactive background, and timeline registration. The LLM only writes the central
scene (`SceneParts`: scoped CSS, markup inside `#scene-camera`, and a script that adds tweens
to the shared `tl`), which keeps its output small and confines layout risk to one zone.
"""

from __future__ import annotations

import html
from html.parser import HTMLParser
import json
import re
from typing import Any

from rapx.schemas import SceneParts, TreatmentArtifact

WIDTH = 1080
HEIGHT = 1920
SCENE_TOP = 330
SCENE_W = 1080
SCENE_H = 1000
CAPTION_TOP = 1370
MAX_SLAMS = 6

# Every id the shell renders. Scene markup must not reuse these.
SHELL_IDS = {
    "root", "bgm", "visual-track", "bg", "bg-grid", "bg-energy", "bg-beat", "bg-vignette", "bg-grain",
    "hud", "hud-eyebrow", "hud-titles", "hud-bar", "beat-dot", "hud-sections", "scene", "scene-camera",
    "fx-layer", "wipe", "captions", "intro-card", "progress", "progress-fill",
}
SHELL_ID_PREFIXES = ("hud-title-", "bar-num-", "section-seg-", "slam-", "page-", "word-")

_SCENE_TAG_RE = {
    name: re.compile(rf"<scene-{name}>(.*?)</scene-{name}>", re.DOTALL | re.IGNORECASE)
    for name in ("style", "markup", "script")
}
_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*\n?|\n?\s*```\s*$")


def _strip_fence(text: str) -> str:
    return _FENCE_RE.sub("", text.strip()).strip()


def parse_scene_parts(raw_text: str) -> SceneParts:
    """Parse `<scene-style>`, `<scene-markup>`, `<scene-script>` blocks from an LLM response."""
    found: dict[str, str] = {}
    for name, rx in _SCENE_TAG_RE.items():
        m = rx.search(raw_text or "")
        found[name] = _strip_fence(m.group(1)) if m else ""
    missing = [n for n in ("markup", "script") if not found[n]]
    if missing:
        raise ValueError(f"LLM response is missing required block(s): {', '.join(f'<scene-{n}>' for n in missing)}")
    return SceneParts(style=found["style"], markup=found["markup"], script=found["script"])


def format_scene_parts(scene: SceneParts) -> str:
    """Render `SceneParts` back into the tagged format the LLM reads and writes."""
    return (
        f"<scene-style>\n{scene.style}\n</scene-style>\n\n"
        f"<scene-markup>\n{scene.markup}\n</scene-markup>\n\n"
        f"<scene-script>\n{scene.script}\n</scene-script>"
    )


_FORBIDDEN_SCRIPT_PATTERNS: list[tuple[str, str]] = [
    (r"gsap\.timeline\s*\(", "Do not create timelines; add tweens to the shared `tl`."),
    (r"window\.__timelines", "Do not touch `window.__timelines`; the shell registers `tl`."),
    (r"\b(?:const|let|var)\s+(?:tl|TIMELINE_DATA|BARS_DATA|PALETTE|FONTS|B|beatsBetween)\b\s*=",
     "Do not redeclare shell globals (`tl`, `TIMELINE_DATA`, `BARS_DATA`, `PALETTE`, `FONTS`, `B`, `beatsBetween`)."),
    (r"\b(?:gsap|tl)\.from\s*\(", "Never use `gsap.from()`/`tl.from()`; use `tl.fromTo()` with explicit start values."),
    (r"requestAnimationFrame|setTimeout|setInterval", "Never use requestAnimationFrame/setTimeout/setInterval."),
    (r"Math\.random", "Never use Math.random(); use fixed or index-derived values."),
    (r"\.(?:play|resume|restart)\s*\(", "Never play the timeline; the renderer seeks it."),
    (r"""["']#scene["']""", "Do not target `#scene` itself (the shell hides it during word slams); target `#scene-camera` or `s-` elements."),
]
_FORBIDDEN_STYLE_PATTERNS: list[tuple[str, str]] = [
    (r"@keyframes|\banimation\s*:|\btransition\s*:", "CSS animations/transitions are not seek-safe; animate with `tl`."),
]


# @-rules whose blocks contain declarations or keyframe stops rather than selectors.
_NON_SELECTOR_AT_RULES = ("@font-face", "@keyframes", "@-webkit-keyframes", "@page", "@property", "@counter-style")


def iter_rule_selectors(css: str) -> list[str]:
    """Return every style-rule selector, including rules nested in @media/@supports/@layer blocks."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    selectors: list[str] = []
    # Each open block records whether its children are style rules (True) or declarations (False).
    stack: list[bool] = []
    buf = ""
    for ch in css:
        if ch == "{":
            prelude = buf.strip()
            in_rule_list = not stack or stack[-1]
            if in_rule_list and prelude.startswith("@"):
                stack.append(not prelude.lower().startswith(_NON_SELECTOR_AT_RULES))
            else:
                if in_rule_list and prelude:
                    selectors.append(prelude)
                stack.append(False)
            buf = ""
        elif ch == "}":
            if stack:
                stack.pop()
            buf = ""
        elif ch == ";" and (not stack or stack[-1]):
            buf = ""  # end of a block-less at-rule such as @import
        else:
            buf += ch
    return selectors


def split_selector_list(selector: str) -> list[str]:
    """Split a selector list on top-level commas only (not inside `:is()`, `:not()`, `[attr="a,b"]`)."""
    parts: list[str] = []
    depth = 0
    quote = ""
    cur = ""
    for ch in selector:
        if quote:
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
            continue
        cur += ch
    parts.append(cur.strip())
    return [p for p in parts if p]


_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class _BalanceChecker(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.errors: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_TAGS:
            return
        if tag not in self.stack:
            self.errors.append(f"stray </{tag}>")
            return
        while self.stack and self.stack[-1] != tag:
            self.errors.append(f"unclosed <{self.stack.pop()}>")
        self.stack.pop()


def markup_balance_errors(markup: str) -> list[str]:
    """Unbalanced scene markup would swallow or break the shell elements that follow it."""
    checker = _BalanceChecker()
    checker.feed(markup)
    checker.close()
    return checker.errors + [f"unclosed <{t}>" for t in reversed(checker.stack)]


def scene_element_ids(markup: str) -> set[str]:
    return set(re.findall(r"""\bid\s*=\s*["']([^"']+)["']""", markup))


def validate_scene_parts(scene: SceneParts) -> list[str]:
    """Static checks that catch contract violations before spending time on a browser check or render."""
    problems: list[str] = []
    # Strip comments (but not the `//` inside URLs such as "http://...").
    script = re.sub(r"(?<![:\\'\"])//[^\n]*|/\*.*?\*/", "", scene.script, flags=re.DOTALL)
    for pattern, message in _FORBIDDEN_SCRIPT_PATTERNS:
        if re.search(pattern, script):
            problems.append(f"[scene-script] {message}")
    for pattern, message in _FORBIDDEN_STYLE_PATTERNS:
        if re.search(pattern, scene.style):
            problems.append(f"[scene-style] {message}")
    if re.search(r"<script\b", scene.markup, re.IGNORECASE):
        problems.append("[scene-markup] Do not put <script> tags in markup; all JS goes in <scene-script>.")
    if re.search(r"</script", scene.script + scene.style, re.IGNORECASE):
        problems.append("[scene-script] The text `</script` cannot appear in the script or style; build such strings by concatenation.")
    if re.search(r"</style", scene.style, re.IGNORECASE):
        problems.append("[scene-style] The text `</style` cannot appear in the CSS.")
    balance = markup_balance_errors(scene.markup)
    if balance:
        problems.append(f"[scene-markup] Markup tags are unbalanced: {balance[:6]}")
    if re.search(r"<style\b", scene.markup, re.IGNORECASE):
        problems.append("[scene-markup] Do not put <style> tags in markup; all CSS goes in <scene-style>.")
    if re.search(r"\bclass\s*=\s*[\"'][^\"']*\bclip\b", scene.markup):
        problems.append("[scene-markup] Do not use class=\"clip\" inside the scene; the shell owns HyperFrames clips.")

    bad_selectors = [s for s in iter_rule_selectors(scene.style) if any(
        not part.startswith("#scene") for part in split_selector_list(s)
    )]
    if bad_selectors:
        problems.append(
            "[scene-style] Every CSS selector must start with `#scene` so it cannot restyle the shell. "
            f"Offending selectors: {bad_selectors[:6]}"
        )

    collisions = sorted(
        i for i in scene_element_ids(scene.markup)
        if i in SHELL_IDS or i.startswith(SHELL_ID_PREFIXES)
    )
    if collisions:
        problems.append(f"[scene-markup] These ids are reserved by the shell; prefix scene ids with `s-`: {collisions}")
    return problems


# ---------------------------------------------------------------------------
# Colour helpers (captions must stay readable whatever palette the director picks)
# ---------------------------------------------------------------------------

def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", v):
        raise ValueError(f"Not a hex colour: {value!r}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def _rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c))):02X}" for c in rgb)


def mix_hex(a: str, b: str, t: float) -> str:
    """Linear mix: t=0 -> a, t=1 -> b."""
    ra, rb = _hex_to_rgb(a), _hex_to_rgb(b)
    return _rgb_to_hex(tuple(ra[i] + (rb[i] - ra[i]) * t for i in range(3)))  # type: ignore[arg-type]


def _luminance(value: str) -> float:
    def ch(c: int) -> float:
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = _hex_to_rgb(value)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast_ratio(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _safe_hex(value: str, fallback: str) -> str:
    try:
        return _rgb_to_hex(_hex_to_rgb(value))
    except ValueError:
        return fallback


def resolve_shell_colors(treatment: TreatmentArtifact) -> dict[str, str]:
    """Derive shell colours from the treatment palette, enforcing readable caption contrast."""
    p = treatment.palette
    bg = _safe_hex(p.background, "#070B14")
    text = _safe_hex(p.text, "#F8FAFC")
    if contrast_ratio(text, bg) < 7.0:
        text = "#F8FAFC" if _luminance(bg) < 0.4 else "#0B1020"
    primary = _safe_hex(p.primary, "#00F5D4")
    secondary = _safe_hex(p.secondary, "#7B2CBF")
    accent = _safe_hex(p.accent, "#FFB703")

    panel = mix_hex(bg, text, 0.05)
    # Upcoming (not yet sung) words: as dim as possible while staying >= 4.5:1 against the panel.
    upcoming = text
    for k in (0.62, 0.55, 0.48, 0.40, 0.32, 0.24, 0.16):
        candidate = mix_hex(text, panel, k)
        if contrast_ratio(candidate, panel) >= 4.5:
            upcoming = candidate
            break
    active = accent if contrast_ratio(accent, panel) >= 3.0 else text
    return {
        "bg": bg,
        "text": text,
        "primary": primary,
        "secondary": secondary,
        "accent": accent,
        "panel": panel,
        "upcoming": upcoming,
        "active": active,
    }


# ---------------------------------------------------------------------------
# Timeline-derived structures
# ---------------------------------------------------------------------------

def build_sections(bars_data: list[dict[str, Any]], point_titles: dict[int, str]) -> list[dict[str, Any]]:
    """One section per run of consecutive bars sharing a `point_order`."""
    sections: list[dict[str, Any]] = []
    for bar in bars_data:
        order = int(bar.get("point_order") or 1)
        if not sections or sections[-1]["order"] != order:
            sections.append({
                "order": order,
                "title": point_titles.get(order) or f"Part {len(sections) + 1}",
                "start": float(bar["start"]),
            })
    return sections


def _slam_font_px(word: str) -> int:
    n = max(1, len(word))
    return int(max(72, min(150, 940 / (0.66 * n))))


def build_slams(bars_data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Full-screen punchline word slams for flagged bars (capped, never overlapping in time)."""
    slams: list[dict[str, Any]] = []
    for i, bar in enumerate(bars_data):
        word = re.sub(r"[^\w\-']", "", str(bar.get("visual_hit_word") or "")).upper()
        if not bar.get("kinetic_punchline") or not word:
            continue
        t = float(bar.get("visual_hit_time_sec") or bar["start"])
        next_start = float(bars_data[i + 1]["start"]) if i + 1 < len(bars_data) else t + 1.6
        out = min(t + 0.85, max(t + 0.45, next_start - 0.45))
        if slams and t < slams[-1]["out"] + 0.6:
            continue
        slams.append({"id": f"slam-{len(slams)}", "word": word, "t": round(t, 3), "out": round(out, 3),
                      "font_px": _slam_font_px(word)})
        if len(slams) >= MAX_SLAMS:
            break
    return slams


def display_title(concept: str) -> str:
    """'explain me how RAG works' -> 'How RAG Works'."""
    t = re.sub(r"^\s*(?:please\s+)?(?:explain|describe|teach)(?:\s+(?:me|to me|us))?\s+", "", concept, flags=re.I)
    t = t.strip().rstrip("?.!") or concept.strip()
    words = t.split()
    return " ".join(w if any(c.isupper() for c in w) else w.capitalize() for w in words)


def truncate_words(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = text[: max_chars - 1].rsplit(" ", 1)[0].rstrip(" -:(,")
    return (cut or text[: max_chars - 1]) + "…"


def _google_fonts_href(treatment: TreatmentArtifact) -> str:
    fams: list[str] = []
    for name, weights in (
        (treatment.typography.heading_font, "600;700;800"),
        (treatment.typography.body_font, "500;700;800"),
        (treatment.typography.mono_font, "500;700"),
    ):
        clean = re.sub(r"[^A-Za-z0-9 ]", "", name or "").strip()
        if clean and not any(f.startswith(f"family={clean.replace(' ', '+')}:") for f in fams):
            fams.append(f"family={clean.replace(' ', '+')}:wght@{weights}")
    return "https://fonts.googleapis.com/css2?" + "&".join(fams) + "&display=swap"


def _css_font(name: str, fallback: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9 ]", "", name or "").strip()
    return f"'{clean}', {fallback}" if clean else fallback


# ---------------------------------------------------------------------------
# HTML assembly
# ---------------------------------------------------------------------------

_GRAIN_SVG = (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>"
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='7'/>"
    "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter>"
    "<rect width='100%' height='100%' filter='url(%23n)'/></svg>"
)

_SHELL_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1080px; height: 1920px; background: __BG__; overflow: hidden; }
body { color: __TEXT__; font-family: __BODY_FONT__; -webkit-font-smoothing: antialiased; }
#root { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: __BG__; }
.clip { position: absolute; inset: 0; }
#bg, #bg > div { position: absolute; inset: 0; pointer-events: none; }
#bg { background: radial-gradient(120% 70% at 50% 42%, __PRIMARY_SOFT__ 0%, __BG__ 62%); }
#bg-grid { top: -20px; bottom: auto; height: 2540px;
  background-image: linear-gradient(__GRID__ 1px, transparent 1px), linear-gradient(90deg, __GRID__ 1px, transparent 1px);
  background-size: 108px 108px; }
#bg-energy { background: radial-gradient(60% 40% at 50% 44%, __SECONDARY_GLOW__ 0%, transparent 70%); opacity: 0.12; }
#bg-beat { background: radial-gradient(90% 30% at 50% 100%, __ACCENT_GLOW__ 0%, transparent 70%); opacity: 0; }
#bg-vignette { background: radial-gradient(130% 85% at 50% 45%, transparent 55%, rgba(0,0,0,0.6) 100%); }
#bg-grain { background-image: url("__GRAIN__"); background-size: 240px 240px; opacity: 0.05; mix-blend-mode: overlay; }

#hud { position: absolute; top: 150px; left: 80px; width: 920px; height: 150px; }
#hud-eyebrow { position: absolute; top: 0; left: 0; height: 40px; width: 700px; display: flex; align-items: center;
  gap: 16px; padding-left: 6px; font-family: __MONO_FONT__; font-size: 28px; font-weight: 700;
  letter-spacing: 0.04em; text-transform: uppercase; color: __PRIMARY__; }
#hud-eyebrow span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#beat-dot { width: 18px; height: 18px; border-radius: 50%; background: __ACCENT__; opacity: 0.45;
  box-shadow: 0 0 18px __ACCENT__; flex: none; }
#hud-bar { position: absolute; top: 0; right: 0; height: 40px; width: 200px; font-family: __MONO_FONT__;
  font-size: 28px; font-weight: 700; color: __TEXT__; }
.bar-num { position: absolute; right: 0; top: 0; white-space: nowrap; opacity: 0; visibility: hidden; }
#bar-num-0 { opacity: 1; visibility: inherit; color: __ACCENT__; }
#hud-titles { position: absolute; top: 48px; left: 0; width: 920px; height: 64px; }
.hud-title { position: absolute; left: 0; top: 0; width: 920px; font-family: __HEADING_FONT__;
  font-size: 50px; line-height: 64px; font-weight: 800; letter-spacing: -0.01em; color: __TEXT__;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; visibility: hidden; }
#hud-title-0 { opacity: 1; visibility: inherit; }
#hud-sections { position: absolute; top: 132px; left: 0; width: 920px; height: 8px; display: flex; gap: 10px; }
.section-seg { flex: 1; height: 8px; border-radius: 4px; background: __TRACK__; }

#scene { position: absolute; top: __SCENE_TOP__px; left: 0; width: __SCENE_W__px; height: __SCENE_H__px; overflow: hidden;
  transform-origin: 50% 50%; }
#scene-camera { position: absolute; left: 0; top: 0; width: __SCENE_W__px; height: __SCENE_H__px; }

#fx-layer { position: absolute; top: __SCENE_TOP__px; left: 0; width: __SCENE_W__px; height: __SCENE_H__px;
  overflow: hidden; pointer-events: none; }
#wipe { position: absolute; top: -200px; left: 0; width: 520px; height: 1400px; transform: skewX(-14deg);
  background: linear-gradient(90deg, transparent, __ACCENT_WIPE__, transparent); opacity: 0; visibility: hidden; }
.slam-word { position: absolute; left: 40px; right: 40px; top: 0; bottom: 0; display: flex;
  align-items: center; justify-content: center; text-align: center; font-family: __HEADING_FONT__;
  font-weight: 800; line-height: 1; letter-spacing: -0.02em; color: __ACCENT__;
  text-shadow: 0 0 40px __ACCENT_GLOW__, 0 8px 0 rgba(0,0,0,0.35); opacity: 0; visibility: hidden; }

#captions { position: absolute; top: __CAPTION_TOP__px; left: 80px; width: 920px; height: 320px;
  border-radius: 36px; background: __PANEL__; border: 2px solid __PANEL_BORDER__;
  box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
.page, #intro-card { position: absolute; inset: 0; padding: 30px 40px; display: flex; flex-wrap: wrap;
  align-content: center; justify-content: center; gap: 6px 24px; opacity: 0; visibility: hidden; }
.word { display: inline-block; font-family: __HEADING_FONT__; font-size: 60px; line-height: 1.18;
  font-weight: 800; color: __UPCOMING__; transform-origin: 50% 80%; white-space: nowrap; }
.word.is-hit { text-decoration: underline; text-decoration-color: __ACCENT__; text-decoration-thickness: 6px;
  text-underline-offset: 10px; }
#intro-card { opacity: 1; visibility: inherit; flex-direction: column; flex-wrap: nowrap; gap: 14px; text-align: center; }
.intro-eyebrow { font-family: __MONO_FONT__; font-size: 30px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; color: __PRIMARY__; }
.intro-title { font-family: __HEADING_FONT__; font-size: 76px; line-height: 1.05; font-weight: 800; color: __TEXT__; }

#progress { position: absolute; top: 1724px; left: 80px; width: 920px; height: 10px; border-radius: 5px;
  background: __TRACK__; overflow: hidden; }
#progress-fill { width: 100%; height: 100%; background: linear-gradient(90deg, __PRIMARY__, __ACCENT__);
  transform-origin: 0 50%; transform: scaleX(0); }
"""

_SHELL_JS = """
const TIMELINE_DATA = __TIMELINE__;
const BARS_DATA = __BARS__;
const PALETTE = __PALETTE__;
const FONTS = __FONTS__;
const SCENE_W = __SCENE_W__;
const SCENE_H = __SCENE_H__;
const B = (n) => BARS_DATA[Math.max(0, Math.min(BARS_DATA.length - 1, n - 1))];
const beatsBetween = (a, b) => TIMELINE_DATA.beats.filter((t) => t >= a && t < b);
const tl = gsap.timeline({ paused: true });
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
(function () {
  const SECTIONS = __SECTIONS__;
  const SLAMS = __SLAMS__;
  const ENERGY = __ENERGY__;
  const D = TIMELINE_DATA.duration_sec;
  const NO_IR = { immediateRender: false };
  tl.set({}, {}, D);

  tl.fromTo("#progress-fill", { scaleX: 0 }, { scaleX: 1, duration: D, ease: "none" }, 0);
  tl.fromTo("#bg-grid", { y: 0 }, { y: -540, duration: D, ease: "none" }, 0);

  const step = 1 / ENERGY.fps;
  ENERGY.values.forEach((v, i) => {
    const prev = i > 0 ? ENERGY.values[i - 1] : v;
    tl.fromTo("#bg-energy", { opacity: 0.12 + 0.6 * prev }, { opacity: 0.12 + 0.6 * v, duration: step, ease: "none", immediateRender: i === 0 }, i * step);
  });

  const beats = TIMELINE_DATA.beats;
  const beatGap = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.65;
  const pulse = Math.min(0.32, beatGap * 0.6);
  beats.forEach((t) => {
    tl.fromTo("#beat-dot", { scale: 1.7, opacity: 1 }, { scale: 1, opacity: 0.45, duration: pulse, ease: "power2.out", ...NO_IR }, t);
  });
  TIMELINE_DATA.downbeats.forEach((t) => {
    tl.fromTo("#bg-beat", { opacity: 0.55 }, { opacity: 0, duration: Math.min(0.5, beatGap * 0.9), ease: "power2.out", ...NO_IR }, t);
  });

  const firstStart = BARS_DATA.length ? BARS_DATA[0].start : 0;
  tl.set("#intro-card", { autoAlpha: 0 }, Math.max(0.01, firstStart - 0.02));

  SECTIONS.forEach((s, i) => {
    tl.fromTo(`#section-seg-${i}`, { backgroundColor: PALETTE.track }, { backgroundColor: PALETTE.accent, duration: 0.3, ...NO_IR }, Math.max(0.01, s.start));
    if (i === 0) return;
    tl.set(`#hud-title-${i - 1}`, { autoAlpha: 0 }, s.start);
    tl.fromTo(`#hud-title-${i}`, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power3.out", ...NO_IR }, s.start);
    tl.fromTo("#wipe", { autoAlpha: 1, x: -700 }, { autoAlpha: 1, x: 1300, duration: 0.55, ease: "power2.inOut", ...NO_IR }, Math.max(0.01, s.start - 0.25));
    tl.set("#wipe", { autoAlpha: 0 }, s.start + 0.31);
  });

  BARS_DATA.forEach((bar, i) => {
    tl.set(`#bar-num-${i}`, { autoAlpha: 0 }, bar.start);
    tl.set(`#bar-num-${i + 1}`, { autoAlpha: 1 }, bar.start);
    if (i > 0) tl.set(`#page-${i - 1}`, { autoAlpha: 0 }, bar.start);
    tl.set(`#page-${i}`, { autoAlpha: 1 }, bar.start);
    bar.words.forEach((w, j) => {
      const sel = `#word-${i}-${j}`;
      const hit = j === bar.hit_word_index;
      tl.fromTo(sel, { color: PALETTE.upcoming, scale: 1, y: 0 },
        { color: PALETTE.active, scale: hit ? 1.1 : 1.05, y: -6, duration: Math.max(0.06, Math.min(0.14, w.end - w.start)), ease: "back.out(3)", ...NO_IR }, w.start);
      tl.fromTo(sel, { color: PALETTE.active, scale: hit ? 1.1 : 1.05, y: -6 },
        { color: hit ? PALETTE.accent : PALETTE.text, scale: 1, y: 0, duration: 0.14, ease: "power2.out", ...NO_IR }, Math.max(w.start + 0.07, w.end));
    });
  });

  SLAMS.forEach((s) => {
    const sel = `#${s.id}`;
    tl.fromTo("#scene", { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.96, duration: 0.1, ...NO_IR }, Math.max(0.01, s.t - 0.06));
    tl.fromTo(sel, { autoAlpha: 0, scale: 1.75, rotation: -4 }, { autoAlpha: 1, scale: 1, rotation: 0, duration: 0.3, ease: "back.out(2)", ...NO_IR }, s.t);
    tl.fromTo(sel, { autoAlpha: 1, scale: 1 }, { autoAlpha: 0, scale: 0.92, duration: 0.22, ease: "power2.in", ...NO_IR }, s.out);
    // The scene returns only once the word has gone, so the two never share the frame.
    tl.fromTo("#scene", { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power2.out", ...NO_IR }, s.out + 0.2);
  });
})();
"""

_REGISTER_JS = """
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
tl.seek(0);
"""


def _fill(template: str, values: dict[str, str]) -> str:
    out = template
    for key, val in values.items():
        out = out.replace(f"__{key}__", val)
    return out


def _js_json(value: Any) -> str:
    # `</` must not appear inside an inline <script>.
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/")


def _rgba(hex_value: str, alpha: float) -> str:
    r, g, b = _hex_to_rgb(hex_value)
    return f"rgba({r},{g},{b},{alpha})"


def build_shell_html(
    *,
    concept: str,
    treatment: TreatmentArtifact,
    timeline_compact: dict[str, Any],
    bars_data: list[dict[str, Any]],
    point_titles: dict[int, str],
    energy: dict[str, Any],
    audio_filename: str,
    scene: SceneParts,
) -> str:
    """Assemble the complete HyperFrames `index.html` around the LLM-authored scene."""
    duration = float(timeline_compact["duration_sec"])
    colors = resolve_shell_colors(treatment)
    sections = build_sections(bars_data, point_titles)
    slams = build_slams(bars_data)
    title = display_title(concept)
    heading_font = _css_font(treatment.typography.heading_font, "system-ui, sans-serif")
    body_font = _css_font(treatment.typography.body_font, "system-ui, sans-serif")
    mono_font = _css_font(treatment.typography.mono_font, "ui-monospace, monospace")

    css = _fill(_SHELL_CSS, {
        "BG": colors["bg"],
        "TEXT": colors["text"],
        "PRIMARY": colors["primary"],
        "ACCENT": colors["accent"],
        "PRIMARY_SOFT": _rgba(colors["primary"], 0.10),
        "GRID": _rgba(colors["primary"], 0.05),
        "SECONDARY_GLOW": _rgba(colors["secondary"], 0.55),
        "ACCENT_GLOW": _rgba(colors["accent"], 0.45),
        "ACCENT_WIPE": _rgba(colors["accent"], 0.55),
        "PANEL": _rgba(colors["panel"], 0.94),
        "PANEL_BORDER": _rgba(colors["text"], 0.10),
        "TRACK": _rgba(colors["text"], 0.14),
        "UPCOMING": colors["upcoming"],
        "GRAIN": _GRAIN_SVG,
        "HEADING_FONT": heading_font,
        "BODY_FONT": body_font,
        "MONO_FONT": mono_font,
        "SCENE_TOP": str(SCENE_TOP),
        "SCENE_W": str(SCENE_W),
        "SCENE_H": str(SCENE_H),
        "CAPTION_TOP": str(CAPTION_TOP),
    })

    palette_js = {
        "background": colors["bg"], "primary": colors["primary"], "secondary": colors["secondary"],
        "accent": colors["accent"], "text": colors["text"], "upcoming": colors["upcoming"],
        "active": colors["active"], "track": _rgba(colors["text"], 0.14),
    }
    fonts_js = {"heading": heading_font, "body": body_font, "mono": mono_font}
    js = _fill(_SHELL_JS, {
        "TIMELINE": _js_json(timeline_compact),
        "BARS": _js_json(bars_data),
        "PALETTE": _js_json(palette_js),
        "FONTS": _js_json(fonts_js),
        "SECTIONS": _js_json(sections),
        "SLAMS": _js_json([{"id": s["id"], "t": s["t"], "out": s["out"]} for s in slams]),
        "ENERGY": _js_json(energy),
        "SCENE_W": str(SCENE_W),
        "SCENE_H": str(SCENE_H),
    })

    esc = html.escape
    n_bars = len(bars_data)
    bar_nums = ['<div class="bar-num" id="bar-num-0">INTRO</div>'] + [
        f'<div class="bar-num" id="bar-num-{i + 1}">BAR {i + 1:02d}/{n_bars:02d}</div>' for i in range(n_bars)
    ]
    hud_titles = [
        f'<div class="hud-title" id="hud-title-{i}">{esc(s["title"])}</div>' for i, s in enumerate(sections)
    ]
    segments = [f'<div class="section-seg" id="section-seg-{i}"></div>' for i in range(len(sections))]
    slam_divs = [
        f'<div class="slam-word" id="{s["id"]}" data-layout-allow-occlusion style="font-size:{s["font_px"]}px">'
        f'{esc(s["word"])}</div>'
        for s in slams
    ]
    pages: list[str] = []
    for i, bar in enumerate(bars_data):
        spans = []
        for j, w in enumerate(bar["words"]):
            cls = "word is-hit" if j == bar.get("hit_word_index") else "word"
            spans.append(f'<span class="{cls}" id="word-{i}-{j}">{esc(w["w"])}</span>')
        pages.append(f'<div class="page" id="page-{i}">{"".join(spans)}</div>')

    eyebrow = esc(truncate_words(title.upper(), 36))
    head = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>{esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="{esc(_google_fonts_href(treatment))}" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>{css}</style>
<style id="scene-style">
{scene.style}
</style>
</head>"""

    body = f"""
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{duration}" data-width="{WIDTH}" data-height="{HEIGHT}" data-resolution="portrait">
  <audio id="bgm" class="clip" src="assets/{esc(audio_filename)}" data-start="0" data-duration="{duration}" data-volume="1" data-track-index="0"></audio>
  <div id="visual-track" class="clip" data-start="0" data-duration="{duration}" data-track-index="1">
    <div id="bg"><div id="bg-grid"></div><div id="bg-energy"></div><div id="bg-beat"></div><div id="bg-vignette"></div><div id="bg-grain" data-layout-ignore></div></div>
    <div id="hud">
      <div id="hud-eyebrow"><div id="beat-dot"></div><span>{eyebrow}</span></div>
      <div id="hud-bar">{"".join(bar_nums)}</div>
      <div id="hud-titles">{"".join(hud_titles)}</div>
      <div id="hud-sections">{"".join(segments)}</div>
    </div>
    <div id="scene">
      <div id="scene-camera">
{scene.markup}
      </div>
    </div>
    <div id="fx-layer" data-layout-allow-occlusion>
      <div id="wipe" data-layout-allow-occlusion data-layout-allow-overflow></div>
      {"".join(slam_divs)}
    </div>
    <div id="captions">
      <div id="intro-card"><div class="intro-eyebrow">a rap explainer</div><div class="intro-title">{esc(title)}</div></div>
      {"".join(pages)}
    </div>
    <div id="progress"><div id="progress-fill"></div></div>
  </div>
</div>
<script>{js}</script>
<script>
(function () {{
{scene.script}
}})();
</script>
<script>{_REGISTER_JS}</script>
</body>
</html>
"""
    return head + body
