"""Unit tests for `rapx.stages.verify` (syllable counting, rhyme detection, stress, and verification)
and `rapx.schemas` (Pydantic artifact validation).
"""

from __future__ import annotations

import unittest
from pydantic import ValidationError

from rapx.schemas import (
    Bar,
    CritiqueArtifact,
    CritiqueIssue,
    FactCheckArtifact,
    KeyPoint,
    LyricsArtifact,
    OutlineArtifact,
    TimelineArtifact,
    TreatmentArtifact,
    VerifyArtifact,
)
from rapx.stages.verify import (
    check_stress_beats_2_and_4,
    count_bar_syllables,
    tokenize_bar,
    verify_lyrics,
    words_rhyme,
)


class TestVerifyStage(unittest.TestCase):
    def test_syllable_counting_standard_and_tech_words(self) -> None:
        bar1 = "Ring of hashes spinning round the cluster state"
        self.assertEqual(count_bar_syllables(bar1), 11)

        bar2 = "Drop a single node and watch the neighbors take the load"
        self.assertEqual(count_bar_syllables(bar2), 13)

        # Tech words like memtable / sstable / syn / ack
        bar3 = "Send a SYN packet first then wait to get the ACK"
        self.assertTrue(10 <= count_bar_syllables(bar3) <= 14)

    def test_rhyme_detection(self) -> None:
        self.assertTrue(words_rhyme("state", "rate"))
        self.assertTrue(words_rhyme("node", "load"))
        self.assertTrue(words_rhyme("tight", "bright"))
        self.assertTrue(words_rhyme("cache", "crash"))
        self.assertFalse(words_rhyme("ring", "node"))
        self.assertFalse(words_rhyme("packet", "server"))

    def test_stress_beats_2_and_4(self) -> None:
        tokens = tokenize_bar("Ring of hashes spinning round the cluster state")
        self.assertTrue(check_stress_beats_2_and_4(tokens))

    def test_verify_lyrics_passing_and_failing_bars(self) -> None:
        bars = [
            Bar(
                index=1,
                text="Ring of hashes spinning round the cluster state",
                point_order=1,
                end_word="state",
                rhyme_group="A",
                key_terms_used=["ring", "hash"],
            ),
            Bar(
                index=2,
                text="Keys and servers mapping at a steady rate",
                point_order=1,
                end_word="rate",
                rhyme_group="A",
                key_terms_used=["key"],
            ),
            Bar(
                index=3,
                text="Drop a single node and watch the neighbors take the load",
                point_order=2,
                end_word="load",
                rhyme_group="B",
                key_terms_used=["node"],
            ),
            Bar(
                index=4,
                text="Only K divided by N keys ever hit the road",
                point_order=2,
                end_word="road",
                rhyme_group="B",
                key_terms_used=["key"],
            ),
            Bar(
                index=5,
                text="Virtual replicas keep the distribution tight",
                point_order=3,
                end_word="tight",
                rhyme_group="C",
                key_terms_used=["virtual"],
            ),
            Bar(
                index=6,
                text="Consistent hashing keeps the cache hits shining bright",
                point_order=3,
                end_word="bright",
                rhyme_group="C",
                key_terms_used=["hash"],
            ),
            Bar(
                index=7,
                text="Every server claims an arc along the circle space",
                point_order=3,
                end_word="space",
                rhyme_group="D",
                key_terms_used=[],
            ),
            Bar(
                index=8,
                text="Clockwise lookup finds the bucket in its proper place",
                point_order=3,
                end_word="place",
                rhyme_group="D",
                key_terms_used=[],
            ),
        ]
        lyrics = LyricsArtifact(concept="Consistent Hashing", bpm=92, bars=bars)
        res = verify_lyrics(lyrics)
        self.assertTrue(res.passed, f"Expected pass, got errors: {res.failing_bar_indices}")
        self.assertGreaterEqual(res.score, 90.0)

        # Introduce syllable and rhyme errors on bar 8
        bars[7] = Bar(
            index=8,
            text="Short non rhyming word",
            point_order=3,
            end_word="word",
            rhyme_group="D",
            key_terms_used=[],
        )
        bad_lyrics = LyricsArtifact(concept="Consistent Hashing", bpm=92, bars=bars)
        bad_res = verify_lyrics(bad_lyrics)
        self.assertFalse(bad_res.passed)
        self.assertIn(8, bad_res.failing_bar_indices)


class TestSchemas(unittest.TestCase):
    def test_outline_schema_validation(self) -> None:
        kp = [
            KeyPoint(
                order=i,
                title=f"Point {i}",
                core_idea="Core explanation",
                key_terms=["ring", "node"],
                analogy_or_visual_hook="Spinning wheel",
            )
            for i in range(1, 4)
        ]
        outline = OutlineArtifact(
            concept="Consistent Hashing",
            summary="Distributes keys evenly across a ring.",
            key_points=kp,
        )
        self.assertEqual(len(outline.key_points), 3)

        # Fewer than 3 key points must fail
        with self.assertRaises(ValidationError):
            OutlineArtifact(concept="Bad", summary="Too few points", key_points=kp[:2])

    def test_critique_grid_validation(self) -> None:
        issue = CritiqueIssue(
            category="sync_drift",
            timestamp_start_sec=1.2,
            timestamp_end_sec=2.4,
            grid_positions=["A1", "C4", "F6"],
            description="Caption lags behind word",
            concrete_fix="Shift #word-3 tween to 1.20s",
        )
        art = CritiqueArtifact(round=1, passed=False, overall_score=75.0, issues=[issue])
        self.assertEqual(art.issues[0].grid_positions[0], "A1")

        # Invalid grid cell G7 must fail
        with self.assertRaises(ValidationError):
            CritiqueIssue(
                category="overlap",
                timestamp_start_sec=0.0,
                timestamp_end_sec=1.0,
                grid_positions=["G7"],  # type: ignore[list-item]
                description="Out of grid",
                concrete_fix="Fix it",
            )


if __name__ == "__main__":
    unittest.main()
