#!/usr/bin/env python3
"""Golden tests for the runtime's ingredient substitution dictionary.

This is the `test:data` gate for the dictionary era (ADR-0056 option C).
The runtime consumes `public/data/restriction_dict.json` ONLY — overlays and
`restriction_sets.json` were option-B artifacts, deleted. These goldens verify
the committed dictionary is well-formed and internally consistent.

Two tiers, mirroring the builder's `--check`:

1. **The committed artifact is self-consistent** and matches the committed
   catalog. Needs nothing but the repo — this is what CI runs.
2. **The artifact is faithful to the live archive**
   (../mealime-media). The archive is gitignored and machine-local, so these
   cases SKIP when it is absent rather than passing vacuously.

    python3 scripts/test_build_restriction_sets.py
"""

import importlib.util
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "public", "data")
DICT = os.path.join(DATA, "restriction_dict.json")
ARCHIVE = os.path.join(os.path.dirname(ROOT), "mealime-media", "raw_profiles", "restrictions")

EXPECTED = {
    "1": "gluten-free", "2": "dairy-free", "3": "fish-free", "4": "shellfish-free",
    "5": "peanut-free", "6": "tree-nut-free", "9": "soy-free", "10": "nightshade-free",
    "11": "egg-free", "12": "sesame-free", "13": "mustard-free", "14": "sulfite-free",
}


def dict_doc():
    with open(DICT) as f:
        return json.load(f)


class RestrictionDict(unittest.TestCase):
    """Tier 1 — committed artifact, offline always."""

    def setUp(self):
        self.doc = dict_doc()

    def test_every_live_restriction_is_present(self):
        self.assertEqual(sorted(self.doc), sorted(EXPECTED))

    def test_each_entry_has_removed_pairRemoved_and_swaps(self):
        for rid, info in self.doc.items():
            self.assertIsInstance(info.get("removed"), list, rid)
            self.assertIsInstance(info.get("pairRemoved"), dict, rid)
            self.assertIsInstance(info.get("swaps"), list, rid)
            for s in info["swaps"]:
                for k in ("from", "to", "quantityRule", "count"):
                    self.assertIn(k, s, "%s: swap missing %s" % (rid, k))
                self.assertTrue(isinstance(s["count"], int) and s["count"] > 0,
                                "%s: count must be a positive int" % rid)

    def test_removed_is_sorted_and_all_ints(self):
        for rid, info in self.doc.items():
            self.assertEqual(info["removed"], sorted(set(info["removed"])), rid)
            self.assertTrue(all(isinstance(r, int) for r in info["removed"]), rid)

    def test_pair_removed_is_symmetric(self):
        """Both members of a pair list the same extra removals."""
        for rid_str, info in self.doc.items():
            for pair_key, extras in info["pairRemoved"].items():
                a_str, b_str = pair_key.split(",")
                partner = self.doc.get(b_str) or self.doc.get(a_str)
                self.assertIsNotNone(partner, "%s partner missing" % pair_key)
                self.assertEqual(extras, partner["pairRemoved"].get(pair_key),
                                 "%s pairRemoved not symmetric" % pair_key)

    def test_swaps_have_valid_quantity_rules(self):
        """Measured: 99.8% verbatim, 0.1% rescale, 0.1% re-authored."""
        allowed = {"verbatim", "rescale", "re-authored"}
        for rid, info in self.doc.items():
            for s in info["swaps"]:
                self.assertIn(s["quantityRule"], allowed,
                              "%s: %s %s -> %s has rule %r" % (rid, s["count"], s["from"], s["to"], s["quantityRule"]))

    def test_swaps_are_derived_from_a_measurable_relation(self):
        """Every swap quantityRule is one of the three measured categories,
        never a fabricated or unknown value."""
        allowed = {"verbatim", "rescale", "re-authored"}
        for rid, info in self.doc.items():
            for s in info["swaps"]:
                self.assertIn(s["quantityRule"], allowed,
                              "%s: %s %s -> %s has rule %r" % (rid, s["count"], s["from"], s["to"], s["quantityRule"]))

    def test_check_mode_is_fresh(self):
        import importlib.util
        _spec = importlib.util.spec_from_file_location(
            "build_restriction_sets", os.path.join(HERE, "build_restriction_sets.py")
        )
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        self.assertEqual(_mod.check(), [], "committed restriction artifacts are stale")


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
                self.assertEqual(removed, dict_doc()[str(rid)]["removed"],
                                 "%s (%s)" % (slug, suffix))
