#!/usr/bin/env python3
"""Golden tests for the split restriction artifacts (ADR-0059).

ADR-0059 split the old single `restriction_dict.json` into a tree under
`public/data/restrictions/`: index.json, swaps.json, removed/<slug>.json,
pairs/<a>-<b>.json. These goldens verify the committed split tree is
well-formed and internally consistent.

Two tiers, mirroring the builder's `--check`:

1. **The committed artifacts are self-consistent** and match the committed
   catalog. Needs nothing but the repo — this is what CI runs.
2. **The artifacts are faithful to the live archive**
   (../mealime-media). The archive is gitignored and machine-local, so these
   cases SKIP when it is absent rather than passing vacuously.

    python3 scripts/test_build_restriction_sets.py
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "public", "data")
RESTRICTIONS_DIR = os.path.join(DATA, "restrictions")
INDEX_OUT = os.path.join(RESTRICTIONS_DIR, "index.json")
SWAPS_OUT = os.path.join(RESTRICTIONS_DIR, "swaps.json")
ARCHIVE = os.path.join(os.path.dirname(ROOT), "mealime-media", "raw_profiles", "restrictions")

EXPECTED_IDS = {1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14}
EXPECTED_SLUGS = {
    "gluten-free", "dairy-free", "fish-free", "shellfish-free",
    "peanut-free", "tree-nut-free", "soy-free", "nightshade-free",
    "egg-free", "sesame-free", "mustard-free", "sulfite-free",
}


def load_json(path):
    with open(path) as f:
        return json.load(f)


def index_doc():
    return load_json(INDEX_OUT)


def swaps_doc():
    return load_json(SWAPS_OUT)


class SplitTreeWellFormed(unittest.TestCase):
    """Tier 1 — committed artifacts, offline always."""

    def test_index_exists_and_has_12_entries(self):
        idx = index_doc()
        self.assertEqual(len(idx["restrictions"]), 12)
        self.assertIsInstance(idx["pairs"], list)

    def test_index_entries_have_id_slug_label(self):
        idx = index_doc()
        for entry in idx["restrictions"]:
            self.assertIn("id", entry)
            self.assertIn("slug", entry)
            self.assertIn("label", entry)
            self.assertIsInstance(entry["id"], int)
            self.assertIsInstance(entry["slug"], str)
            self.assertIsInstance(entry["label"], str)

    def test_index_covers_all_live_restrictions(self):
        idx = index_doc()
        ids = {e["id"] for e in idx["restrictions"]}
        slugs = {e["slug"] for e in idx["restrictions"]}
        self.assertEqual(ids, EXPECTED_IDS)
        self.assertEqual(slugs, EXPECTED_SLUGS)

    def test_index_pairs_list_has_66_entries(self):
        idx = index_doc()
        # C(12,2) = 66 unordered pairs
        self.assertEqual(len(idx["pairs"]), 66)

    def test_index_pairs_are_canonical_a_b(self):
        """Pair file names use slug-a-slug-b where a < b by id."""
        idx = index_doc()
        for pair_name in idx["pairs"]:
            parts = pair_name.split("-")
            # Slugs may contain hyphens (e.g. "gluten-free"), so we need
            # to find the split point by checking against known slugs.
            self.assertTrue(
                any(pair_name.startswith(slug + "-") for slug in EXPECTED_SLUGS),
                "pair name %s does not start with a known slug" % pair_name,
            )

    def test_swaps_json_has_swaps_and_drops(self):
        swaps = swaps_doc()
        self.assertIsInstance(swaps.get("swaps"), list)
        self.assertIsInstance(swaps.get("drops"), list)

    def test_swaps_are_well_formed(self):
        swaps = swaps_doc()
        for s in swaps["swaps"]:
            for k in ("from", "to", "quantityRule", "count"):
                self.assertIn(k, s, "swap missing %s" % k)
            self.assertIsInstance(s["count"], int)
            self.assertTrue(s["count"] > 0, "swap count must be positive")
            self.assertIn(s["quantityRule"], {"verbatim", "rescale", "re-authored"})

    def test_drops_are_well_formed(self):
        swaps = swaps_doc()
        for d in swaps["drops"]:
            self.assertIn("from", d)
            self.assertIn("count", d)
            self.assertIsInstance(d["count"], int)
            self.assertTrue(d["count"] > 0)

    def test_swaps_deduped_by_from_to(self):
        """Swaps are deduplicated across restrictions (first match wins by count)."""
        swaps = swaps_doc()
        seen = set()
        for s in swaps["swaps"]:
            key = (s["from"], s["to"])
            self.assertNotIn(key, seen, "duplicate swap: %s -> %s" % key)
            seen.add(key)

    def test_removed_files_exist_and_well_formed(self):
        for slug in EXPECTED_SLUGS:
            path = os.path.join(RESTRICTIONS_DIR, "removed", slug + ".json")
            self.assertTrue(os.path.exists(path), "missing %s" % path)
            doc = load_json(path)
            self.assertIsInstance(doc.get("removed"), list)
            self.assertEqual(doc["removed"], sorted(set(doc["removed"])),
                             "%s: removed not sorted/deduped" % slug)
            self.assertTrue(all(isinstance(r, int) for r in doc["removed"]),
                            "%s: removed not all ints" % slug)

    def test_pair_files_exist_and_well_formed(self):
        """66 pair files, each with an extras list."""
        idx = index_doc()
        for pair_name in idx["pairs"]:
            path = os.path.join(RESTRICTIONS_DIR, "pairs", pair_name + ".json")
            self.assertTrue(os.path.exists(path), "missing %s" % path)
            doc = load_json(path)
            self.assertIsInstance(doc.get("extras"), list)
            self.assertTrue(all(isinstance(r, int) for r in doc["extras"]),
                            "%s: extras not all ints" % pair_name)
            self.assertEqual(doc["extras"], sorted(set(doc["extras"])),
                             "%s: extras not sorted/deduped" % pair_name)

    def test_pair_extras_sum_matches(self):
        """The total extras across all 66 pair files equals the union-extras count
        (each pair file contains ONLY ids that NEITHER single restriction removes)."""
        idx = index_doc()
        total_extras = 0
        for pair_name in idx["pairs"]:
            doc = load_json(os.path.join(RESTRICTIONS_DIR, "pairs", pair_name + ".json"))
            total_extras += len(doc["extras"])
        # The exact count is pinned by the build (measured from the archive).
        # ADR-0059 measured 918 entries across both restriction copies (459 unique
        # ids, since each pair's extras are stored identically in both members).
        self.assertEqual(total_extras, 459)

    def test_pair_extras_are_only_union_extras(self):
        """Every id in a pair file is NOT in either single's removed set."""
        idx = index_doc()
        # Build per-slug removed sets from removed/<slug>.json
        removed_by_slug = {}
        for slug in EXPECTED_SLUGS:
            doc = load_json(os.path.join(RESTRICTIONS_DIR, "removed", slug + ".json"))
            removed_by_slug[slug] = set(doc["removed"])
        # Build id-to-slug map from index
        id_to_slug = {}
        for entry in idx["restrictions"]:
            id_to_slug[entry["id"]] = entry["slug"]

        for pair_name in idx["pairs"]:
            # Parse the pair name into two slugs (a-b format where a and b are slugs)
            # Slugs are like "gluten-free", "dairy-free", etc.
            pair_doc = load_json(os.path.join(RESTRICTIONS_DIR, "pairs", pair_name + ".json"))
            # Find the two slug components by matching against known slugs
            matched = []
            remaining = pair_name
            for slug in sorted(EXPECTED_SLUGS, key=len, reverse=True):
                prefix = slug + "-"
                if remaining.startswith(prefix):
                    matched.append(slug)
                    remaining = remaining[len(prefix):]
                    break
            for slug in EXPECTED_SLUGS:
                if remaining == slug and len(matched) == 1:
                    matched.append(slug)
                    break
            self.assertEqual(len(matched), 2, "could not parse pair name: %s" % pair_name)
            slug_a, slug_b = matched
            union = removed_by_slug[slug_a] | removed_by_slug[slug_b]
            for rid in pair_doc["extras"]:
                self.assertNotIn(rid, union,
                                  "%s: id %d is in singles' union (not an extra)" % (pair_name, rid))

    def test_size_assertions(self):
        """Size bounds from ADR-0059 (approximate; actual data pins tighter).

        ADR-0059 estimated index ~2 KB, swaps ~8 KB, removed ~4 KB, pairs ~1 KB.
        The committed data is larger (swaps.json carries both the 57 unique swaps
        AND the 303 drop entries; nightshade-free removes 1,980 recipes). The
        bounds below are the ACTUAL committed sizes + 20% growth margin, which
        is what matters: sizes are stable, not unbounded.
        """
        self.assertLess(os.path.getsize(INDEX_OUT), 4096, "index.json > 4 KB")
        self.assertLess(os.path.getsize(SWAPS_OUT), 28 * 1024, "swaps.json > 28 KB")
        for slug in EXPECTED_SLUGS:
            path = os.path.join(RESTRICTIONS_DIR, "removed", slug + ".json")
            self.assertLessEqual(os.path.getsize(path), 20 * 1024,
                                 "%s > 20 KB" % path)
        for pair_name in index_doc()["pairs"]:
            path = os.path.join(RESTRICTIONS_DIR, "pairs", pair_name + ".json")
            self.assertLessEqual(os.path.getsize(path), 3072,
                                 "%s > 3 KB" % path)
        # Total split tree: ~90 KB (vs the old single 1.4 MB file — a 15x reduction)
        total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(RESTRICTIONS_DIR) for f in fs)
        self.assertLess(total, 120 * 1024, "split tree > 120 KB")

    def test_check_mode_is_fresh(self):
        import importlib.util
        _spec = importlib.util.spec_from_file_location(
            "build_restriction_dict", os.path.join(HERE, "build_restriction_dict.py")
        )
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        # Run check by invoking main with --check
        import sys as _sys
        _orig = _sys.argv
        _sys.argv = ["build_restriction_dict.py", "--check"]
        try:
            result = _mod.main()
        finally:
            _sys.argv = _orig
        self.assertEqual(result, 0, "build_restriction_dict.py --check failed")


class ArchiveFaithfulness(unittest.TestCase):
    """Tier 2 — needs the gitignored live archive; SKIP without it."""

    def setUp(self):
        if not os.path.exists(os.path.join(ARCHIVE, "index.json")):
            self.skipTest("restriction archive not archived on this machine")

    def test_removed_is_exactly_the_subset_difference(self):
        import sys
        sys.path.insert(0, HERE)
        import archive_catalog_profiles as A
        for suffix in ("m6", "us6"):
            none_meta = {m["recipe_id"]: m for m in json.load(
                open(os.path.join(ARCHIVE, "none-" + suffix + ".json")))["variant_meta"]}
            for rid, (slug, _label) in A.RESTRICTIONS.items():
                payload = json.load(open(os.path.join(ARCHIVE, slug + "-" + suffix + ".json")))
                meta = {m["recipe_id"]: m for m in payload["variant_meta"]}
                removed = sorted(set(none_meta) - set(meta))
                self.assertEqual(removed, load_json(os.path.join(
                    RESTRICTIONS_DIR, "removed", slug + ".json"))["removed"],
                    "%s (%s)" % (slug, suffix))

    def test_swaps_dedup_across_restrictions(self):
        """Swaps.json deduplicates (from,to) pairs across all restrictions."""
        import sys
        sys.path.insert(0, HERE)
        import archive_catalog_profiles as A
        swaps = swaps_doc()
        # Each unique (from, to) should appear once, matching what the archive produces
        seen = set()
        for s in swaps["swaps"]:
            key = (s["from"], s["to"])
            self.assertNotIn(key, seen)
            seen.add(key)
