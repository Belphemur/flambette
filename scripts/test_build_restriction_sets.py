#!/usr/bin/env python3
"""Golden tests for scripts/build_restriction_sets.py (the restriction ADR).

Two tiers, mirroring the builder's --check:

1. **Committed artifacts are self-consistent** and agree with the committed
   catalog. Needs nothing but the repo — this is what CI runs.
2. **The artifacts are faithful to the live archive** (../mealime-media). The
   archive is gitignored and machine-local, so these cases SKIP when it is
   absent rather than passing vacuously.

The goldens the brief pins: GF's removed set contains rid 50 and NOT rid
2195, and the GF overlay carries rid 2195's `gluten-free rotini pasta` with
the quantity `425 g` — upstream's own METRIC rendering (the base catalog's
native units; the first archive's US `15 oz` was the shipped bug — a US
overlay bypassed `localizeQuantity`'s system handling and stuck a metric/dual
device in imperial). A second brief golden: NO imperial measurement token
survives in any overlay QUANTITY (the parenthesised container annotation is
exempt — upstream authors physical package sizes there even in metric renders,
and the base metric doc says `1 ½ (3 oz) pkgs` alfalfa sprouts verbatim).
The brief also asked for "every overlay doc's line_items count equals the base
doc's count" — measured FALSE on the real archive (upstream's rework can drop
a substituted-away line: GF rid 863's shrimp -> eggs collapsed 16 -> 15; and
can split one line into two: GF rid 1292's flour tortilla -> avocados +
butter lettuce, 15 -> 16; and can REORDER lines: GF rid 224 swaps its pasta
and garlic lines). The gate that survives is the reverse: join correctness
(doc.recipe_id) and the payload census, enforced at build time, asserted here
as line counts being POSITIVE, not equal.

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
SETS = os.path.join(DATA, "restriction_sets.json")
OVERLAY_DIR = os.path.join(DATA, "restriction_overlays")
ARCHIVE = os.path.join(os.path.dirname(ROOT), "mealime-media", "raw_profiles", "restrictions")

_spec = importlib.util.spec_from_file_location(
    "build_restriction_sets", os.path.join(HERE, "build_restriction_sets.py")
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

EXPECTED = {
    "1": "gluten-free", "2": "dairy-free", "3": "fish-free", "4": "shellfish-free",
    "5": "peanut-free", "6": "tree-nut-free", "9": "soy-free", "10": "nightshade-free",
    "11": "egg-free", "12": "sesame-free", "13": "mustard-free", "14": "sulfite-free",
}


def sets_doc():
    with open(SETS) as f:
        return json.load(f)


def overlay(slug):
    with open(os.path.join(OVERLAY_DIR, slug + ".json")) as f:
        return json.load(f)


def load_base_docs():
    docs = {}
    for path in mod.doc_paths():
        with open(path) as f:
            doc = json.load(f)
        docs[doc["recipe_id"]] = doc
    return docs


class ControlPlane(unittest.TestCase):
    def setUp(self):
        self.doc = sets_doc()

    def test_exactly_the_twelve_live_restrictions(self):
        self.assertEqual(sorted(self.doc["restrictions"]), sorted(EXPECTED))

    def test_each_entry_carries_slug_label_overlay_and_sorted_removed(self):
        for rid, info in self.doc["restrictions"].items():
            self.assertEqual(info["slug"], EXPECTED[rid], rid)
            self.assertTrue(info["label"])
            self.assertEqual(info["overlay"], "restriction_overlays/%s.json" % info["slug"])
            removed = info["removed"]
            self.assertEqual(removed, sorted(set(removed)), rid)
            self.assertTrue(all(isinstance(r, int) for r in removed), rid)
            self.assertTrue(os.path.exists(os.path.join(ROOT, "public/data", info["overlay"])), rid)

    def test_swapped_docs_matches_the_overlay(self):
        for rid, info in self.doc["restrictions"].items():
            self.assertEqual(info["swapped_docs"], len(overlay(info["slug"])["docs"]), rid)

    def test_no_floats_and_generated_at_present(self):
        import re
        with open(SETS) as f:
            raw = f.read()
        self.assertIsNone(re.search(r"\d+\.\d+", raw))
        self.assertIn("generated_at", self.doc)


class Overlays(unittest.TestCase):
    def setUp(self):
        self.base = load_base_docs()

    def test_every_overlay_doc_belongs_to_the_catalog(self):
        for slug in EXPECTED.values():
            for rid in overlay(slug)["docs"]:
                self.assertIn(int(rid), self.base, "%s overlay doc %s" % (slug, rid))

    def test_overlay_docs_carry_line_items_and_instructions(self):
        for slug in EXPECTED.values():
            for rid, doc in overlay(slug)["docs"].items():
                self.assertTrue(doc["line_items"], "%s %s" % (slug, rid))
                self.assertIn("instructions", doc, "%s %s" % (slug, rid))
                for li in doc["line_items"]:
                    self.assertIn("quantity", li)
                    self.assertIn("ingredient_name", li)

    def test_an_overlay_doc_is_never_also_removed(self):
        doc = sets_doc()
        for rid, info in doc["restrictions"].items():
            removed = set(info["removed"])
            for oid in overlay(info["slug"])["docs"]:
                self.assertNotIn(int(oid), removed, "%s: %s both swapped and removed" % (rid, oid))

    def test_the_gf_golden_rotini_swap(self):
        info = sets_doc()["restrictions"]["1"]
        self.assertIn(50, info["removed"])
        self.assertNotIn(2195, info["removed"])
        doc = overlay("gluten-free")["docs"].get("2195")
        self.assertIsNotNone(doc, "GF overlay must carry rid 2195")
        rotini = [li for li in doc["line_items"] if "rotini" in li["ingredient_name"]]
        self.assertEqual(rotini, [{"quantity": "425 g", "ingredient_name": "gluten-free rotini pasta"}])

    def test_the_gf_golden_fettuccine_reorder_is_metric(self):
        # GF rid 224's rework REORDERS lines (pasta <-> garlic) — the shipped
        # mis-pairing bug's recipe. Its overlay quantity is the metric
        # rendering, and the (name, quantity) pair co-occurs in the overlay.
        doc = overlay("gluten-free")["docs"].get("224")
        self.assertIsNotNone(doc, "GF overlay must carry rid 224")
        pasta = [li for li in doc["line_items"] if "fettuccine" in li["ingredient_name"]]
        self.assertEqual(pasta, [{"quantity": "510 g", "ingredient_name": "gluten-free fettuccine pasta"}])
        garlic = [li for li in doc["line_items"] if li["ingredient_name"] == "garlic"]
        self.assertEqual(garlic, [{"quantity": "6 cloves", "ingredient_name": "garlic"}])

    def test_every_overlay_quantity_is_metric(self):
        # Brief golden: no imperial measurement token survives in any overlay
        # quantity. The parenthesised container annotation is exempt: upstream
        # authors physical package sizes there even in metric renders, and the
        # base metric doc carries the same `(3 oz)` alfalfa-sprouts pkg.
        imperial = re.compile(r"\b(?:fl oz|oz|lbs?|pounds?)\b")
        annotation = re.compile(r"\([^)]*\)")
        for slug in EXPECTED.values():
            for rid, doc in overlay(slug)["docs"].items():
                for li in doc["line_items"]:
                    q = annotation.sub(" ", li["quantity"])
                    self.assertIsNone(imperial.search(q), "%s %s: %r" % (slug, rid, li["quantity"]))

    def test_check_mode_is_fresh(self):
        self.assertEqual(mod.check(), [], "committed restriction artifacts are stale")


class RestrictionDict(unittest.TestCase):
    """Golden tests for the runtime's ingredient substitution dictionary."""

    def setUp(self):
        self.doc = json.load(open(os.path.join(DATA, "restriction_dict.json")))

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

    def test_pair_removed_is_symmetric(self):
        """Both members of a pair list the same extra removals."""
        for rid_str, info in self.doc.items():
            for pair_key, extras in info["pairRemoved"].items():
                a_str, b_str = pair_key.split(",")
                partner = self.doc.get(b_str) or self.doc.get(a_str)
                self.assertIsNotNone(partner, "%s partner missing" % pair_key)
                self.assertEqual(extras, partner["pairRemoved"].get(pair_key),
                                 "%s pairRemoved not symmetric" % pair_key)

    def test_swaps_are_derived_from_overlay_docs(self):
        """Every swap's substitute (to) appears in at least one overlay.

        A swap (from -> to) means upstream REPLACED `from` with `to` in the
        restricted doc, so `from` is absent and `to` is present. Checking for
        BOTH in the same doc is wrong — the substitute REPLACES the original.
        We verify the substitute exists somewhere in the committed overlays.

        Comparison uses `name_key` normalization (punctuation stripped, lowercased),
        matching how the dictionary keys its from/to pairs — upstream may spell
        the same ingredient with a hyphen or a space across recipes.
        """
        import re
        _nonword = re.compile(r"[^a-z0-9 ]+")
        _spaces = re.compile(r"\s+")
        def nk(name):
            return _spaces.sub(" ", _nonword.sub(" ", name.lower())).strip()
        swap_tos = set()
        for info in self.doc.values():
            for s in info["swaps"]:
                swap_tos.add(nk(s["to"]))
        found = set()
        for slug in EXPECTED.values():
            for _rid, doc in overlay(slug)["docs"].items():
                names = {nk(li["ingredient_name"]) for li in doc["line_items"]}
                found.update(names & swap_tos)
        missing = swap_tos - found
        self.assertFalse(missing, "swap substitutes not in any overlay: %s" % missing)

    def test_quantity_rules_are_verbatim_or_rescale(self):
        """Measured: 99.8% verbatim, 0.1% rescale, 0.1% re-authored.

        No unit-change events were found in the measurement; upstream keeps
        the base unit and only rescales or re-authors in rare cases.
        """
        allowed = {"verbatim", "rescale", "re-authored"}
        for rid, info in self.doc.items():
            for s in info["swaps"]:
                self.assertIn(s["quantityRule"], allowed,
                              "%s: %s %s -> %s has rule %r" % (rid, s["count"], s["from"], s["to"], s["quantityRule"]))


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
            none_meta = {m["recipe_id"]: m for m in json.load(open(os.path.join(ARCHIVE, "none-" + suffix + ".json")))["variant_meta"]}
            for rid, (slug, _label) in A.RESTRICTIONS.items():
                payload = json.load(open(os.path.join(ARCHIVE, slug + "-" + suffix + ".json")))
                meta = {m["recipe_id"]: m for m in payload["variant_meta"]}
                removed = sorted(set(none_meta) - set(meta))
                self.assertEqual(removed, sets_doc()["restrictions"][str(rid)]["removed"],
                                 "%s (%s)" % (slug, suffix))
                self.assertEqual(set(meta) - set(none_meta), set(), "%s added recipes" % slug)

    def test_removed_is_unit_family_invariant(self):
        # Brief golden: units don't change feasibility — the METRIC payloads'
        # removed sets must be identical to the US payloads'.
        import sys
        sys.path.insert(0, HERE)
        import archive_catalog_profiles as A
        none_us = {m["recipe_id"] for m in json.load(open(os.path.join(ARCHIVE, "none-us6.json")))["variant_meta"]}
        none_m = {m["recipe_id"] for m in json.load(open(os.path.join(ARCHIVE, "none-m6.json")))["variant_meta"]}
        self.assertEqual(none_us, none_m)
        for rid, (slug, _label) in A.RESTRICTIONS.items():
            us = {m["recipe_id"] for m in json.load(open(os.path.join(ARCHIVE, slug + "-us6.json")))["variant_meta"]}
            m = {m["recipe_id"] for m in json.load(open(os.path.join(ARCHIVE, slug + "-m6.json")))["variant_meta"]}
            self.assertEqual(none_us - us, none_m - m, slug)


if __name__ == "__main__":
    raise SystemExit(unittest.main(verbosity=2))
