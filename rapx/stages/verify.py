"""Stage 3: verify — Plain Python with `pronouncing` (no LLM).

Checks syllables per bar (10-14), end rhymes, internal rhymes, and stress on beats 2 and 4.
Outputs a score and specific errors per bar -> verify.json.
"""

from __future__ import annotations

import re
from pathlib import Path
import pronouncing

from rapx.schemas import Bar, BarVerification, LyricsArtifact, VerifyArtifact

MIN_SYLLABLES = 10
MAX_SYLLABLES = 14

NUMBER_WORDS: dict[str, str] = {
    "0": "zero",
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
    "9": "nine",
    "10": "ten",
    "16": "sixteen",
    "32": "thirty two",
    "64": "sixty four",
    "100": "one hundred",
}

TECH_PRONUNCIATIONS: dict[str, tuple[int, str, str]] = {
    # word -> (syllables, stress_pattern, rhyming_part)
    "syn": (1, "1", "IH1 N"),
    "ack": (1, "1", "AE1 K"),
    "tcp": (3, "101", "IY1"),
    "udp": (3, "101", "IY1"),
    "cpu": (3, "101", "UW1"),
    "gpu": (3, "101", "UW1"),
    "dma": (3, "101", "EY1"),
    "lru": (3, "101", "UW1"),
    "mvcc": (4, "1010", "IY1"),
    "lsm": (3, "101", "EH1 M"),
    "sstable": (4, "1010", "EY1 B AH0 L"),
    "sstables": (4, "1010", "EY1 B AH0 L Z"),
    "memtable": (3, "110", "EY1 B AH0 L"),
    "memtables": (3, "110", "EY1 B AH0 L Z"),
    "downbeat": (2, "10", "IY1 T"),
    "downbeats": (2, "10", "IY1 T S"),
    "heartbeat": (2, "10", "IY1 T"),
    "heartbeats": (2, "10", "IY1 T S"),
    "hashring": (2, "10", "IH1 NG"),
    "keyspace": (2, "10", "EY1 S"),
    "sendfile": (2, "10", "AY1 L"),
}


def tokenize_bar(text: str) -> list[str]:
    cleaned = text.replace("/", " ").replace("-", " ").replace("—", " ")
    raw_tokens = re.findall(r"[A-Za-z0-9']+", cleaned.lower())
    tokens: list[str] = []
    for tok in raw_tokens:
        tok = tok.strip("'")
        if not tok:
            continue
        if tok in NUMBER_WORDS:
            tokens.extend(NUMBER_WORDS[tok].split())
        else:
            tokens.append(tok)
    return tokens


def estimate_syllables_fallback(word: str) -> int:
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    if len(w) <= 3:
        return 1
    w = re.sub(r"(?:la|es|ed|e)$", "", w)
    vowel_groups = re.findall(r"[aeiouy]+", w)
    return max(1, len(vowel_groups))


def word_phonetics(word: str) -> tuple[int, str, list[str], list[str]]:
    """Return (syllable_count, stress_pattern, rhyming_parts, vowel_nuclei) for a word."""
    w = word.lower().strip("'")
    if w in TECH_PRONUNCIATIONS:
        syl, stress, rpart = TECH_PRONUNCIATIONS[w]
        vowels = re.findall(r"[A-Z]{2}[012]", rpart)
        return syl, stress, [rpart], vowels

    phones_list = pronouncing.phones_for_word(w)
    if phones_list:
        primary = phones_list[0]
        syl = pronouncing.syllable_count(primary)
        stress = pronouncing.stresses(primary)
        rparts = list({pronouncing.rhyming_part(p) for p in phones_list if pronouncing.rhyming_part(p)})
        vowels = re.findall(r"[A-Z]{2}[12]", primary) or re.findall(r"[A-Z]{2}[012]", primary)
        return syl, stress, rparts, vowels

    syl = estimate_syllables_fallback(w)
    stress = ("10" * ((syl + 1) // 2))[:syl] or "1"
    suffix = w[-3:] if len(w) >= 3 else w
    return syl, stress, [f"SUFFIX:{suffix}"], [f"V:{suffix}"]


def words_rhyme(w1: str, w2: str) -> bool:
    """Check whether two words rhyme via CMUdict exact rhyme, rhyming_part, or rap slant vowel+coda match."""
    a = w1.lower().strip("'")
    b = w2.lower().strip("'")
    if not a or not b:
        return False
    if a == b:
        return True

    if b in pronouncing.rhymes(a) or a in pronouncing.rhymes(b):
        return True

    _, _, rparts_a, vowels_a = word_phonetics(a)
    _, _, rparts_b, vowels_b = word_phonetics(b)

    if set(rparts_a) & set(rparts_b):
        return True

    # Slant rhyme: matching final stressed vowel nucleus (strip stress digit 1/2)
    if vowels_a and vowels_b:
        va = re.sub(r"[012]$", "", vowels_a[-1])
        vb = re.sub(r"[012]$", "", vowels_b[-1])
        if va == vb and not va.startswith("V:"):
            return True

    # Fallback orthographic suffix match (last 3 letters)
    if len(a) >= 3 and len(b) >= 3 and a[-3:] == b[-3:]:
        return True

    return False


def count_bar_syllables(text: str) -> int:
    tokens = tokenize_bar(text)
    return sum(word_phonetics(t)[0] for t in tokens)


def count_internal_rhymes(tokens: list[str]) -> int:
    if len(tokens) < 3:
        return 0
    content_tokens = [t for t in tokens[:-1] if len(t) >= 3]
    matches = 0
    seen_pairs: set[tuple[int, int]] = set()
    for i in range(len(content_tokens)):
        for j in range(i + 1, len(content_tokens)):
            if content_tokens[i] == content_tokens[j]:
                continue
            if (i, j) not in seen_pairs and words_rhyme(content_tokens[i], content_tokens[j]):
                seen_pairs.add((i, j))
                matches += 1
    return matches


def check_stress_beats_2_and_4(tokens: list[str]) -> bool:
    """Verify stressed syllables ('1' or '2') land in both the beat-2 region and beat-4 region of a 4/4 bar."""
    stresses = "".join(word_phonetics(t)[1] for t in tokens)
    n = len(stresses)
    if n < 4:
        return False
    # Divide bar into 4 beat windows: [0..n/4), [n/4..n/2), [n/2..3n/4), [3n/4..n)
    b2_start = max(1, n // 4)
    b2_end = max(b2_start + 1, (n * 3) // 5)
    b4_start = max(b2_end, (n * 3) // 4 - 1)
    beat2_slice = stresses[b2_start:b2_end]
    beat4_slice = stresses[b4_start:]
    has_beat2_stress = ("1" in beat2_slice) or ("2" in beat2_slice)
    has_beat4_stress = ("1" in beat4_slice) or ("2" in beat4_slice)
    return has_beat2_stress and has_beat4_stress


def verify_lyrics(lyrics: LyricsArtifact) -> VerifyArtifact:
    # Group bars by rhyme_group
    groups: dict[str, list[Bar]] = {}
    for bar in lyrics.bars:
        groups.setdefault(bar.rhyme_group, []).append(bar)

    verifications: list[BarVerification] = []
    failing_indices: list[int] = []
    bar_scores: list[float] = []

    for bar in lyrics.bars:
        tokens = tokenize_bar(bar.text)
        syl_count = sum(word_phonetics(t)[0] for t in tokens)
        actual_end = tokens[-1] if tokens else bar.end_word.lower()

        errors: list[str] = []

        # 1. Syllable check (10-14)
        syl_ok = MIN_SYLLABLES <= syl_count <= MAX_SYLLABLES
        if not syl_ok:
            if syl_count < MIN_SYLLABLES:
                diff = MIN_SYLLABLES - syl_count
                errors.append(
                    f"Bar {bar.index} has {syl_count} syllables (target {MIN_SYLLABLES}-{MAX_SYLLABLES}); add at least {diff} syllable(s)."
                )
            else:
                diff = syl_count - MAX_SYLLABLES
                errors.append(
                    f"Bar {bar.index} has {syl_count} syllables (target {MIN_SYLLABLES}-{MAX_SYLLABLES}); remove at least {diff} syllable(s)."
                )

        # 2. End rhyme check within rhyme_group
        partners = [b for b in groups.get(bar.rhyme_group, []) if b.index != bar.index]
        end_rhyme_ok = False
        if not partners:
            errors.append(
                f"Bar {bar.index} has no rhyme partner in rhyme_group '{bar.rhyme_group}'."
            )
        else:
            for p in partners:
                p_tokens = tokenize_bar(p.text)
                p_end = p_tokens[-1] if p_tokens else p.end_word.lower()
                if words_rhyme(actual_end, p_end):
                    end_rhyme_ok = True
                    break
            if not end_rhyme_ok:
                partner = partners[0]
                p_tokens = tokenize_bar(partner.text)
                p_end = p_tokens[-1] if p_tokens else partner.end_word.lower()
                suggestions = [r for r in pronouncing.rhymes(p_end) if r.isalpha() and len(r) <= 8][:10]
                sug_text = f" Suggested CMUdict rhymes for '{p_end}': {suggestions}" if suggestions else ""
                errors.append(
                    f"Bar {bar.index} end word '{actual_end}' does not rhyme with Bar {partner.index} end word '{p_end}' in group '{bar.rhyme_group}'.{sug_text}"
                )

        # 3. Internal rhymes
        internal_count = count_internal_rhymes(tokens)

        # 4. Stress on beats 2 and 4
        stress_ok = check_stress_beats_2_and_4(tokens)
        if not stress_ok:
            errors.append(
                f"Bar {bar.index} lacks stressed syllables on beats 2 and 4; use stronger multi-syllable/content words in middle and end of bar."
            )

        # Score calculation (0-100)
        b_score = 0.0
        if syl_ok:
            b_score += 40.0
        elif MIN_SYLLABLES - 1 <= syl_count <= MAX_SYLLABLES + 1:
            b_score += 20.0
        if end_rhyme_ok:
            b_score += 35.0
        if stress_ok:
            b_score += 15.0
        b_score += min(10.0, internal_count * 5.0 + 5.0)
        bar_scores.append(b_score)

        if errors:
            failing_indices.append(bar.index)

        verifications.append(
            BarVerification(
                bar_index=bar.index,
                text=bar.text,
                syllable_count=syl_count,
                end_rhyme_ok=end_rhyme_ok,
                internal_rhyme_count=internal_count,
                stress_beats_ok=stress_ok,
                errors=errors,
            )
        )

    avg_score = round(sum(bar_scores) / max(1, len(bar_scores)), 1)
    return VerifyArtifact(
        passed=len(failing_indices) == 0,
        score=avg_score,
        bars=verifications,
        failing_bar_indices=failing_indices,
    )


def run_verify(run_dir: Path) -> VerifyArtifact:
    lyrics_path = run_dir / "lyrics.json"
    if not lyrics_path.exists():
        raise FileNotFoundError(f"Missing lyrics.json in {run_dir}")
    lyrics = LyricsArtifact.model_validate_json(lyrics_path.read_text(encoding="utf-8"))
    result = verify_lyrics(lyrics)
    out_path = run_dir / "verify.json"
    out_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
    return result
