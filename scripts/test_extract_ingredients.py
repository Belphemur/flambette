#!/usr/bin/env python3
"""Golden tests for scripts/extract_ingredients.py (ADR-0012, ADR-0052).

ADR-0052 adds a hand-authored SUPPLEMENTAL table to a build that was, until
then, a pure census of what the frozen catalog happens to buy. The property
worth pinning is therefore not a row count but the INVARIANT that makes the
table safe: a supplemental row is a FILLER, never an override. These goldens
assert exactly that, plus the taxonomy and the dietary gap that motivated the
table, so the next person who widens it cannot quietly shadow a recipe
ingredient.

    python3 scripts/test_extract_ingredients.py
"""

import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public/data/ingredients.json")

_spec = importlib.util.spec_from_file_location(
    "extract_ingredients", os.path.join(HERE, "extract_ingredients.py")
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


def catalog_name_keys():
    """Every nameKey the frozen catalog produces, straight from the docs."""
    from catalog_paths import recipe_doc_paths

    keys = set()
    for path in recipe_doc_paths(ROOT):
        with open(path) as f:
            doc = json.load(f)
        for li in doc.get("line_items") or []:
            key = mod.name_key(li["ingredient_name"])
            if key:
                keys.add(key)
    return keys


class SupplementalTable(unittest.TestCase):
    """Hand-authored rows are only safe if they are internally consistent."""

    def test_every_row_names_a_real_store_section(self):
        # A typo'd category would file an item under a section the
        # FilterDropdown cannot even render — fail at build time instead.
        valid = set(mod.SECTIONS)
        bad = sorted({c for _n, c in mod.SUPPLEMENTAL if c not in valid})
        self.assertEqual(bad, [], "unknown store section(s): %s" % bad)

    def test_no_duplicate_display_names(self):
        from collections import Counter

        dupes = sorted(k for k, v in Counter(n.strip().lower() for n, _ in mod.SUPPLEMENTAL).items() if v > 1)
        self.assertEqual(dupes, [], "duplicate row(s) in SUPPLEMENTAL: %s" % dupes)

    def test_no_two_rows_share_a_namekey(self):
        # Two rows on one nameKey mean the second is dead code and the
        # suggestion order depends on list position — pure luck.
        from collections import Counter

        dupes = sorted(k for k, v in Counter(mod.name_key(n) for n, _ in mod.SUPPLEMENTAL).items() if v > 1)
        self.assertEqual(dupes, [], "two SUPPLEMENTAL rows share nameKey: %s" % dupes)

    def test_no_row_shadows_a_catalog_ingredient(self):
        # The load-bearing invariant. A row whose nameKey the catalog already
        # produces is SKIPPED by the merge, so keeping it in the table is
        # misleading: it reads like it configures that ingredient when it
        # silently does nothing.
        catalog = catalog_name_keys()
        shadowing = sorted(
            n for n, _ in mod.SUPPLEMENTAL if mod.name_key(n) in catalog
        )
        self.assertEqual(
            shadowing, [],
            "SUPPLEMENTAL row already in the catalog (would be skipped): %s" % shadowing,
        )


class DietaryCoverage(unittest.TestCase):
    """Why ADR-0052 exists: the catalog cannot express these substitutions."""

    def test_the_catalog_names_no_dietary_alternative_at_all(self):
        # The negative finding that motivated a hand-authored table. If a
        # future catalog refresh adds real gluten-free/lactose-free recipes,
        # these land as CATALOG rows and this test flips loudly, at which
        # point the table shrinks instead of shadowing the real ingredient.
        raw = " ".join(catalog_name_keys())
        for absent in ("gluten", "lactose", "dairy-free", "oat milk", "soy milk", "xanthan"):
            self.assertNotIn(absent, raw, "catalog now names %r — reconsider SUPPLEMENTAL" % absent)


class TestIndexOutput(unittest.TestCase):
    """Assertions on the COMMITTED artifact the client actually imports.

    These read `public/data/ingredients.json` as it sits on disk. They
    deliberately do NOT call `mod.main()` to refresh it first: a golden that
    regenerates its own subject passes against a stale or truncated committed
    file, and the build and the release both consume the committed one (Qodo
    caught exactly that on PR #48). Staleness is the separate job of
    `test_the_committed_index_is_not_stale`, which compares a fresh build
    against the file instead of overwriting it.
    """

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(OUT):
            raise AssertionError("%s missing — run `bun run data:ingredients`" % OUT)
        with open(OUT) as f:
            cls.doc = json.load(f)
        cls.by_key = {i["nameKey"]: i for i in cls.doc["ingredients"]}

    def test_the_committed_index_is_not_stale(self):
        # The gate that matters most: a fresh build must MATCH what is
        # committed. `--check` is the same assertion in script form (and is
        # what CI runs); calling main() here would silently repair the file
        # and make this test unfailable.
        committed = {k: v for k, v in self.doc.items() if k != "generatedAt"}
        fresh = {k: v for k, v in mod.build().items()
                 if k not in ("generatedAt", "_summary")}
        self.assertEqual(
            fresh, committed,
            "committed ingredients.json is stale — re-run `bun run data:ingredients`",
        )

    def test_count_matches_the_row_list(self):
        self.assertEqual(self.doc["count"], len(self.doc["ingredients"]))

    def test_namekeys_are_unique_and_sorted(self):
        keys = [i["nameKey"] for i in self.doc["ingredients"]]
        self.assertEqual(len(set(keys)), len(keys))
        self.assertEqual(keys, sorted(keys))

    def test_every_row_carries_a_valid_store_section(self):
        valid = set(mod.SECTIONS)
        bad = sorted({i["category"] for i in self.doc["ingredients"] if i["category"] not in valid})
        self.assertEqual(bad, [], "rows with an unknown section: %s" % bad)

    def test_every_supplemental_row_is_present_in_the_output(self):
        # Zero skipped is the merge behaving as designed; a skip would mean
        # the catalog grew a conflicting nameKey.
        catalog = catalog_name_keys()
        for name, _cat in mod.SUPPLEMENTAL:
            key = mod.name_key(name)
            self.assertNotIn(key, catalog, "%s became a catalog ingredient" % name)
            self.assertIn(key, self.by_key, "SUPPLEMENTAL row %r missing from output" % name)

    def test_supplemental_rows_carry_no_invented_unit(self):
        # No observed quantity exists for these, so no purchase format is
        # reported. A fabricated "(1 L) cartons" would render as advice the
        # app cannot honour.
        for name, _cat in mod.SUPPLEMENTAL:
            self.assertIsNone(self.by_key[mod.name_key(name)]["unit"], "%s invented a unit" % name)

    def test_dietary_alternatives_are_searchable_by_name(self):
        # nameKey values, NOT display names: nameKey singularizes, so the row
        # the user searches for ("gluten-free breadcrumbs") is stored under
        # "gluten-free breadcrumb". That is correct — it is what makes a
        # grocery line for it MERGE with the same item typed in another form.
        for expected in (
            "gluten-free bread flour",
            "gluten-free breadcrumb",
            "gluten-free pasta",
            "gluten-free tamari",
            "lactose-free milk",
            "lactose-free butter",
            "lactose-free cheese",
            "dairy-free yogurt",
            "dairy-free chocolate",
            "oat milk",
            "pea milk",
            "cashew milk",
            "coconut milk beverage",
            "vegan butter",
            "xanthan gum",
        ):
            self.assertIn(expected, self.by_key, "%r is not in the index" % expected)

    def test_substitutes_file_beside_what_they_substitute(self):
        # The category is what files an item into the section the user then
        # shops by, so a GF flour sitting in Bakery is a real defect — and so
        # is one flour split across two aisles.
        for key, section in (
            ("gluten-free bread flour", "Baking & Spices"),
            ("gluten-free bread", "Bakery"),
            ("gluten-free pasta", "Pasta & Sauces"),
            ("oat milk", "Dairy, Cheese & Eggs"),
            ("chicken stock", "Canned & Jarred Goods"),
        ):
            self.assertEqual(self.by_key[key]["category"], section, "%r filed wrongly" % key)

    def test_every_flour_sits_in_one_aisle(self):
        # Raised in PR #48 review: plain "oat flour" sat in Rice, Grains &
        # Beans while "gluten-free oat flour" sat in Baking & Spices, so the
        # two halves of one product were shoppable in different aisles. Any
        # name ending in "flour" belongs beside the other flours.
        flours = {k: v["category"] for k, v in self.by_key.items()
                  if k.endswith("flour") and "flour blend" not in k}
        self.assertTrue(flours, "no flours in the index — the check is vacuous")
        wrong = {k: c for k, c in flours.items() if c != "Baking & Spices"}
        self.assertEqual(wrong, {}, "flour outside Baking & Spices: %s" % wrong)

    def test_no_typo_slips_into_the_shipped_index(self):
        # PR #48 review: the row ("celiac seed", ...) shipped a typo that
        # matched no catalog key, so it passed every "is this a real gap"
        # check and landed in the artifact as an autocomplete suggestion. A
        # misspelling is unfalsifiable by construction — nothing in the catalog
        # contradicts it — so it needs an explicit denylist.
        for typo in ("celiac seed", "celiac", "gluteen free", "lactosey",
                     "gluten free bread", "oatmilk", "almond milk powder-free"):
            self.assertNotIn(typo, self.by_key, "%r is a typo that shipped" % typo)

    def test_spice_aisle_rows_are_seeds_not_stalks(self):
        # 'celery seed' is a dried spice; 'celery' is already a catalog row in
        # Produce, and 'celeriac' is its own vegetable. All three must coexist
        # without collapsing into each other.
        self.assertEqual(self.by_key["celery seed"]["category"],
                         "Oils, Sauces & Condiments")
        self.assertIn("celery", self.by_key)
        self.assertEqual(self.by_key["celery"]["category"], "Produce")

    def test_no_inedible_row_reaches_the_index(self):
        # Raised in PR #48 review: silica gel (a packet desiccant) was
        # authored into the baking aisle and would be offered to a shopper
        # typing "sil". A grocery list is food; keep it food.
        for inedible in ("silica gel", "silica", "desiccant", "oxygen absorber"):
            self.assertNotIn(inedible, self.by_key, "%r is not food" % inedible)

    def test_the_build_is_idempotent(self):
        # build() must be a pure function of the catalog + the table: same
        # input, same rows. (A non-idempotent merge would silently duplicate
        # suggestions on every catalog refresh.) Compare CONTENT, not the
        # `generatedAt` stamp, which is a fresh timestamp by design.
        strip = lambda d: {k: v for k, v in d.items()
                           if k not in ("generatedAt", "_summary")}
        self.assertEqual(strip(mod.build()), strip(mod.build()))


if __name__ == "__main__":
    raise SystemExit(unittest.main(verbosity=2))