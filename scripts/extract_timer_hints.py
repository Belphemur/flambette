#!/usr/bin/env python3
"""
Timer-hint extractor for the cooking view's step timers (ADR-0041).

Walks the frozen local catalog (public/data/recipes/*.json, 2,730 docs) and
writes a SIDECAR NEXT TO each recipe — public/data/recipes/<variantId>.timer.json
shaped { "steps": [{ "step": <0-based instruction index>, "seconds": <lower
bound>, "label": "<Food>|Step N", "range": [<lo>, <hi>] }] } — for every step
whose authored text writes an explicit cook duration ("Simmer the rice for
12 minutes", "Bake 20-25 min"). Recipes with ZERO hints get NO file at all:
the app treats a missing sidecar as "no suggestions" (a 404 on the on-demand
fetch).

Data properties:
- Ranges keep BOTH bounds, in SECONDS, under "range"; "seconds" is the LOWER
  bound. The UI suggests the lower bound and discloses the range
  ("Bake 20 min (of 20-25)").
- The label is the food named IN THE SENTENCE that carries the duration
  (curated vocabulary, first whole-word hit), else the fallback "Step N"
  (1-based). Sentence-level on purpose: a wrong noun ("Eggs · 12 min" for a
  step about something else) is worse than the honest "Step 4".
- ADR-0022's no-fabrication rule: only authored durations are extracted.
  A value the timer engine cannot represent is DROPPED, never clamped:
  < 60 s (sub-minute, presets are minutes) or > 6 h (MAX_TIMER_SECONDS).
- One hint per step: the FIRST duration wins (an author writing two values
  means the first is the instruction's own timing).
- Scanned text: instruction primary_message sentences AND secondary_message
  lines (the measured-amount-bearing lines), so anything the cooking view
  can display is covered.
- A digit directly followed by a fraction glyph ("1 ½ hours") is refused
  rather than half-parsed — same rule as the runtime parser's old guard.
- A DESCENDING range ("18-10 minutes" — authored text can be a typo) is
  refused rather than repaired: emitting [1080, 600] would have the UI
  prefill 18 minutes and display an "18-10" disclosure. The match is
  skipped like any other invalid duration; the step keeps any later
  duration it may have.

Stdlib only; idempotent; no network. Re-run with:
    python3 scripts/extract_timer_hints.py
"""

import glob

from catalog_paths import recipe_doc_paths
import json
import os
import re
import sys

RECIPES_DIR = "public/data/recipes"

# Mirrors the authored-duration grammar. Units are minutes/hours/seconds;
# "s" alone is NOT a unit ("5 s" never appears authored and "30 s" would
# happily match the wrong "s" inside words with a boundary like "30 s").
DURATION_RE = re.compile(
    r"(?<![\d/.])\b(?:for )?\b(?P<low>\d+(?:\.\d+)?)\s*"
    r"(?:(?:–|‑|—|-| to )\s*(?P<high>\d+(?:\.\d+)?)\s*)?"
    r"(?P<unit>hours?|h|minutes?|mins?|min|seconds?|secs?)\b",
    re.IGNORECASE,
)

FRACTION_AFTER_RE = re.compile(r"[¼½¾⅓⅔⅛⅜⅝⅞]")

UNIT_SECONDS = {
    "h": 3600, "hour": 3600, "hours": 3600,
    "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "sec": 1, "secs": 1, "second": 1, "seconds": 1,
}

MAX_TIMER_SECONDS = 6 * 60 * 60  # keep in lockstep with src/lib/stepTimer.ts
MIN_TIMER_SECONDS = 60

# Curated cook-target vocabulary — ported from the runtime lib's old parser
# (superseded by this artifact) so labels stay human-meaningful.
COOK_TARGETS = [
    "rice", "pasta", "noodles", "dumplings", "polenta", "couscous", "quinoa", "oats",
    "chicken", "beef", "pork", "lamb", "salmon", "fish", "shrimp", "tofu", "tempeh",
    "bacon", "sausage", "ham",
    "eggs", "egg", "milk", "cream", "butter", "cheese", "yogurt", "yoghurt",
    "chocolate", "syrup", "jam",
    "beans", "lentils", "chickpeas", "peas", "nuts", "seeds", "cashews", "almonds",
    "walnuts",
    "onion", "onions", "garlic", "ginger", "potato", "potatoes", "carrot", "carrots",
    "broccoli",
    "cauliflower", "cabbage", "mushrooms", "mushroom", "zucchini", "eggplant",
    "aubergine", "pumpkin",
    "squash", "tomato", "tomatoes", "pepper", "peppers", "chilli", "chile", "lemon",
    "lime", "orange",
    "apple", "banana", "bread", "dough", "pastry", "sauce", "broth", "stock", "soup",
    "curry", "marinade",
]

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def food_in(sentence: str) -> str | None:
    """Whole-word lookup of a cook target, FIRST index wins."""
    lower = sentence.lower()
    best = None  # (index, word)
    for word in COOK_TARGETS:
        m = re.search(r"\b%s\b" % re.escape(word), lower)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), word)
    return best[1] if best else None


def title_case(word: str) -> str:
    return word.capitalize()


def seconds_for(value: float, unit: str) -> int:
    return int(round(value * UNIT_SECONDS[unit.lower()]))


def hint_from_text(text: str, step_number: int) -> dict | None:
    """First authored duration in `text`, else None.

    `step_number` is 1-based and only labels the "Step N" fallback.
    """
    for sentence in _SENTENCE_SPLIT_RE.split(text):
        m = DURATION_RE.search(sentence)
        if not m:
            continue
        # Refuse compound fractions: "1 ½ hours" is authored as a whole and
        # matching its leading "1" would fabricate a wrong value.
        tail = sentence[m.end(): m.end() + 1]
        if tail and FRACTION_AFTER_RE.match(tail):
            continue
        low = float(m.group("low"))
        high = m.group("high")
        lo_s = seconds_for(low, m.group("unit"))
        if lo_s < MIN_TIMER_SECONDS or lo_s > MAX_TIMER_SECONDS:
            continue  # the timer engine cannot honestly represent this value
        hi_s = seconds_for(float(high), m.group("unit")) if high else None
        if hi_s is not None and hi_s < lo_s:
            continue  # descending range = authored typo, never repair it
        food = food_in(sentence)
        label = title_case(food) if food else "Step %d" % step_number
        hint = {"step": step_number - 1, "seconds": lo_s, "label": label}
        if hi_s is not None:
            hint["range"] = [lo_s, hi_s]
        return hint
    return None


def extract_recipe(doc: dict) -> list[dict]:
    """Hints for ONE recipe doc, in instruction order."""
    hints: list[dict] = []
    for index, ins in enumerate(doc.get("instructions", [])):
        texts = [ins.get("primary_message") or ""]
        texts.extend((ins.get("secondary_message") or "").split("\n"))
        for text in texts:
            if not text.strip():
                continue
            hint = hint_from_text(text, index + 1)
            if hint:
                hints.append(hint)
                break
    return hints


def main() -> int:
    recipe_paths = recipe_doc_paths()
    recipe_paths = [p for p in recipe_paths if not p.endswith(".timer.json")]
    written = 0
    total_hints = 0
    for path in recipe_paths:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        hints = extract_recipe(doc)
        # Remove a stale sidecar first so a re-run converges to "no file"
        # when hints disappear.
        sidecar = path[:-5] + ".timer.json"
        if os.path.exists(sidecar):
            os.remove(sidecar)
        if not hints:
            continue
        with open(sidecar, "w", encoding="utf-8") as f:
            json.dump({"steps": hints}, f, ensure_ascii=False, separators=(",", ":"))
        written += 1
        total_hints += len(hints)

    print(f"recipes scanned : {len(recipe_paths)}")
    print(f"sidecars written: {written}")
    print(f"total hints     : {total_hints}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
