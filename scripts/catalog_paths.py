#!/usr/bin/env python3
"""Shared catalog-path helpers for the stdlib build-time scripts.

`public/data/recipes/` holds TWO kinds of JSON:

  * `<variantId>.json`         — the frozen recipe documents (the catalog)
  * `<variantId>.timer.json`   — ADR-0041's per-recipe timer-hint sidecars

A bare `*.json` glob silently folds the sidecars into the catalog: they parse
as recipes with no line items, which doubled the pack index's row count and
inflated the ingredient counts. Every script that walks the catalog must go
through :func:`recipe_doc_paths`, which keeps only the numeric doc names.
"""

import glob
import os
import re

DOC_NAME = re.compile(r"^\d+\.json$")


def recipe_doc_paths(root=None):
    """Sorted absolute paths of the catalog docs, sidecars excluded."""
    root = root or os.getcwd()
    pattern = os.path.join(root, "public", "data", "recipes", "*.json")
    return sorted(p for p in glob.glob(pattern) if DOC_NAME.match(os.path.basename(p)))
