#!/usr/bin/env python3
"""Golden tests for scripts/extract_recipe_types.py (ADR-0043).

The occasion taxonomy is the catalog's OWN `variant_meta[].ruleset` field, so
these goldens assert the field is really present and that our table stays a
faithful count of it. There is no keyword lens to drift — either the field is
there or the feature is dead, and the goldens say which.

    python3 scripts/test_extract_recipe_types.py
"""

import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public/data/recipe_types.json")
BUILDER = os.path.join(ROOT, "public/data/builder_data.json")

_spec = importlib.util.spec_from_file_location(
    "extract_recipe_types", os.path.join(HERE, "extract_recipe_types.py")
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


def builder():
    with open(BUILDER) as f:
        return json.load(f)


class Table(unittest.TestCase):
    def test_offers_five_meals_and_keeps_cpg_out_of_the_dropdown(self):
        self.assertEqual([r[1] for r in mod.TABLE], ["Breakfast", "Dessert", "Snack", "Simple", "Dinner"])
        self.assertEqual([r[0] for r in mod.TABLE], [-1, -2, -3, -4, -5])
        # cpg is Mealime's product-placement bucket, not a meal.
        self.assertEqual([r[3] for r in mod.NON_OCCASION], ["cpg"])
        self.assertNotIn(-6, mod.OFFERED_IDS)

    def test_ids_never_collide_with_a_catalog_variant_id(self):
        # Every catalog variant id is positive; the occasion space is negative.
        for tid, _label, _icon, _rs in mod.ALL_ROWS:
            self.assertLess(tid, 0)

    def test_each_offered_bucket_names_a_real_ruleset_value(self):
        for _tid, _label, _icon, ruleset in mod.TABLE:
            self.assertIn(ruleset, {"breakfast", "dessert", "snack", "simple", "dinner"})


class SourceField(unittest.TestCase):
    """The taxonomy is catalog truth — if the field vanishes, fail loudly."""

    def test_every_variant_carries_ruleset(self):
        missing = [m["id"] for m in builder()["variant_meta"] if "ruleset" not in m]
        self.assertEqual(missing, [], "%d variants lost the ruleset field" % len(missing))

    def test_no_unmapped_ruleset_value_appeared(self):
        known = {row[3] for row in mod.ALL_ROWS}
        seen = {m["ruleset"] for m in builder()["variant_meta"]}
        self.assertEqual(seen - known, set(), "unmapped ruleset value(s): %s" % (seen - known))

    def test_breakfast_count_matches_the_mealime_app(self):
        # The owner's app reports 151 breakfast recipes; that IS this field.
        self.assertEqual(mod.build()["byId"]["-1"]["count"], 151)


class Output(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rc = mod.main()
        assert rc == 0, "builder exited %s" % rc
        with open(OUT) as f:
            cls.doc = json.load(f)

    def test_rows_carry_their_ruleset_source(self):
        expected = {"-1": "breakfast", "-2": "dessert", "-3": "snack",
                    "-4": "simple", "-5": "dinner", "-6": "cpg"}
        for key, row in self.doc["byId"].items():
            self.assertEqual(row["ruleset"], expected[key])

    def test_offered_flag_marks_exactly_the_five_meals(self):
        offered = sorted(k for k, v in self.doc["byId"].items() if v["offered"])
        self.assertEqual(offered, ["-1", "-2", "-3", "-4", "-5"])

    def test_buckets_partition_the_feasible_catalog(self):
        bd = builder()
        total = len(bd["feasible_variants"])
        s = sum(v["count"] for v in self.doc["byId"].values())
        self.assertEqual(s + self.doc["unmatched"], total, "%d + %d != %d" % (s, self.doc["unmatched"], total))

    def test_nothing_is_unmatched(self):
        self.assertEqual(self.doc["unmatched"], 0)

    def test_dinner_is_the_largest_bucket(self):
        counts = {k: v["count"] for k, v in self.doc["byId"].items()}
        self.assertEqual(counts[max(counts, key=lambda k: counts[k])], counts["-5"])

    def test_every_offered_chip_would_render_non_empty(self):
        for row in self.doc["byId"].values():
            if row["offered"]:
                self.assertGreater(row["count"], 1, "%s would render an empty chip" % row["label"])

    def test_display_order_is_breakfast_to_dinner_then_the_excluded_bucket(self):
        self.assertEqual(self.doc["order"], [-1, -2, -3, -4, -5, -6])

    def test_check_mode_is_idempotent(self):
        self.assertEqual(mod.main(), 0)


if __name__ == "__main__":
    raise SystemExit(unittest.main(verbosity=2))
