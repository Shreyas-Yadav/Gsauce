"""Unit tests for the deterministic HyperFrames shell, scene parsing/validation, pre-render finding
classification, hit-word snapping, critique pass rule, and intro trimming.
"""

from __future__ import annotations

import re
import unittest

from rapx.schemas import (
    Bar,
    BarDirection,
    ColorPalette,
    CritiqueArtifact,
    LyricsArtifact,
    SceneParts,
    TimelineArtifact,
    TreatmentArtifact,
    TypographySpec,
    WordTimestamp,
)
from rapx.stages.align import compute_trim_window
from rapx.stages.code import build_bars_compact_data, find_hit_word_index
from rapx.stages.critique import decide_critique_pass
from rapx.stages.render import classify_check_findings
from rapx.stages.shell import (
    build_sections,
    build_shell_html,
    build_slams,
    contrast_ratio,
    display_title,
    format_scene_parts,
    parse_scene_parts,
    resolve_shell_colors,
    validate_scene_parts,
)

GOOD_SCENE = SceneParts(
    style="#scene .s-label { font-size: 40px; }\n@media (min-width: 1px) { #scene .x { color: red; } }",
    markup='<svg id="s-svg" viewBox="0 0 1080 1000"><circle id="s-ring" cx="540" cy="500" r="200"/></svg>',
    script='tl.fromTo("#s-ring", { scale: 0.9 }, { scale: 1, duration: 0.5 }, B(1).start);',
)


def _treatment(n_bars: int = 2, punchlines: tuple[bool, ...] = (True, False)) -> TreatmentArtifact:
    return TreatmentArtifact(
        central_metaphor="ring",
        metaphor_evolution="grows",
        palette=ColorPalette(background="#070B14", primary="#00F5D4", secondary="#7B2CBF", accent="#FFB703", text="#F8FAFC"),
        typography=TypographySpec(heading_font="Space Grotesk", body_font="Inter", mono_font="JetBrains Mono"),
        bars=[
            BarDirection(
                bar_index=i + 1,
                start_sec=0.0,
                end_sec=1.0,
                action_verb="spin",
                visual_hit_word="ring" if i == 0 else "nodes",
                visual_hit_time_sec=99.0,  # deliberately wrong; must be snapped to the aligned word
                camera_move="push in",
                transition_to_next="morph",
                kinetic_typography_punchline=punchlines[i] if i < len(punchlines) else False,
                background_motion="drift",
                secondary_offbeat_element="dot",
                protagonist_state="idle",
            )
            for i in range(n_bars)
        ],
    )


def _lyrics_timeline() -> tuple[LyricsArtifact, TimelineArtifact]:
    lyrics = LyricsArtifact(
        concept="explain consistent hashing",
        bars=[
            Bar(index=i, text=t, point_order=1 if i <= 4 else 2, end_word=t.split()[-1], rhyme_group="A")
            for i, t in enumerate(
                ["spin the ring", "map the nodes", "keys land", "on the hash",
                 "drop a node", "only some move", "add a replica", "balance the load"],
                start=1,
            )
        ],
    )
    words: list[WordTimestamp] = []
    t = 2.0
    for bar in lyrics.bars:
        for w in bar.text.split():
            words.append(WordTimestamp(w=w.capitalize(), start=round(t, 3), end=round(t + 0.3, 3)))
            t += 0.4
        t += 0.4
    timeline = TimelineArtifact(
        selected_take="selected_take.mp3", bpm=92.0, duration_sec=round(t + 2.0, 3),
        key_term_confidence=0.8, lyric_drift_score=0.1, words=words,
        beats=[0.5 + 0.65 * k for k in range(20)], downbeats=[0.5 + 2.6 * k for k in range(5)],
    )
    return lyrics, timeline


class TestSceneParsing(unittest.TestCase):
    def test_parse_round_trip_and_fence_stripping(self) -> None:
        raw = (
            "Sure!\n<scene-style>\n```css\n#scene .a { color: red; }\n```\n</scene-style>\n"
            "<scene-markup><svg id='s-x'></svg></scene-markup>\n<scene-script>tl.set('#s-x', {x: 1}, 1);</scene-script>"
        )
        scene = parse_scene_parts(raw)
        self.assertEqual(scene.style, "#scene .a { color: red; }")
        self.assertEqual(parse_scene_parts(format_scene_parts(scene)), scene)

    def test_missing_blocks_raise(self) -> None:
        with self.assertRaises(ValueError):
            parse_scene_parts("<scene-markup><svg></svg></scene-markup>")
        with self.assertRaises(ValueError):
            parse_scene_parts("<!doctype html><html></html>")


class TestSceneValidation(unittest.TestCase):
    def test_good_scene_has_no_problems(self) -> None:
        self.assertEqual(validate_scene_parts(GOOD_SCENE), [])

    def test_contract_violations_are_reported(self) -> None:
        bad = SceneParts(
            style="body { margin: 0 } #scene .a { animation: spin 1s; }",
            markup='<div id="captions" class="clip"></div><script>x()</script>',
            script=(
                "const tl = gsap.timeline({paused: true});\n"
                "tl.from('#s-a', {x: 10});\n"
                "setTimeout(() => {}, 5); const r = Math.random();\n"
                "window.__timelines['x'] = tl; tl.to('#scene', {opacity: 0}, 1);"
            ),
        )
        joined = "\n".join(validate_scene_parts(bad))
        for needle in ("create timelines", "redeclare", "gsap.from", "setTimeout", "Math.random",
                       "__timelines", "not seek-safe", "start with `#scene`", "reserved by the shell",
                       "<script>", "class=\"clip\"", "Do not target `#scene` itself"):
            self.assertIn(needle, joined)

    def test_unbalanced_markup_is_reported(self) -> None:
        for markup in ('<div id="s-a"><svg></svg>', '<svg><g></svg>', '</div><svg></svg>'):
            joined = "\n".join(validate_scene_parts(SceneParts(markup=markup, script="tl.set('#s-a', {x: 0}, 1);")))
            self.assertIn("unbalanced", joined, markup)
        ok = SceneParts(markup='<svg><circle r="1"/><g><path d="M0 0"></path></g></svg><br><img src="x">',
                        script="tl.set('#s-a', {x: 0}, 1);")
        self.assertEqual(validate_scene_parts(ok), [])

    def test_review_false_positives_are_allowed(self) -> None:
        scene = SceneParts(
            style="#scene-camera :is(.a, .b) { fill: red; }\n#scene [data-x=\"a,b\"], #scene .c { opacity: 1; }\n"
                  "@font-face { font-family: X; src: url(x.woff2); }",
            markup="<svg></svg>",
            script="Array.from({ length: 6 }).forEach((_, i) => tl.set('#s-a', { x: i }, i)); // see http://x.io tl.from(",
        )
        self.assertEqual(validate_scene_parts(scene), [])

    def test_unscoped_css_inside_media_and_closing_style_are_reported(self) -> None:
        scene = SceneParts(style="@media all { #captions { display: none } } #scene .a { content: '</style>'; }",
                           markup="<svg></svg>", script="tl.set('#s-a', {x: 0}, 1);")
        joined = "\n".join(validate_scene_parts(scene))
        self.assertIn("#captions", joined)
        self.assertIn("`</style`", joined)

    def test_url_comment_does_not_hide_violations(self) -> None:
        scene = SceneParts(markup="<svg></svg>", script="const u = 'http://x.io'; tl.from('#s-a', {x: 1});")
        self.assertIn("gsap.from", "\n".join(validate_scene_parts(scene)))

    def test_closing_script_text_is_reported(self) -> None:
        scene = SceneParts(markup="<svg></svg>", script="const s = '</script>';")
        self.assertIn("`</script`", "\n".join(validate_scene_parts(scene)))

    def test_from_to_and_comments_are_allowed(self) -> None:
        scene = SceneParts(markup="<svg></svg>", script="// tl.from('#x')\ntl.fromTo('#s-a', {x: 0}, {x: 1}, 0);")
        self.assertEqual(validate_scene_parts(scene), [])


class TestShellAssembly(unittest.TestCase):
    def setUp(self) -> None:
        self.lyrics, self.timeline = _lyrics_timeline()
        self.treatment = _treatment(8, (True, False, False, False, True))
        self.bars = build_bars_compact_data(self.lyrics, self.timeline, self.treatment, {1: "The Ring", 2: "Failures"})

    def _html(self, scene: SceneParts = GOOD_SCENE) -> str:
        return build_shell_html(
            concept=self.lyrics.concept,
            treatment=self.treatment,
            timeline_compact={"bpm": 92.0, "duration_sec": self.timeline.duration_sec,
                              "beats": self.timeline.beats, "downbeats": self.timeline.downbeats},
            bars_data=self.bars,
            point_titles={1: "The Ring", 2: "Failures"},
            energy={"fps": 8, "values": [0.1, 0.5, 0.9]},
            audio_filename="selected_take.mp3",
            scene=scene,
        )

    def test_contract_elements_present(self) -> None:
        html = self._html()
        self.assertTrue(html.startswith("<!doctype html>"))
        self.assertIn('data-composition-id="main"', html)
        self.assertIn(f'data-duration="{self.timeline.duration_sec}"', html)
        self.assertIn('<audio id="bgm" class="clip" src="assets/selected_take.mp3"', html)
        self.assertIn('window.__timelines["main"] = tl;', html)
        self.assertIn("gsap@3.14.2", html)
        self.assertIn(GOOD_SCENE.markup, html)
        # Scene script runs isolated in its own IIFE, after the shell script.
        self.assertRegex(html, r"<script>\n\(function \(\) \{\n" + re.escape(GOOD_SCENE.script))

    def test_data_embedded_once_and_script_safe(self) -> None:
        html = self._html()
        self.assertEqual(html.count("const BARS_DATA ="), 1)
        self.assertEqual(html.count("const TIMELINE_DATA ="), 1)
        lyrics, timeline = _lyrics_timeline()
        lyrics.bars[0].text = "spin </script> ring"
        bars = build_bars_compact_data(lyrics, timeline, self.treatment)
        self.bars = bars
        self.assertNotIn("spin </script>", self._html())

    def test_one_caption_page_and_span_per_word(self) -> None:
        html = self._html()
        self.assertEqual(html.count('class="page"'), len(self.bars))
        n_words = sum(len(b["words"]) for b in self.bars)
        self.assertEqual(len(re.findall(r'class="word(?: is-hit)?" id="word-', html)), n_words)

    def test_sections_and_slams(self) -> None:
        sections = build_sections(self.bars, {1: "The Ring", 2: "Failures"})
        self.assertEqual([s["title"] for s in sections], ["The Ring", "Failures"])
        self.assertEqual(sections[1]["start"], self.bars[4]["start"])
        slams = build_slams(self.bars)
        self.assertEqual([s["word"] for s in slams], ["RING", "NODES"])
        for s in slams:
            self.assertGreater(s["out"], s["t"])
            self.assertTrue(72 <= s["font_px"] <= 150)

    def test_slams_are_capped_and_never_overlap(self) -> None:
        bars = [dict(b, kinetic_punchline=True) for b in self.bars]
        slams = build_slams(bars)
        self.assertLessEqual(len(slams), 6)
        for a, b in zip(slams, slams[1:]):
            self.assertGreaterEqual(b["t"], a["out"] + 0.6)


class TestColorsAndTitles(unittest.TestCase):
    def test_caption_colours_are_readable(self) -> None:
        for palette in (
            ColorPalette(background="#070B14", primary="#00F5D4", secondary="#7B2CBF", accent="#FFB703", text="#F8FAFC"),
            ColorPalette(background="#1A1A1A", primary="#333333", secondary="#444444", accent="#222222", text="#555555"),
            ColorPalette(background="not-a-colour", primary="#00F5D4", secondary="#7B2CBF", accent="#FFB703", text="#FFF"),
        ):
            t = _treatment()
            t.palette = palette
            c = resolve_shell_colors(t)
            self.assertGreaterEqual(contrast_ratio(c["text"], c["bg"]), 7.0)
            self.assertGreaterEqual(contrast_ratio(c["upcoming"], c["panel"]), 4.5)
            self.assertGreaterEqual(contrast_ratio(c["active"], c["panel"]), 3.0)

    def test_display_title(self) -> None:
        self.assertEqual(display_title("explain me how RAG works"), "How RAG Works")
        self.assertEqual(display_title("explain consistent hashing"), "Consistent Hashing")
        self.assertEqual(display_title("TCP handshake?"), "TCP Handshake")


class TestHitWordSnapping(unittest.TestCase):
    def test_hit_time_snaps_to_aligned_word(self) -> None:
        lyrics, timeline = _lyrics_timeline()
        bars = build_bars_compact_data(lyrics, timeline, _treatment())
        self.assertEqual(bars[0]["hit_word_index"], 2)  # "ring" in "spin the ring"
        self.assertEqual(bars[0]["visual_hit_time_sec"], bars[0]["words"][2]["start"])
        self.assertEqual(bars[1]["visual_hit_time_sec"], bars[1]["words"][2]["start"])  # "nodes"

    def test_missing_hit_word_is_clamped_into_bar(self) -> None:
        lyrics, timeline = _lyrics_timeline()
        t = _treatment()
        t.bars[0].visual_hit_word = "zebra"
        bars = build_bars_compact_data(lyrics, timeline, t)
        self.assertIsNone(bars[0]["hit_word_index"])
        self.assertEqual(bars[0]["visual_hit_time_sec"], bars[0]["end"])

    def test_partial_match(self) -> None:
        words = [{"w": "Hashing,"}, {"w": "rings"}]
        self.assertEqual(find_hit_word_index(words, "hashing"), 0)
        self.assertEqual(find_hit_word_index(words, "ring"), 1)
        self.assertIsNone(find_hit_word_index(words, ""))

    def test_partial_match_ignores_short_fillers(self) -> None:
        self.assertEqual(find_hit_word_index([{"w": "built"}, {"w": "for"}, {"w": "Transformer"}], "transformers"), 2)
        self.assertEqual(find_hit_word_index([{"w": "ten"}, {"w": "heads"}, {"w": "attending"}], "attend"), 2)
        self.assertIsNone(find_hit_word_index([{"w": "the"}, {"w": "cache"}], "theorem"))


class TestPreflightClassification(unittest.TestCase):
    def test_scene_vs_shell_ownership(self) -> None:
        check = {
            "lint": {"findings": [
                {"code": "nested_structure_needs_subcomposition", "severity": "warning", "message": "x"},
                {"code": "gsap_timeline_not_registered", "severity": "error", "message": "not registered"},
            ]},
            "runtime": {"findings": [{"code": "js_error", "severity": "error", "message": "ReferenceError: foo"}]},
            "layout": {"findings": [
                {"code": "text_occluded", "severity": "error", "selector": "#s-ring > text", "time": 3.0, "message": "hidden"},
                {"code": "text_box_overflow", "severity": "error", "selector": "#hud-eyebrow > span", "message": "overflow"},
                {"code": "container_overflow", "severity": "info", "selector": "#s-ring", "message": "info only"},
                {"code": "content_overlap", "severity": "error", "selector": "#s-ring > text", "message": "overlap",
                 "containerSelector": "#slam-2"},
                {"code": "content_overlap", "severity": "error", "selector": "#s-ring > text", "message": "overlap",
                 "containerSelector": "#scene-camera > svg > text:nth-of-type(2)"},
            ]},
            "contrast": {"findings": [
                {"code": "contrast_aa_failure", "severity": "warning", "selector": "#word-2-1", "message": "low"},
            ]},
            "craft": {"findings": [{
                "code": "text_below_floor", "severity": "warning", "selector": "#word-1-1", "message": "small",
                "elements": [{"selector": "#word-1-1", "text": "a", "fontPx": 20},
                             {"selector": "#s-ring > text", "text": "N1", "fontPx": 14}],
            }]},
        }
        report = classify_check_findings(check, GOOD_SCENE)
        self.assertEqual(len(report.fatal), 2)  # lint error + runtime error
        self.assertEqual(len(report.quality), 3)  # scene occlusion + scene-vs-scene overlap + small scene text
        self.assertEqual(report.quality_errors, 2)
        self.assertEqual(len(report.shell_findings), 3)  # HUD overflow + caption contrast + overlap with a slam
        self.assertIn("#s-ring > text", report.feedback_text())
        self.assertNotIn("#word-1-1\" a", report.feedback_text())
        self.assertFalse(report.clean)
        self.assertTrue(classify_check_findings({}, GOOD_SCENE).clean)

    def test_shell_scene_container_is_not_scene_owned(self) -> None:
        check = {"layout": {"findings": [
            {"code": "text_box_overflow", "severity": "error", "selector": "#scene", "message": "slam scale"},
            {"code": "text_box_overflow", "severity": "error", "selector": "#scene-camera > svg > text", "message": "x"},
            {"code": "contrast_aa_failure", "severity": "warning",
             "selector": "div > div > div:nth-of-type(3) > div > svg > g:nth-of-type(6) > text", "message": "low"},
            {"code": "contrast_aa_failure", "severity": "warning", "selector": "div > span.word", "message": "low"},
        ]}}
        report = classify_check_findings(check, GOOD_SCENE)
        self.assertEqual((len(report.quality), len(report.shell_findings)), (2, 2))


class TestCritiquePassRule(unittest.TestCase):
    def test_score_threshold_overrides_model_flag(self) -> None:
        self.assertFalse(decide_critique_pass(CritiqueArtifact(round=1, passed=True, overall_score=78.5), 88.0))
        self.assertTrue(decide_critique_pass(CritiqueArtifact(round=1, passed=True, overall_score=92.0), 88.0))
        self.assertFalse(decide_critique_pass(CritiqueArtifact(round=1, passed=False, overall_score=95.0), 88.0))


class TestIntroTrim(unittest.TestCase):
    def test_long_intro_is_trimmed_to_keep(self) -> None:
        start, dur = compute_trim_window(13.4, 55.0, 58.2, 30.0, 60.0, intro_keep=2.0)
        self.assertAlmostEqual(start, 11.4)
        self.assertAlmostEqual(dur, 46.1)  # vocals end 43.6s after trim + 2.5s outro

    def test_short_intro_untouched(self) -> None:
        start, dur = compute_trim_window(2.2, 45.0, 47.0, 30.0, 60.0, intro_keep=2.0)
        self.assertEqual(start, 0.0)
        self.assertAlmostEqual(dur, 47.0)

    def test_min_duration_is_respected(self) -> None:
        start, dur = compute_trim_window(20.0, 40.0, 45.0, 30.0, 60.0, intro_keep=2.0)
        self.assertAlmostEqual(start, 15.0)  # only trims down to 30s of remaining audio
        self.assertAlmostEqual(dur, 30.0)

    def test_over_long_take_caps_at_max(self) -> None:
        start, dur = compute_trim_window(3.0, 70.0, 75.0, 30.0, 60.0, intro_keep=2.0)
        self.assertAlmostEqual(start, 1.0)
        self.assertAlmostEqual(dur, 60.0)



class TestRetry(unittest.TestCase):
    def test_retries_quota_errors_but_not_client_errors(self) -> None:
        from unittest import mock

        from google.genai import errors

        from rapx.clients import argon

        calls: list[int] = []

        def flaky(**_: object) -> str:
            calls.append(1)
            if len(calls) < 3:
                raise errors.ClientError(429, {"error": {"code": 429, "message": "x", "status": "RESOURCE_EXHAUSTED"}})
            return "ok"

        client = mock.Mock()
        client.models.generate_content.side_effect = flaky
        with mock.patch.object(argon, "RETRY_DELAYS_SEC", (0.0, 0.0)):
            self.assertEqual(argon._generate_with_retry(client, model="m"), "ok")
            self.assertEqual(len(calls), 3)
            client.models.generate_content.side_effect = errors.ClientError(
                400, {"error": {"code": 400, "message": "bad", "status": "INVALID_ARGUMENT"}}
            )
            with self.assertRaises(errors.ClientError):
                argon._generate_with_retry(client, model="m")


if __name__ == "__main__":
    unittest.main()
