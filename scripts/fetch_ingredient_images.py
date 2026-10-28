#!/usr/bin/env python3
"""
Ingredient image fetcher + derivation for the grocery ingredient detail view
(issue #101).

The frozen Mealime catalog carries NO ingredient imagery — the negative census
is recorded in the ADR this script ships with (only 17 image URLs survive in
the bundled user_data.json snapshot, keyed by UUID, with no name→URL mapping).
The Mealime API is dead (503 post-shutdown), so the corpus is built from an
external open source instead:

    TheMealDB (themealdb.com) — 992 ingredient names, 700x700 transparent
    PNGs keyed by plain lowercase name. Free at point of access (supporter
    key only required for app-store releases — Flambette is a web app).
    Attribution is recorded below and in the ADR.

Pipeline (fetch and derivation are SEPARATE phases so a re-derivation never
needs the network):

  1. FETCH  — archive each matched ingredient PNG to RAW_DIR (outside the
     repo, sibling of the recipe raw_images archive), resumable, browser UA
     (the CDN 403s plain urllib).
  2. DERIVE — webp derivatives (400px, q72) into public/img/ingredients/ and
     the committed FUSED artifact public/data/ingredient_detail.json: ONE
     nameKey-keyed map the ingredient detail sheet lazy-imports, carrying
     BOTH the local image path AND the curated substitutes row (from
     scripts/ingredient_substitutions.json, owner-approved). Images are
     served by the app as optimized webp, NEVER from the outside — the
     artifact stores local paths only, zero remote URLs.

Matching is a layered candidate matcher over the closed 992-name set
(normalize → qualifier strip → head noun → variant-based singular/plural,
since the set is the authority) plus a hand-verified ALIASES table for
vocabulary pairs the matcher cannot bridge (corn→sweetcorn, ketchup→tomato
ketchup, eggplants→aubergine — TheMealDB is British-leaning). Every alias
target is asserted to exist in the fetched list, so a vocabulary drift fails
loudly instead of silently dropping rows.

Ingredients with no match (sauces, dressings, branded items — ~12% of the
recipe taxonomy) are listed in the artifact's `unmatched` array and render as
the aisle glyph + hue (ADR-0076 aisleIcon) in the UI.

Usage:
    python3 scripts/fetch_ingredient_images.py           # fetch + derive
    python3 scripts/fetch_ingredient_images.py --offline # derive from raws only
    python3 scripts/fetch_ingredient_images.py --check   # committed artifact freshness
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from PIL import Image

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = "/home/balor/workspace/mealime-media/raw_ingredient_images"
OUT_DIR = os.path.join(BASE, "public", "img", "ingredients")
ARTIFACT = os.path.join(BASE, "public", "data", "ingredient_detail.json")
SUBS_TABLE = os.path.join(BASE, "scripts", "ingredient_substitutions.json")
INDEX = os.path.join(BASE, "public", "data", "ingredients.json")

LIST_URL = "https://www.themealdb.com/api/json/v1/1/list.php?i=list"
IMG_URL = "https://www.themealdb.com/images/ingredients/{name}.png"

HDRS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) "
        "Gecko/20100101 Firefox/155.0"
    ),
    "Accept-Encoding": "gzip",
}

SOURCE = "TheMealDB (themealdb.com)"
LICENSE_NOTE = (
    "Free at point of access per themealdb.com/api.php; supporter key only "
    "required for app-store releases. Attribution recorded in the ADR."
)

# Owner-curated exclusions (2026-10-28): nameKeys whose matcher match is
# WRONG rather than adjacent — forced to the glyph fallback. Rationale kept
# beside each so a future matcher change cannot silently resurrect them.
EXCLUDES = {
    "butter bean": "matched 'butter' — it is a bean",
    "cream of tartar": "matched 'cream' — it is an acid powder",
    "ginger ale": "matched 'ginger' — it is a soda",
    "sugar snap pea": "matched 'sugar' — the food noun is the pea",
    "vanilla whey-based protein powder (containing 20 grams protein/serving)": "matched 'vanilla' — a protein powder, not the flavoring",
    "cheese ravioli, fresh or frozen": "matched 'cheese' — a cheese block misleads for stuffed pasta",
    "cheese tortellini, fresh or frozen": "matched 'cheese' — a cheese block misleads for stuffed pasta",
}

# Hand-verified vocabulary pairs (owner-reviewed census, 2026-10): each target
# was confirmed present in the fetched mealdb list. The script asserts this.
ALIASES = {
    "baby arugula": "rocket",
    "baby bok choy": "bok choi",
    "baking soda": "bicarbonate of soda",
    "corn": "sweetcorn",
    "frozen corn": "sweetcorn",
    "eggplants": "aubergine",
    "ketchup": "tomato ketchup",
    "pecan halves": "pecan nuts",
    "graham crackers": "graham cracker crumbs",
    "tamari soy sauce": "soy sauce",
    "edamame": "soya bean",
    "alfalfa sprouts": "bean sprouts",
    "romaine hearts": "lettuce",
}

# Tokens that are preparation qualifiers or connectives, never the food noun.
STOP_TOKENS = {
    "shredded", "chopped", "sliced", "diced", "minced", "pitted", "packed",
    "unsweetened", "fresh", "frozen", "raw", "large", "small", "whole",
    "baby", "english", "italian", "thai", "peeled", "marinated", "dried",
    "ground", "roasted", "boneless", "skinless", "split", "tips", "removed",
    "in", "oil", "or", "and", "with", "of", "pure", "style",
}

SINGULAR_MAP = {
    "tomatoes": "tomato",
    "potatoes": "potato",
    "leaves": "leaf",
    "berries": "berry",
    "buns": "bun",
}


def norm(s: str) -> str:
    return re.sub(r"[^a-z ]", " ", s.lower()).strip()


def variants(w: str) -> set[str]:
    """Plural/singular candidate forms of one token."""
    out = {w, w[:-1], w[:-2], w[:-3] + "y", w + "s", w + "es"}
    return {x for x in out if x}


def candidates(name: str) -> list[str]:
    """Layered lookup candidates for one ingredient name, best first."""
    n = re.sub(r"[^a-z0-9 /&-]", " ", name.lower()).strip()
    out: list[str] = []

    def add(c: str) -> None:
        c = re.sub(r"\s+", " ", c).strip()
        if c and c not in out:
            out.append(c)

    if "," in n:
        add(n.split(",")[0])
    if "/" in n:
        add(n.split("/")[0])
    toks = [t for t in n.replace(",", " ").split() if t not in STOP_TOKENS]
    if toks:
        add(" ".join(toks))
        for t in reversed(toks):
            add(t)
        for t in reversed(toks):
            for v in variants(t):
                add(v)
        if len(toks) > 1:
            add(" ".join(toks[:2]))
            for v in variants(toks[1]):
                add(toks[0] + " " + v)
        # Head noun LAST: in "butter lettuce" the food noun is lettuce, not
        # butter — modifiers precede the noun in shopping vocabulary. The
        # first-token form is the LAST resort (e.g. "apple juice" -> apples:
        # adjacent, never wrong-token-wins).
    add(n)
    for v in variants(n):
        add(v)
    for t in toks or [n]:
        if t in SINGULAR_MAP:
            add(SINGULAR_MAP[t])
            add(SINGULAR_MAP[t] + "s")
    return out


def match(name: str, mealdb: set[str]) -> tuple[str, str] | None:
    """Return (mealdb_name, level) or None. Level records HOW the match was
    made — 'first' rows are adjacent-not-exact and land in the artifact's
    review list for curation."""
    if name in EXCLUDES:
        return None
    if name in ALIASES:
        return ALIASES[name], "alias"
    cands = candidates(name)
    # 'first-token' candidates are those after the reversed-token block in
    # candidates(); identify them positionally: anything matching one of the
    # name's non-head tokens alone.
    toks = [t for t in re.sub(r"[^a-z0-9 /&-]", " ", name.lower()).split()
            if t not in STOP_TOKENS]
    for i, c in enumerate(cands):
        if c in mealdb:
            bare = {t for t in toks}
            level = "exact" if i == 0 else (
                "first" if c in bare and len(toks) > 1 and c == toks[0] and toks[-1] not in mealdb
                else "variant")
            return c, level
    return None


def fetch(url: str, dest: str) -> bool:
    """Download url to dest (raw archive), resumable. True on success."""
    if os.path.exists(dest) and os.path.getsize(dest) > 500:
        return True
    req = urllib.request.Request(url, headers=HDRS)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    import gzip

                    raw = gzip.decompress(raw)
            tmp = dest + ".tmp"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, dest)
            return True
        except Exception:
            if attempt == 2:
                return False
            time.sleep(1.0)
    return False


def derive_webp(raw_path: str, out_path: str) -> bool:
    """400px webp derivative from the archived raw PNG."""
    if os.path.exists(out_path) and os.path.getsize(out_path) > 500:
        return True
    try:
        img = Image.open(raw_path)
        img.thumbnail((400, 400), Image.Resampling.LANCZOS)
        img.save(out_path, "WEBP", quality=72, method=6)
        return True
    except Exception as e:
        print(f"  ! derive failed {raw_path}: {e}", file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="derive from raws only")
    ap.add_argument(
        "--check",
        action="store_true",
        help="verify the committed artifact matches a fresh derivation",
    )
    args = ap.parse_args()

    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    with open(INDEX) as f:
        index = json.load(f)
    name_keys = sorted({row["nameKey"] for row in index["ingredients"]})

    list_cache = os.path.join(RAW_DIR, "mealdb_ingredients.json")
    if args.offline:
        if not os.path.exists(list_cache):
            print("offline mode needs the cached mealdb list", file=sys.stderr)
            return 1
    else:
        if not fetch(LIST_URL, list_cache):
            print("failed to fetch the mealdb ingredient list", file=sys.stderr)
            return 1
    with open(list_cache) as f:
        mealdb_names = sorted(
            {m["strIngredient"].lower().strip() for m in json.load(f)["meals"]}
        )
    mealdb = {norm(n) for n in mealdb_names}

    # Alias targets must exist in the fetched vocabulary — fail loudly on drift.
    missing_targets = [v for v in ALIASES.values() if norm(v) not in mealdb]
    if missing_targets:
        print(
            "ALIAS targets absent from the mealdb list: " + ", ".join(missing_targets),
            file=sys.stderr,
        )
        return 1

    matched: dict[str, tuple[str, str]] = {}
    unmatched: list[str] = []
    for nk in name_keys:
        m = match(nk, mealdb)
        if m:
            matched[nk] = m
        else:
            unmatched.append(nk)

    sources = sorted({m[0] for m in matched.values()})
    review = sorted(nk for nk, (_, lvl) in matched.items() if lvl == "first")
    print(f"index nameKeys: {len(name_keys)}")
    print(f"matched to a mealdb image: {len(matched)} ({len(matched)/len(name_keys):.1%})")
    print(f"unmatched (glyph fallback): {len(unmatched)}")
    print(f"distinct mealdb images needed: {len(sources)}")
    print(f"review (first-token fallback, curate): {len(review)}")

    if not args.check:
        failed: list[str] = []
        # Phase 1: fetch raw PNGs (network) — skip entirely in offline mode.
        if not args.offline:
            jobs = [
                (s, IMG_URL.format(name=urllib.parse.quote(s)))
                for s in sources
            ]
            with ThreadPoolExecutor(max_workers=16) as ex:

                def one(job):
                    name, url = job
                    ok = fetch(url, os.path.join(RAW_DIR, f"{name}.png"))
                    if not ok:
                        failed.append(name)

                list(ex.map(one, jobs))
            if failed:
                print(
                    f"{len(failed)} raw fetches failed: {', '.join(failed[:10])}...",
                    file=sys.stderr,
                )

        # Phase 2: derive webp + write the artifact (offline from raws).
        # A source whose raw never landed (listed but 404s on the CDN) moves
        # its nameKeys to `unmatched` so every nameKey lands in EXACTLY one
        # bucket — images + unmatched must always total the index.
        derived: dict[str, str] = {}
        for s in sources:
            raw_path = os.path.join(RAW_DIR, f"{s}.png")
            out_path = os.path.join(OUT_DIR, f"{s}.webp")
            if derive_webp(raw_path, out_path):
                derived[s] = out_path
            else:
                failed.append(s)
        no_image = {s for s in sources if s not in derived}
        if no_image:
            unmatched.extend(nk for nk, (m, _) in matched.items() if m in no_image)
            unmatched.sort()
            matched = {nk: m for nk, m in matched.items() if m[0] not in no_image}

        ok_sources = {s for s in sources if s in derived}
        images = {
            nk: f"img/ingredients/{mealdb_name}.webp"
            for nk, (mealdb_name, _) in sorted(matched.items())
            if mealdb_name in ok_sources
        }
        # OUT_DIR is generated — drop webp files the fresh artifact no longer
        # references (e.g. a source whose nameKeys moved to unmatched).
        for stale in sorted(set(os.listdir(OUT_DIR)) - {p.split("/")[-1] for p in images.values()}):
            os.remove(os.path.join(OUT_DIR, stale))
        review = sorted(nk for nk in images if nk in review)

        # FUSE with the curated substitutions table (owner-approved input):
        # ONE nameKey-keyed detail artifact — `image` when an image exists,
        # `substitutes` when the table has a row. Served by the app as
        # optimized webp; the artifact never carries a remote URL.
        with open(SUBS_TABLE) as f:
            subs_table = json.load(f)["substitutions"]
        entries: dict[str, dict] = {}
        for nk in name_keys:
            e: dict = {}
            if nk in images:
                e["image"] = images[nk]
            if nk in subs_table:
                e["substitutes"] = subs_table[nk]["subs"]
            if e:
                entries[nk] = e
        with_images = sum(1 for e in entries.values() if "image" in e)
        with_subs = sum(1 for e in entries.values() if "substitutes" in e)
        artifact = {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": SOURCE,
            "license": LICENSE_NOTE,
            "count": len(entries),
            "withImages": with_images,
            "withSubstitutes": with_subs,
            "entries": entries,
            "unmatched": unmatched,
            "review": review,
        }
        with open(ARTIFACT, "w") as f:
            json.dump(artifact, f, indent=1, sort_keys=True)
            f.write("\n")
        print(f"artifact: {ARTIFACT} ({len(entries)} entries: {with_images} images, {with_subs} substitutes)")
        return 0

    # --check: committed artifact must match a fresh derivation (content only;
    # generatedAt is a fresh timestamp by design).
    with open(ARTIFACT) as f:
        committed = json.load(f)
    with open(SUBS_TABLE) as f:
        subs_table = json.load(f)["substitutions"]
    # Mirror the derive path's no-image handling EXACTLY: a matched source
    # whose raw PNG never landed (listed but 404s on the CDN) carries no
    # image here either — else --check drifts against every fresh derive.
    no_image_sources = {
        m[0] for m in matched.values()
        if not os.path.exists(os.path.join(RAW_DIR, f"{m[0]}.png"))
    }
    fresh_matched = {
        nk: m for nk, m in matched.items() if m[0] not in no_image_sources
    }
    # The derive path folds no-image nameKeys into `unmatched` — mirror it.
    fresh_unmatched = sorted(
        set(unmatched) | {nk for nk, m in matched.items() if m[0] in no_image_sources}
    )
    fresh_entries: dict[str, dict] = {}
    for nk in name_keys:
        e: dict = {}
        if nk in fresh_matched:
            e["image"] = f"img/ingredients/{fresh_matched[nk][0]}.webp"
        if nk in subs_table:
            e["substitutes"] = subs_table[nk]["subs"]
        if e:
            fresh_entries[nk] = e
    problems = []
    if committed.get("unmatched") != fresh_unmatched:
        problems.append("unmatched list drifted")
    if committed.get("count") != len(fresh_entries):
        problems.append(f"count drift: committed={committed.get('count')} fresh={len(fresh_entries)}")
    committed_entries = committed.get("entries", {})
    for nk, e in committed_entries.items():
        if e != fresh_entries.get(nk):
            problems.append(f"entry drift: {nk}")
        if "image" in e and not os.path.exists(os.path.join(BASE, "public", e["image"])):
            problems.append(f"missing file for {nk}: {e['image']}")
        if "http" in json.dumps(e):
            problems.append(f"REMOTE URL in artifact row {nk} — images are served by the app, never from the outside")
    for nk in fresh_entries:
        if nk not in committed_entries:
            problems.append(f"missing entry: {nk}")
    if problems:
        print("STALE: " + "; ".join(problems[:20]), file=sys.stderr)
        return 1
    print("ingredient_detail.json is fresh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
