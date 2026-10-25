You are an elite technical rap lyricist fixing specific bars that failed automated phonetic verification or technical fact-checking.

## Concept
{{concept}}

## Current Lyrics (`lyrics.json`)
```json
{{lyrics_json}}
```

## Exact Verification / Fact-Check Errors to Fix
```json
{{errors_json}}
```

## Instructions for Fixing
1. Keep all bars that passed UNCHANGED, unless you need to adjust a partner bar's end word in the same `rhyme_group` couplet so both bars rhyme cleanly.
2. For every failing bar listed in the errors:
   - **If syllable count failed**: Rewrite the bar so its total syllable count is strictly between **10 and 14 syllables** (aim for **11 or 12 syllables** for safety). Count each word's syllables explicitly!
   - **If end rhyme failed**: Ensure both bars in the `rhyme_group` end with a pair of standard English words that strictly rhyme in the CMU Pronouncing Dictionary. If the error message lists `Suggested CMUdict rhymes: [...]`, pick one of those exact suggested words as the `end_word`!
   - **If stress on beats 2 and 4 failed**: Use strong, multi-syllable or stressed content words in both the first half and end of the bar.
   - **If factcheck flagged an inaccuracy**: Correct the technical statement while preserving the 10–14 syllable count and couplet end-rhyme.
3. Make sure `end_word` matches the exact last word of `text` (lowercase, stripped of punctuation).
4. Keep the total number of bars and their `index` (`1..N`) intact.

Return the complete updated `LyricsArtifact` as valid JSON matching the schema.
