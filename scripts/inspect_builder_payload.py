#!/usr/bin/env python3
"""Inspect a get_builder_data payload for meal-occasion / category structure.

Stdlib only. Prints a redacted shape summary (no credentials, no image URLs)
so we can decide whether real occasion IDs are present before wiring anything.

    python3 scripts/inspect_builder_payload.py /tmp/BD.json
"""

import json
import re
import sys
from collections import Counter

FIELD_RE = re.compile(
    r'"(recipe_type|recipe_types|meal_type|meal_types|mealType|meal_times|'
    r'food_category|categories|category|category_ids|category_names|'
    r'recipe_tags|tags|tag_ids|occasions)[^"]{0,24}"',
    re.I,
)


def shape(v, depth=0):
    """Compact shape of a value: type + size, never the payload itself."""
    if isinstance(v, dict):
        return f"dict({len(v)}) keys={list(v.keys())[:10]}"
    if isinstance(v, list):
        head = v[0] if v else None
        if isinstance(head, (dict, list)):
            return f"list[{len(v)}] of {shape(head, depth + 1)}"
        return f"list[{len(v)}] of {type(head).__name__}"
    return type(v).__name__


def walk(node, path="$", found=None, depth=0):
    if found is None:
        found = {}
    if depth > 6:
        return found
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}"
            if FIELD_RE.fullmatch(f'"{k}"') or FIELD_RE.match(f'"{k}'):
                found.setdefault(k, []).append(p)
            walk(v, p, found, depth + 1)
    elif isinstance(node, list) and node:
        walk(node[0], f"{path}[0]", found, depth + 1)
    return found


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/BD.json"
    with open(path) as f:
        raw = f.read()
    if len(raw) < 200:
        print(f"payload too small ({len(raw)} bytes) - auth likely failed (401)")
        return 1
    d = json.loads(raw)

    print(f"file: {path} ({len(raw)} bytes)")
    print("top-level:")
    for k, v in d.items():
        print(f"  {k}: {shape(v)}")

    found = walk(d)
    print("\noccasion/category-ish fields found:")
    for k, paths in sorted(found.items()):
        print(f"  {k}: {paths[:4]}")

    # A recipe-shaped sample, keys only.
    for key in ("variant_meta", "variants", "recipe_variants", "recipes"):
        v = d.get(key)
        if isinstance(v, list) and v and isinstance(v[0], dict):
            print(f"\n{key}[0] keys: {list(v[0].keys())}")
        elif isinstance(v, dict) and v:
            first = next(iter(v.values()))
            if isinstance(first, dict):
                print(f"\n{key} first value keys: {list(first.keys())}")

    # Any map whose KEYS look like occasion labels is the jackpot.
    for key in ("recipe_types", "meal_types", "categories", "occasions"):
        v = d.get(key)
        if isinstance(v, dict):
            print(f"\n*** {key} label map: {json.dumps(v)[:600]}")
        elif isinstance(v, list) and v and isinstance(v[0], dict):
            print(f"\n*** {key}[0]: {json.dumps(v[0])[:400]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
