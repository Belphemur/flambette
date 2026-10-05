#!/usr/bin/env python3
"""Shared catalog-path helpers for the stdlib build-time scripts.

`public/data/recipes/` holds TWO kinds of JSON:

  * `<variantId>.json`         — the frozen recipe documents (the catalog)
  * `<variantId>.timer.json`   — ADR-0041's per-recipe timer-hint sidecars

A bare `*.json` glob silently folds the sidecars into the catalog: they parse
as recipes with no line items, which doubled the pack index's row count and
inflated the ingredient counts. Every script that walks the catalog must go
through :func:`recipe_doc_paths`, which keeps only the numeric doc names.

ADR-0054 adds a SECOND doc source: the household's own recipes, which live
inside `public/data/user_recipes.json` rather than as files in the frozen
catalog directory. :func:`iter_recipe_docs` walks both in ONE order-stable pass
so a generator cannot silently see one and not the other — a planner that does
not see the pancake's flour simply mis-scores it.
"""

import glob
import json
import os
import re
import sys

DOC_NAME = re.compile(r"^\d+\.json$")


def recipe_doc_paths(root=None):
    """Sorted absolute paths of the catalog docs, sidecars excluded."""
    root = root or os.getcwd()
    pattern = os.path.join(root, "public", "data", "recipes", "*.json")
    return sorted(p for p in glob.glob(pattern) if DOC_NAME.match(os.path.basename(p)))


def user_recipe_docs(root=None):
    """(id, doc) pairs from `public/data/user_recipes.json`, sorted by id.

    Empty when the artifact is absent or unparseable: it is a static asset, not
    a dependency, and a broken one must degrade the generator to the frozen
    catalog rather than crash a build.
    """
    root = root or os.getcwd()
    path = os.path.join(root, "public", "data", "user_recipes.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError) as err:
        # The documented contract (and the runtime catalog's behaviour):
        # a broken artifact degrades the generators to the frozen catalog
        # instead of failing every `data:*` build at once.
        print(f"warning: user_recipes.json unreadable ({err}); continuing without it", file=sys.stderr)
        return []
    entries = []
    for entry in payload.get("recipes") or []:
        doc = entry.get("doc") or {}
        # meta.id REQUIRED (no doc.id fallback): the doc-only view must agree
        # with user_recipe_entries and the runtime parser (parseUserRecipes
        # requires meta.id) — a doc-only id would make the pack index see a
        # recipe the runtime never loads. (kody round 2, PR #49.)
        vid = (entry.get("meta") or {}).get("id")
        if vid is None or not doc:
            print("warning: user_recipes.json entry without meta.id; skipped", file=sys.stderr)
            continue
        entries.append((int(vid), doc))
    return sorted(entries, key=lambda pair: pair[0])


def iter_recipe_docs(root=None):
    """(id, doc) for every recipe a generator must see: frozen + user.

    The frozen docs come first in numeric id order, then the user recipes in
    their own id order. Each doc is yielded ALREADY PARSED, so callers do not
    each re-open a file and cannot disagree about which source they read.
    """
    for path in recipe_doc_paths(root):
        vid = int(os.path.basename(path)[:-5])
        with open(path, encoding="utf-8") as fh:
            yield vid, json.load(fh)
    for vid, doc in user_recipe_docs(root):
        yield vid, doc


def user_recipe_entries(root=None):
    """(id, entry) pairs retaining the WHOLE artifact entry (meta included).

    Generators that need more than the doc (the recipe-type census appends
    `meta` to builder_data's variant_meta) use this; `user_recipe_docs`
    remains the doc-only view. Same tolerance contract: absent/unparseable
    artifact yields [].
    """
    path = os.path.join(root or os.getcwd(), "public", "data", "user_recipes.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError) as err:
        print(f"warning: user_recipes.json unreadable ({err}); continuing without it", file=sys.stderr)
        return []
    out = []
    for entry in payload.get("recipes") or []:
        meta = entry.get("meta") or {}
        # meta.id is REQUIRED here (not doc.id fallback): the census appends
        # `meta` to builder_data's variant_meta and re-indexes by meta.id —
        # an entry whose id lives only under doc would raise KeyError there.
        # Same LOUD-skip spirit as the runtime parser; warn so the bad entry
        # is visible.
        vid = meta.get("id")
        if vid is None:
            print("warning: user_recipes.json entry without meta.id; skipped", file=sys.stderr)
            continue
        out.append((int(vid), entry))
    return sorted(out, key=lambda pair: pair[0])
