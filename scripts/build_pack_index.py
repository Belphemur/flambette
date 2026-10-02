#!/usr/bin/env python3
"""
Pack-index builder for the meal-plan generator (Auto-Plan, ADR-0024).

Walks the frozen local catalog (public/data/recipes/*.json, 2,730 docs) and
produces public/data/pack_index.json — the per-recipe ingredient footprint the
planner scores against when it builds a waste-minimizing multi-meal pack.

Why this exists:
- The planner must answer "which recipes can share ingredients?" *without*
  fetching 2,730 recipe docs at runtime. The docs total ~15 MB; this index is
  ~70 KB gzipped, so the whole planner ships in the app's first payload.

Encoding:
- Recipe metadata (name, cooking_minutes, rating, sodium, calories, variety
  tags) is DELIBERATELY NOT duplicated here — it already ships in
  builder_data.json, which the catalog loader fetches anyway. This file holds
  ONLY the ingredient footprint the planner cannot derive from builder_data.
- Ingredient nameKeys and unit strings are interned into two string tables
  (338 and 53 distinct values) and referenced by integer. That takes the
  payload from 2.31 MB raw / 260 KB gzipped to ~540 KB raw / ~70 KB gzipped.
  Measured: brotli-11 saves a further ~8 KB, zstd-19 ~15 KB, but neither is
  worth an nginx image change for a file this small — stock gzip wins.
- Every quantity is classified as a CONTAINER (whole purchasable package,
  ceil-merged per ADR-0017) or a LINEAR measure (spoons, cloves, grams).
  The planner's waste score is built on that distinction: two recipes both
  needing "1 ½ (142 g) pkg" can share ONE package, but two recipes both
  needing "2 cloves garlic" cannot share anything — you buy 4 cloves either
  way. Without the container flag the score would treat a salt pinch and a
  cabbage identically.

Data properties:
- nameKey must stay in lockstep with src/lib/grocery.ts nameKey() so a
  planner-chosen pack merges into exactly the same grocery lines the user
  would have assembled by hand. Verify after touching either side by
  re-running this script and comparing counts.
- The container classification must stay in lockstep with
  src/lib/containers.ts (CONTAINER_NOUNS + CONTAINER_ADJECTIVES). If that
  list changes there, change it here, then re-run.
- "Unparseable" line items (empty quantity, e.g. "to taste" salt) are kept
  with amount 0 and unit "": the planner counts them as present-but-free, so
  they neither inflate nor deflate overlap.
- A recipe can list the same ingredient_name twice; the lines are merged with
  the ADR-0017 rule (containers ceil-merged, measures added) so the index
  stores ONE row per nameKey, matching how the grocery list would collapse.

Stdlib only; idempotent; no network. Re-run with:
    python3 scripts/build_pack_index.py
"""

import glob

from catalog_paths import recipe_doc_paths
import gzip
import json
import os
import re
import sys
from datetime import datetime

# ---------------------------------------------------------------------------
# TS-parity helpers (mirror src/lib/grocery.ts / src/lib/quantity.ts)
# ---------------------------------------------------------------------------

UNICODE_FRACTIONS = {
    "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
    "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
}

FRACTION_RE = re.compile(f"^[{''.join(UNICODE_FRACTIONS)}]+")
ASCII_FRACTION_RE = re.compile(r"^(\d+)/(\d+)")
NUM_RE = re.compile(r"^\d+(?:[.,]\d+)?")
ANNOTATION_RE = re.compile(r"^(\([^)]*\))\s*")


def parse_quantity(raw: str):
    """Mirror of parseQuantity() in src/lib/quantity.ts. -> (amount, unit)|None"""
    s = raw.strip()
    if not s:
        return None
    amount = 0.0
    matched = False
    m = NUM_RE.match(s)
    if m:
        amount = float(m.group(0).replace(",", "."))
        s = s[m.end():]
        matched = True
    s = s.lstrip()
    ascii_m = ASCII_FRACTION_RE.match(s)
    if ascii_m:
        amount += int(ascii_m.group(1)) / int(ascii_m.group(2))
        s = s[ascii_m.end():]
        matched = True
    else:
        uni = FRACTION_RE.match(s)
        if uni:
            for ch in uni.group(0):
                amount += UNICODE_FRACTIONS.get(ch, 0)
            s = s[uni.end():]
            matched = True
    if not matched:
        return None
    return amount, s.strip()


def name_key(name: str) -> str:
    """Mirror of nameKey() in src/lib/grocery.ts."""
    s = name.strip().lower()
    if len(s) > 3 and s.endswith("oes"):
        s = s[:-2]
    elif len(s) > 4 and s.endswith(("ses", "xes", "zes", "ches", "shes")):
        s = s[:-2]
    elif len(s) > 3 and s.endswith("s"):
        s = s[:-1]
    return s


def unit_key(unit: str) -> str:
    """Mirror of the private unitKey() in src/lib/grocery.ts."""
    u = unit.strip().lower()
    if len(u) > 3 and u.endswith("es"):
        u = u[:-2]
    elif len(u) > 2 and u.endswith("s"):
        u = u[:-1]
    return u


# ---------------------------------------------------------------------------
# containerKey port (src/lib/containers.ts) — ADR-0017
# ---------------------------------------------------------------------------

CONTAINER_ADJECTIVES = {
    "small", "medium", "large", "big", "jumbo", "mini", "extra-large",
}

CONTAINER_NOUNS = [
    "pkg", "package", "bunch", "head", "can", "block", "bag", "jar",
    "log", "loaf", "bottle", "box", "tin", "carton", "ear", "stick",
    "crown", "heart", "cap",
]

CONTAINER_NOUN_KEYS = {unit_key(n) for n in CONTAINER_NOUNS}


def parse_container(raw: str):
    """Mirror of parseContainerQuantity() in src/lib/containers.ts.

    -> dict(amount, container, annotation, key)|None. None means the quantity
    is NOT a purchasable container unit, so the planner must treat it as a
    linear measure (spoons, cloves, grams).
    """
    parsed = parse_quantity(raw)
    if parsed is None:
        return None
    amount, rest = parsed
    if not amount > 0:
        return None
    rest = rest.strip()
    if not rest:
        return None

    annotation = ""
    m = ANNOTATION_RE.match(rest)
    if m:
        annotation = m.group(1)
        rest = rest[m.end():].strip()

    tokens = [t for t in rest.split() if t]
    if not tokens:
        return None
    noun = tokens[-1]
    adjectives = tokens[:-1]
    if unit_key(noun) not in CONTAINER_NOUN_KEYS:
        return None
    if any(a.lower() not in CONTAINER_ADJECTIVES for a in adjectives):
        return None

    container = " ".join(tokens)
    return {
        "amount": amount,
        "container": container,
        "annotation": annotation,
        # containerKey(): two lines merge only when container AND annotation match
        "key": f"{unit_key(container)}|{annotation}",
    }


# ---------------------------------------------------------------------------
# planner scoring primitives (mirrored by src/lib/packPlanner.ts)
# ---------------------------------------------------------------------------

# Staples that are never "wasted" — a pantry always has them, so a pack that
# merely repeats them is not a waste win. Excluded from the overlap score.
PANTRY_STAPLES = {
    "salt", "black pepper", "white pepper", "extra virgin olive oil",
    "olive oil", "vegetable oil", "canola oil", "cooking spray", "sugar",
}


def main() -> int:
    # Only the catalog docs: this directory ALSO holds ADR-0041's per-recipe
    # `<id>.timer.json` sidecars, and a bare `*.json` glob silently folds those
    # into the index (they parse as empty recipes and double the row count).
    recipe_files = recipe_doc_paths()
    with open(os.path.join("public", "data", "builder_data.json")) as f:
        builder = json.load(f)

    expected = len(builder["feasible_variants"])
    if len(recipe_files) != expected:
        print(f"warning: expected {expected} recipe docs, found {len(recipe_files)}", file=sys.stderr)

    recipes = {}
    container_line_count = 0
    total_line_count = 0
    unparsed_qty = 0
    dup_name_merges = 0

    for path in recipe_files:
        vid = os.path.basename(path)[:-5]
        with open(path) as f:
            doc = json.load(f)

        # One row per nameKey, merged with the ADR-0017 rule so the index
        # matches what the grocery list would collapse.
        merged: dict = {}
        for li in doc.get("line_items") or []:
            key = name_key(li.get("ingredient_name") or "")
            if not key:
                continue
            raw_qty = li.get("quantity") or ""
            cont = parse_container(raw_qty)
            total_line_count += 1

            if cont is not None:
                container_line_count += 1
                amount = cont["amount"]
                is_container = True
                unit = cont["key"]
            else:
                parsed = parse_quantity(raw_qty)
                if parsed is None:
                    # "to taste" / empty: present but free
                    amount = 0.0
                    unparsed_qty += 1
                    unit = ""
                else:
                    amount = parsed[0]
                    unit = unit_key(parsed[1])
                is_container = False

            if key in merged:
                dup_name_merges += 1
                prev = merged[key]
                if prev["isContainer"] and is_container:
                    # ceil-merge within one recipe, same as the grocery list
                    merged[key]["amount"] = max(prev["amount"], amount)
                else:
                    merged[key]["amount"] = prev["amount"] + amount
                merged[key]["isContainer"] = prev["isContainer"] or is_container
            else:
                merged[key] = {
                    "amount": amount,
                    "unit": unit,
                    "isContainer": is_container,
                }

        # NOTE: no recipe metadata here on purpose — name/rating/minutes/tags
        # already ship in builder_data.json (see module docstring).
        recipes[vid] = {
            "items": [
                {
                    "k": k,
                    "a": round(r["amount"], 4),
                    "u": r["unit"],
                    "c": 1 if r["isContainer"] else 0,
                }
                for k, r in sorted(merged.items())
            ],
            "ingredientCount": len(merged),
            "scoredCount": sum(1 for k in merged if k not in PANTRY_STAPLES),
            "containerCount": sum(1 for r in merged.values() if r["isContainer"]),
        }

    # Intern the two string tables, then emit integer-indexed rows.
    key_ids: dict = {}
    unit_ids: dict = {}

    def kid(name: str) -> int:
        if name not in key_ids:
            key_ids[name] = len(key_ids)
        return key_ids[name]

    def uid(unit: str) -> int:
        if unit not in unit_ids:
            unit_ids[unit] = len(unit_ids)
        return unit_ids[unit]

    packed = {}
    total_ing = total_scored = total_container = 0
    for vid, r in recipes.items():
        rows = [[kid(it["k"]), it["a"], uid(it["u"]), it["c"]] for it in r["items"]]
        packed[vid] = {
            "i": rows,
            # scoredCount = rows that count toward overlap (non-pantry)
            "s": r["scoredCount"],
        }
        total_ing += r["ingredientCount"]
        total_scored += r["scoredCount"]
        total_container += r["containerCount"]

    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "count": len(packed),
        "pantryStaples": sorted(PANTRY_STAPLES),
        "ingredientKeys": list(key_ids),
        "unitKeys": list(unit_ids),
        "recipes": packed,
    }
    out_path = os.path.join("public", "data", "pack_index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    # ---- summary ----
    size = os.path.getsize(out_path)
    gz = len(gzip.compress(open(out_path, "rb").read(), 9))
    print(f"read {len(recipe_files)} recipe docs -> {len(packed)} recipes")
    print(f"wrote {out_path} ({size/1e6:.2f} MB raw, {gz/1e3:.0f} KB gzip)")
    print(f"line items: {total_line_count} total, {container_line_count} container, "
          f"{unparsed_qty} unparsed-qty, {dup_name_merges} duplicate-name merges")
    print(f"index rows: {total_ing} ingredients "
          f"({total_container} container, {total_scored} scored non-pantry)")
    print(f"avg scored ingredients per recipe: {total_scored/max(1,len(packed)):.1f}")
    print(f"interned {len(key_ids)} ingredient keys, {len(unit_ids)} unit keys")
    return 0


if __name__ == "__main__":
    sys.exit(main())
