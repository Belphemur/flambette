#!/usr/bin/env python3
"""Golden tests for scripts/build_ciqual_nutrition.py (ADR-0054, locked L5).

Style follows scripts/test_extract_recipe_types.py: stdlib `unittest`, run
directly (`python3 scripts/test_build_ciqual_nutrition.py`) and wired into
`bun run test:unit`'s Python sibling by the same convention.

The point of these cases is to make "never fabricated" ENFORCEABLE. They pin:

  * the tolerant XML scanner against the grammar quirks CIQUAL actually ships
    (comma decimals, `<0,1` limits, `-` absence, a self-closing tag, the
    not-well-formed `<` that defeats ElementTree);
  * the audited nutrient-code map against the app's own NUTRITION_UNITS, so a
    unit drift fails here instead of printing "1048 g potassium";
  * the pancake's kcal against a number HAND-COMPUTED from the chosen CIQUAL
    rows, so a silent re-pointing of an alim_code is visible;
  * `--check`, the offline gate that refuses a hand-edited nutrition block.
"""

import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build_ciqual_nutrition as ciqual  # noqa: E402

TABLE_PATH = ciqual.OUT_PATH
USER_RECIPES = ciqual.USER_RECIPES

# The pancake's authored line items, verbatim from public/data/user_recipes.json.
# Duplicated here on purpose: the golden recomputes from THESE strings, so a
# change to the recipe has to be a deliberate edit to both.
PANCAKE_LINES = [
    ("400 g", "all-purpose flour"),
    ("35 g", "baking powder"),
    ("3 g", "salt"),
    ("50 g", "granulated sugar"),
    ("3 large eggs", "egg"),
    ("500 ml", "whole milk"),
    ("120 g", "butter, unsalted"),
    ("10 ml", "vanilla extract"),
]

# Hand arithmetic from the CIQUAL rows the mapping pins, per 100 g edible
# portion. Energy only — it is the number a reviewer can check with a
# calculator:
#
#   flour          400 g x 3.46 kcal/g          = 1384.00
#   baking powder   35 g x 1.3864 kcal/g        =   48.52   (Atwater-derived)
#   fine salt        3 g x 0.0000 kcal/g        =    0.00
#   granulated sugar 50 g x 3.992 kcal/g        =  199.60   (Atwater-derived)
#   eggs            150 g x 1.40 kcal/g         =  210.00   (3 x 50 g)
#   whole milk      500 g x 0.565 kcal/g        =  282.50
#   unsalted butter 120 g x 7.53 kcal/g         =  903.60
#   vanilla          10 g x 2.40 kcal/g         =   24.00
#                                    total      = 3052.22
#                              per serving (/8) =  381.53
#
# Salt contributes no calories (CIQUAL 11017 is 0 kcal — a REAL zero, not an
# absent value), which is exactly the kind of distinction a fabricated block
# gets wrong.
PANCAKE_TOTAL_KCAL = 3052.22
PANCAKE_SERVINGS = 8


def load_table():
    with open(TABLE_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def load_user_recipes():
    with open(USER_RECIPES, encoding="utf-8") as fh:
        return json.load(fh)


class ParseGrammar(unittest.TestCase):
    """The `teneur` / tag grammar, on strings taken from the real file."""

    def test_plain_number(self):
        self.assertEqual(ciqual.parse_teneur("346"), (346.0, "value"))

    def test_comma_decimal(self):
        # CIQUAL writes decimals with a COMMA ("56,5"); a thousands separator
        # never appears here, so a blind float() is wrong.
        self.assertEqual(ciqual.parse_teneur("56,5"), (56.5, "value"))

    def test_below_limit_keeps_the_published_bound(self):
        value, flag = ciqual.parse_teneur("< 0,2")
        self.assertEqual((value, flag), (0.2, "limit"))

    def test_dash_is_absent_not_zero(self):
        # `-` means CIQUAL has no value. Writing 0.0 instead would claim the
        # food "measured, contains none", which is a different claim.
        self.assertEqual(ciqual.parse_teneur("-"), (None, None))

    def test_real_zero_is_kept(self):
        self.assertEqual(ciqual.parse_teneur("0"), (0.0, "value"))

    def test_self_closing_tag_is_absent(self):
        block = "<teneur missing=\" \" />"
        self.assertIsNone(ciqual.field(block, "teneur"))

    def test_absent_is_absent(self):
        self.assertIsNone(ciqual.field("<other>1</other>", "teneur"))

    def test_not_well_formed_input_survives(self):
        # A raw `<` inside a value ("Panaché préemballé (<1° alc.)") is what
        # makes ElementTree unusable on this dataset; the scanner must not care.
        text = "<ALIM><alim_code> 1 </alim_code><alim_nom_fr>x (<1° alc.) y</alim_nom_fr></ALIM>"
        self.assertEqual(len(ciqual.blocks(text, "ALIM")), 1)
        self.assertEqual(ciqual.field(ciqual.blocks(text, "ALIM")[0], "alim_nom_fr"), "x (<1° alc.) y")

    def test_salt_is_a_real_zero(self):
        # The distinction that matters most for the pancake's headline number.
        table = load_table()
        self.assertEqual(table["foods"]["salt"]["per100g"]["energy"], 0.0)


class NutrientMap(unittest.TestCase):
    """The map is pinned to CIQUAL's own nutrient table and to the app's units."""

    def test_every_code_exists_in_this_release(self):
        # Only verifiable with the XML present; skipped otherwise so the suite
        # stays runnable offline (the committed artifact is the offline truth).
        source = ciqual.XML_SOURCE_DIR  # env CIQUAL_XML_DIR, default the cache dir
        if not os.path.exists(os.path.join(source, ciqual.FILES["const"])):
            self.skipTest("CIQUAL XML not available offline")
        labels = ciqual.nutrient_labels(ciqual.read_xml(os.path.join(source, ciqual.FILES["const"])))
        for name, code in ciqual.NUTRIENT_CODES.items():
            self.assertIn(str(code), labels, "%s -> %s absent from CIQUAL" % (name, code))

    def test_units_match_the_app(self):
        # Parse NUTRITION_UNITS out of the TS: a missing key or a g/mg mix-up
        # would print "1048 g potassium" in the facts modal.
        ts = open(os.path.join(REPO, "src", "lib", "nutrition.ts"), encoding="utf-8").read()
        block = re.search(r"export const NUTRITION_UNITS[^=]*=\s*\{(.*?)\n\}", ts, re.S)
        self.assertIsNotNone(block, "NUTRITION_UNITS table not found")
        units = dict(re.findall(r"(\w+):\s*'(kcal|g|mg|µg)'", block.group(1)))
        emitted = load_table()["provenance"]["units"]
        for name, code in ciqual.NUTRIENT_CODES.items():
            self.assertEqual(
                emitted.get(str(code)),
                units.get(name),
                "%s: CIQUAL unit != app NUTRITION_UNITS" % name,
            )
        for name, codes in ciqual.SUMMED_CODES.items():
            got = {emitted.get(str(c)) for c in codes}
            self.assertEqual(got, {units.get(name)}, "%s: summed unit mismatch" % name)

    def test_unpublished_keys_are_omitted_not_zeroed(self):
        # caffeine, transfats, choline and the 20 amino acids are not in CIQUAL.
        # A `0.0` for any of them is a fabricated measurement.
        table = load_table()
        forbidden = {
            "caffeine",
            "transfats",
            "choline",
            "alanine",
            "lysine",
            "tryptophan",
            "tyrosine",
        }
        for key, food in table["foods"].items():
            self.assertEqual(food["per100g"].keys() & forbidden, set(), key)

    def test_every_food_is_traceable(self):
        table = load_table()
        for key, food in table["foods"].items():
            self.assertTrue(food["alim_code"], key)
            self.assertTrue(food["choice"], "%s has no recorded choice" % key)
            self.assertIn(food["energy_source"], ("ciqual", "atwater"), key)
            # D is refused globally; a food may only carry it when the mapping
            # recorded WHY, and the artifact repeats that reason.
            if food["confidence"] == "D":
                self.assertTrue(
                    food.get("confidence_note"),
                    "%s admits a grade-D row with no recorded reason" % key,
                )
            else:
                self.assertIn(food["confidence"], ("A", "B", "C"), key)

    def test_confidence_d_is_refused_by_default(self):
        self.assertNotIn("D", ciqual.ACCEPTED_CONFIDENCE)
        # Only granulated sugar opts in, and only with a reason.
        admitting = [k for k, f in load_table()["foods"].items() if f["confidence"] == "D"]
        self.assertEqual(admitting, ["granulated sugar"])

    def test_sugars_are_on_the_apps_basis(self):
        # CIQUAL's `sucres` row excludes lactose (whole milk publishes none at
        # all), while the app's `sugars` is the sum of its six sugar sub-keys,
        # lactose included. Verified against the frozen catalog: a doc with
        # 2.31 g lactose reports sugars 20.94 against a sub-key sum of 20.09.
        foods = load_table()["foods"]
        parts = ("fructose", "galactose", "glucose", "lactose", "maltose", "sucrose")
        milk = foods["whole milk"]["per100g"]
        self.assertEqual(milk["sugars"], round(sum(milk.get(k, 0.0) for k in parts), 2))
        self.assertGreater(milk["sugars"], 3.0, "milk is not sugar-free")
        # A food that publishes CIQUAL's `sucres` total: the app's number is
        # that total PLUS the lactose CIQUAL excludes. Naively taking CIQUAL's
        # row (1.5) would understate flour by its own 0.1 g of lactose.
        flour = foods["all-purpose flour"]["per100g"]
        self.assertEqual(flour["sugars"], round(flour["sugars"], 2))
        self.assertGreater(flour["sugars"], 1.5)
        self.assertLessEqual(flour["sugars"], flour["carbs"])


class PancakeEnergy(unittest.TestCase):
    """The headline number, hand-computed above."""

    def setUp(self):
        self.table = load_table()
        self.doc = {
            "serving_count": PANCAKE_SERVINGS,
            "line_items": [
                {"quantity": q, "ingredient_name": n} for q, n in PANCAKE_LINES
            ],
        }

    def test_energy_matches_the_hand_computation(self):
        got = ciqual.recipe_nutrition(self.doc, self.table)
        expected = PANCAKE_TOTAL_KCAL / PANCAKE_SERVINGS
        self.assertAlmostEqual(
            got["energy"], expected, delta=0.05, msg="pancake kcal drifted from the hand total"
        )

    def test_energy_source_is_recorded(self):
        # CIQUAL publishes no energy for sugar or baking powder, so both rows
        # must SAY so. A silently derived number is indistinguishable from a
        # fabricated one once it is in the artifact.
        foods = self.table["foods"]
        self.assertEqual(foods["granulated sugar"]["energy_source"], "atwater")
        self.assertEqual(foods["baking powder"]["energy_source"], "atwater")
        self.assertEqual(foods["all-purpose flour"]["energy_source"], "ciqual")

    def test_fat_flour_is_not_self_raising(self):
        # The rejected shortcut: 9437 folds the leavening's sodium into the
        # flour, which would double-count it against the baking-powder line.
        self.assertEqual(self.table["foods"]["all-purpose flour"]["alim_code"], "9435")
        self.assertEqual(self.table["foods"]["baking powder"]["alim_code"], "11046")
        self.assertGreater(
            self.table["foods"]["baking powder"]["per100g"]["sodium"],
            1000,
            "the leavening's own sodium must be counted once, on the leavening",
        )

    def test_sodium_is_counted_from_both_salt_and_leavening(self):
        got = ciqual.recipe_nutrition(self.doc, self.table)
        # Every line contributes, in mg over the whole 8-serving batter:
        #   flour          400 g x     12 =     48
        #   baking powder   35 g x  14 200 =  4 970   <- the leavening's own sodium
        #   salt             3 g x  39 100 =  1 173
        #   eggs            150 g x    124 =    186
        #   whole milk      500 g x     79 =    395
        #   butter          120 g x     25 =     30
        #   sugar            50 g x   2.17 =      1.09
        #   vanilla          10 g x      4 =      0.4
        #                                 total = 6 803.49  ->  850.44 per serving
        # The point: dropping the leavening (the rejected self-raising-flour
        # shortcut) would report ~229 mg/serving and understate the salt load
        # by a third.
        foods = self.table["foods"]
        total = (
            400 * foods["all-purpose flour"]["per100g"]["sodium"] / 100
            + 35 * foods["baking powder"]["per100g"]["sodium"] / 100
            + 3 * foods["salt"]["per100g"]["sodium"] / 100
            + 150 * foods["egg"]["per100g"]["sodium"] / 100
            + 500 * foods["whole milk"]["per100g"]["sodium"] / 100
            + 120 * foods["butter, unsalted"]["per100g"]["sodium"] / 100
            + 50 * foods["granulated sugar"]["per100g"]["sodium"] / 100
            + 10 * foods["vanilla extract"]["per100g"]["sodium"] / 100
        )
        self.assertAlmostEqual(got["sodium"], total / PANCAKE_SERVINGS, delta=1.0)
        self.assertGreater(got["sodium"], 800)

    def test_granulated_sugar_is_not_reported_as_sugar_free(self):
        # The regression this pins: CIQUAL grades sucrose's sugars row D, and
        # the global D refusal used to drop it, which reported 0 g of sugar for
        # a recipe with 50 g of it in the batter. The FOOD row must still carry
        # sugars (the D admission is per-food, recorded), and the RECIPE block
        # now follows the coverage rule: vanilla extract dashes CIQUAL's
        # sugars row, so the recipe's sugars key is OMITTED rather than
        # summed from the foods that do publish it — and an omitted key is
        # what "unknown" looks like; a tiny partial sum would look like data.
        foods = self.table["foods"]
        self.assertEqual(foods["granulated sugar"]["per100g"]["sugars"], 99.8)
        got = ciqual.recipe_nutrition(self.doc, self.table)
        self.assertNotIn("sugars", got, "partial sugars total published as complete")
        # The same honesty pinned from the covered side: a key EVERY food
        # publishes still totals, and 50 g of sugar alone would dominate it.
        self.assertIn("carbs", got)
        self.assertGreater(got["carbs"], 40.0)

    def test_unconvertible_quantity_is_refused(self):
        doc = {
            "serving_count": 4,
            "line_items": [{"quantity": "3 pinches", "ingredient_name": "flour"}],
        }
        with self.assertRaises(SystemExit):
            ciqual.recipe_nutrition(doc, self.table)

    def test_unknown_ingredient_is_refused(self):
        doc = {
            "serving_count": 4,
            "line_items": [{"quantity": "10 g", "ingredient_name": "sriracha"}],
        }
        with self.assertRaises(SystemExit):
            ciqual.recipe_nutrition(doc, self.table)


class NameKeyParity(unittest.TestCase):
    """The mirror of src/lib/grocery.ts `nameKey`, spot-pinned."""

    def test_singularisation(self):
        cases = {
            "Tomatoes": "tomato",
            "eggs": "egg",
            "Berries": "berrie",
            "Potatoes": "potato",
            "Onions": "onion",
            "Flour": "flour",
            "  Whole Milk  ": "whole milk",
        }
        for raw, want in cases.items():
            self.assertEqual(ciqual.name_key(raw), want, raw)

    def test_matches_the_committed_food_keys(self):
        # Every key the committed table uses must be its own nameKey, i.e. the
        # mapping is keyed the way the grocery list resolves a line item.
        for key in load_table()["foods"]:
            self.assertEqual(ciqual.name_key(key), key)


class CommittedArtifact(unittest.TestCase):
    """The artifact and the recipe agree, and `--check` is the gate that says so."""

    def test_pancake_is_present(self):
        payload = load_user_recipes()
        docs = [r["doc"] for r in payload["recipes"]]
        names = [d.get("name", "") for d in docs]
        self.assertTrue(
            any("Pancake" in n for n in names),
            "the owner's pancake is missing from user_recipes.json (%r)" % names,
        )

    def test_check_gate_is_clean(self):
        proc = subprocess.run(
            [sys.executable, os.path.join(HERE, "build_ciqual_nutrition.py"), "--check"],
            capture_output=True,
            text=True,
            cwd=REPO,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("all user recipes match", proc.stdout)

    def test_id_band_is_reserved(self):
        payload = load_user_recipes()
        for entry in payload["recipes"]:
            self.assertGreaterEqual(entry["meta"]["id"], 900000, entry["meta"]["name"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
