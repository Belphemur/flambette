#!/usr/bin/env python3
"""Golden extraction cases for extract_timer_hints.py (ADR-0041 §3).

Stdlib unittest, no fixtures on disk: the goldens run through
`hint_from_text` / `extract_recipe` on in-memory authored text. Run with:

    python3 scripts/test_extract_timer_hints.py
"""

import importlib.util
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "extract_timer_hints", os.path.join(os.path.dirname(__file__), "extract_timer_hints.py")
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


class HintFromText(unittest.TestCase):
    def assert_seconds(self, text, step_number, step, seconds, label, high=None):
        hint = mod.hint_from_text(text, step_number)
        self.assertIsNotNone(hint, text)
        self.assertEqual(hint["step"], step)
        self.assertEqual(hint["seconds"], seconds)
        self.assertEqual(hint["label"], label)
        if high is None:
            self.assertNotIn("range", hint)
        else:
            self.assertEqual(hint["range"], [seconds, high])

    def test_plain_minutes(self):
        self.assert_seconds("Simmer the rice for 12 minutes, then rest.", 4, 3, 720, "Rice")

    def test_baked_range_keeps_both_bounds_in_seconds(self):
        self.assert_seconds("Bake 20-25 min until golden.", 2, 1, 1200, "Step 2", high=1500)

    def test_hours(self):
        self.assert_seconds("Cover and chill for 2 hours.", 1, 0, 7200, "Step 1")

    def test_seconds_dropped_below_the_minute_floor(self):
        # "15-30 seconds" cannot honestly feed a minutes preset.
        self.assertIsNone(mod.hint_from_text("Stir and cook until fragrant, 15-30 seconds.", 1))

    def test_over_six_hours_dropped_never_clamped(self):
        # A 24-hour marinade exceeds MAX_TIMER_SECONDS: dropping it is the
        # no-fabrication rule; clamping would invent "6 hours".
        self.assertIsNone(mod.hint_from_text("Marinate up to 24 hours.", 1))

    def test_compound_fraction_refused(self):
        self.assertIsNone(mod.hint_from_text("Proof the dough 1 ½ hours.", 1))

    def test_food_label_takes_the_first_whole_word_in_the_sentence(self):
        self.assert_seconds("Add shrimp and cook until pink, 2-3 minutes.", 7, 6, 120, "Shrimp", high=180)

    def test_fallback_label_is_step_number(self):
        self.assert_seconds("Cook until liquid is absorbed, 15-18 minutes.", 1, 0, 900, "Step 1", high=1080)

    def test_only_one_hint_per_step_first_duration_wins(self):
        self.assert_seconds("Boil 5 minutes. Then simmer for 10 minutes more.", 3, 2, 300, "Step 3")

    def test_no_duration_no_hint(self):
        self.assertIsNone(mod.hint_from_text("Wash and dry the fresh produce.", 1))
        self.assertIsNone(mod.hint_from_text("1 ½ cups basmati rice", 1))

    def test_to_phrase_range(self):
        self.assert_seconds("Bake for 20 to 25 minutes.", 5, 4, 1200, "Step 5", high=1500)


class ExtractRecipe(unittest.TestCase):
    def test_scans_prose_then_measured_lines_one_hint_per_step(self):
        doc = {
            "instructions": [
                {"primary_message": "Rinse rice. Cook until absorbed, 15-18 minutes.", "secondary_message": "1 ½ cups basmati rice"},
                {"primary_message": "Wash and dry the produce.", "secondary_message": "Simmer the sauce for 10 minutes\n2 tbsp oil"},
            ]
        }
        hints = mod.extract_recipe(doc)
        self.assertEqual(
            hints,
            [
                {"step": 0, "seconds": 900, "label": "Step 1", "range": [900, 1080]},
                {"step": 1, "seconds": 600, "label": "Sauce"},
            ],
        )

    def test_recipe_with_zero_hints_is_empty_list(self):
        doc = {"instructions": [{"primary_message": "Wash and dry the fresh produce.", "secondary_message": "3 cups kale"}]}
        self.assertEqual(mod.extract_recipe(doc), [])


if __name__ == "__main__":
    unittest.main()
