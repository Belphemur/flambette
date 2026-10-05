#!/usr/bin/env python3
"""Fetch the ANSES CIQUAL food-composition table (ADR-0052, tranche 3).

WHY THIS EXISTS. The SUPPLEMENTAL table in `extract_ingredients.py` is
hand-authored, and the owner's ask was "check CIQUAL for a list of ingredients
we could add". So this script fetches the reference so that diff can be
RE-RUN rather than re-remembered, and writes a machine-readable dump of its
English food names for exactly that purpose.

It is a DEVELOPMENT TOOL, deliberately not a build step:

  * the .xls lands in `data/reference/ciqual_eng.xls`, which is **gitignored**;
    nothing is committed, nothing ships, and the app never reads it.
  * `extract_ingredients.py` does NOT import or shell out to this file. The
    curated rows are typed into SUPPLEMENTAL by hand, because CIQUAL is a
    French *dish* table: ~70% of its names are regional cheeses, charcuterie,
    named spirits or prepared dishes (moussaka, paëlla, baked Alaska), none of
    which is an item a household types into a shopping list. An automated
    import would bury the 102 real gaps under hundreds of wrong ones. This
    script is the checklist; the table is the decision.
  * So the app keeps ZERO new runtime and build-time dependencies. The repo's
    stdlib-only rule for `scripts/` holds.

Source: CIQUAL 2020, English edition, via Zenodo record 4770202 (open data,
ODbL). The 2020 edition is the newest *English* one CIQUAL published as a
single spreadsheet; the live site has moved to a newer French edition served
per-food-item, which has no bulk English export.

    uv run scripts/fetch_ciqual.py            # fetch + parse + report
    uv run scripts/fetch_ciqual.py --report   # also print the absent-name diff

Requires `xlrd` (the file is legacy BIFF8 .xls, not .xlsx). `uv run --with
xlrd` supplies it without touching the project environment:

    uv run --with xlrd scripts/fetch_ciqual.py

NOTE the asymmetry with the repo's other generators: those are stdlib-only by
convention, this one is a uv-run dev tool with an explicit extra. That is why
it is not in `bun run test:data` — a golden must not need the network.
"""

import argparse
import json
import os
import re
import ssl
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REF_DIR = os.path.join(ROOT, "data", "reference")
XLS_PATH = os.path.join(REF_DIR, "ciqual_eng.xls")
JSON_PATH = os.path.join(REF_DIR, "ciqual_food_names.json")

RECORD = "4770202"
XLS_URL = (
    "https://zenodo.org/api/records/%s/files/"
    "Table%%20Ciqual%%202020_ENG_2020%%2007%%2007.xls/content" % RECORD
)
EXPECTED_ROWS = 3187  # 1 header + 3 186 foods; a change means CIQUAL re-published


def fetch(url: str, dest: str) -> None:
    """Stream `url` to `dest`. Zenodo redirects; follow it."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "flambette-adr0052"})
    with urllib.request.urlopen(req, context=ctx, timeout=300) as resp:
        with open(dest, "wb") as fh:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)


def parse() -> list[dict]:
    """(name, group, sub-group) per food, in sheet order.

    Column layout is positional and comes from the header row, NOT hardcoded
    indices: a re-published table that moved a column should fail loudly here
    rather than silently return the wrong field.
    """
    try:
        import xlrd
    except ImportError:
        sys.exit(
            "xlrd is required for the legacy .xls: re-run as\n"
            "    uv run --with xlrd scripts/fetch_ciqual.py"
        )

    book = xlrd.open_workbook(XLS_PATH)
    sheet = book.sheet_by_index(0)
    header = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]

    def col(exact: str) -> int:
        """Resolve a column by its EXACT published header.

        Deliberately exact, not substring: the header row also holds 67
        constituent columns whose names contain the word 'group' nowhere but
        whose French-ish keys (`alim_grp_nom_eng`) are the only reliable anchor
        for the three name columns. A fuzzy match here would silently return a
        nutrient column and produce a plausible-looking wrong list.
        """
        try:
            return header.index(exact)
        except ValueError:
            sys.exit("column %r not found; header is %s" % (exact, header[:12]))

    c_group = col("alim_grp_nom_eng")
    c_sub = col("alim_ssgrp_nom_eng")
    c_name = col("alim_nom_eng")

    rows = []
    for r in range(1, sheet.nrows):
        name = str(sheet.cell_value(r, c_name)).strip()
        if not name:
            continue
        rows.append({
            "name": name,
            "group": str(sheet.cell_value(r, c_group)).strip(),
            "sub": str(sheet.cell_value(r, c_sub)).strip(),
        })
    return rows


def name_key(name: str) -> str:
    """Mirror of nameKey() in src/lib/grocery.ts (ADR-0012 lockstep)."""
    s = name.strip().lower()
    if len(s) > 3 and s.endswith("oes"):
        return s[:-2]
    if len(s) > 4 and s.endswith(("ses", "xes", "zes", "ches", "shes")):
        return s[:-2]
    if len(s) > 3 and s.endswith("s"):
        return s[:-1]
    return s


def index_keys() -> set[str]:
    """nameKeys of the COMMITTED index, catalog rows included."""
    path = os.path.join(ROOT, "public", "data", "ingredients.json")
    with open(path) as fh:
        doc = json.load(fh)
    return {i["nameKey"].lower() for i in doc["ingredients"]}


def report(rows: list[dict]) -> None:
    """Which CIQUAL names the index does not have. A REVIEW LIST, not a diff
    to apply — see the module docstring for why every hit needs a human."""
    keys = index_keys()
    absent = [r for r in rows if not any(
        name_key(r["name"]) == k or re.search(r"\b" + re.escape(name_key(r["name"])) + r"\b", k)
        for k in keys
    )]
    by_group: dict[str, list[str]] = {}
    for r in absent:
        by_group.setdefault(r["group"] or "(ungrouped)", []).append(r["name"])
    print("\nCIQUAL names absent from the index: %d of %d" % (len(absent), len(rows)))
    print("(a whole-word match in ANY existing key counts as covered, so a bare")
    print(" 'fettuccine' is not reported -- 'fettuccine pasta' is already there)\n")
    for group in sorted(by_group, key=lambda g: -len(by_group[g])):
        names = sorted(set(by_group[group]))
        print("  %-46s %4d  %s" % (group[:46], len(names), "; ".join(names[:12])))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true",
                    help="also print the absent-name review list")
    ap.add_argument("--skip-fetch", action="store_true",
                    help="reuse an already-downloaded .xls")
    args = ap.parse_args()

    if not args.skip_fetch or not os.path.exists(XLS_PATH):
        print("fetching CIQUAL %s (English) from Zenodo…" % RECORD)
        fetch(XLS_URL, XLS_PATH)
    print("  %s (%.1f MB)" % (os.path.relpath(XLS_PATH, ROOT),
                             os.path.getsize(XLS_PATH) / 1e6))

    rows = parse()
    print("parsed %d foods" % len(rows))
    if len(rows) + 1 != EXPECTED_ROWS:
        print("NOTE: expected %d rows, found %d — CIQUAL may have re-published; "
              "re-check the curated rows before trusting the diff"
              % (EXPECTED_ROWS, len(rows) + 1))

    with open(JSON_PATH, "w", encoding="utf-8") as fh:
        json.dump({"source": "CIQUAL 2020 English, Zenodo record " + RECORD,
                   "count": len(rows), "foods": rows},
                  fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(JSON_PATH, ROOT))

    if args.report:
        report(rows)
    print("\nNOTE: nothing here is imported automatically. Curate hits by hand "
          "into SUPPLEMENTAL in extract_ingredients.py — most CIQUAL entries "
          "are French regional cheeses, charcuterie, named spirits or prepared "
          "dishes, not shopping items.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())