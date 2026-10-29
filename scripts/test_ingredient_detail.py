#!/usr/bin/env python3
"""
Golden tests for the committed ingredient detail artifact
(public/data/ingredient_detail.json — issue #101 data slice).

Reads the COMMITTED artifact only — never regenerates it (the regeneration
inputs live partly OUTSIDE the repo: raw PNGs under mealime-media/, and the
fetch must never need the network in a goldens run). Derivation freshness is
the separate local gate `fetch_ingredient_images.py --check` (dev-time, needs
the raw archive).

Asserts, offline:
- the fused shape parses and its counts are self-consistent
- every `image` path exists under public/ and is a real, non-trivial webp
- ZERO remote URLs anywhere in the entries — images are served by the app
  as optimized webp, never from the outside (owner directive, 2026-10-28)
- every `substitutes` row byte-matches the curated table
  (scripts/ingredient_substitutions.json) — the artifact is a FUSION, so a
  table edit must flow through the generator, never hand-edited in the
  artifact
- every entry key is a real grocery-index nameKey (the 871-row index is the
  closed universe; the artifact can never invent one)
- no orphan webp in public/img/ingredients (the artifact is the ONLY
  legitimate referent)

Wire into CI via `bun run test:data` (package.json).
"""

import json
import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(BASE, "public", "data", "ingredient_detail.json")
SUBS_TABLE = os.path.join(BASE, "scripts", "ingredient_substitutions.json")
INDEX = os.path.join(BASE, "public", "data", "ingredients.json")
IMG_DIR = os.path.join(BASE, "public", "img", "ingredients")


class IngredientDetailGoldens(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(ARTIFACT) as f:
            cls.artifact = json.load(f)
        with open(SUBS_TABLE) as f:
            cls.subs = json.load(f)["substitutions"]
        with open(INDEX) as f:
            cls.index_keys = {
                row["nameKey"] for row in json.load(f)["ingredients"]
            }
        cls.entries = cls.artifact["entries"]

    def test_shape_counts_self_consistent(self):
        self.assertGreater(self.artifact["count"], 0)
        self.assertEqual(self.artifact["count"], len(self.entries))
        self.assertEqual(
            self.artifact["withImages"],
            sum(1 for e in self.entries.values() if "image" in e),
        )
        self.assertEqual(
            self.artifact["withSubstitutes"],
            sum(1 for e in self.entries.values() if "substitutes" in e),
        )
        # Every entry carries at least one of the two fields.
        for nk, e in self.entries.items():
            self.assertTrue(
                "image" in e or "substitutes" in e,
                f"empty entry for {nk}",
            )

    def test_every_entry_key_is_a_real_index_nameKey(self):
        stray = set(self.entries) - self.index_keys
        self.assertEqual(stray, set(), f"entries with unknown nameKeys: {sorted(stray)[:10]}")

    def test_zero_remote_urls_images_served_by_the_app(self):
        # Owner directive: images are served by the app as optimized webp,
        # NEVER from the outside. The artifact stores local paths only —
        # asserted over the WHOLE artifact (entries, source, license).
        self.assertNotIn("http", json.dumps(self.artifact), "remote URL somewhere in the artifact")

    def test_image_files_exist_and_are_real_webp(self):
        for nk, e in self.entries.items():
            if "image" not in e:
                continue
            path = os.path.join(BASE, "public", e["image"])
            self.assertTrue(os.path.exists(path), f"missing webp for {nk}: {e['image']}")
            size = os.path.getsize(path)
            self.assertGreater(size, 500, f"truncated webp for {nk}: {e['image']}")
            self.assertTrue(e["image"].endswith(".webp"), f"non-webp image for {nk}")

    def test_no_orphan_webp(self):
        referenced = {
            e["image"].split("/")[-1] for e in self.entries.values() if "image" in e
        }
        on_disk = set(os.listdir(IMG_DIR))
        self.assertEqual(on_disk - referenced, set(), "orphan webp files not referenced by the artifact")

    def test_substitutes_rows_byte_match_the_curated_table(self):
        for nk, e in self.entries.items():
            if "substitutes" not in e:
                continue
            self.assertIn(nk, self.subs, f"substitutes row not in curated table: {nk}")
            self.assertEqual(
                e["substitutes"],
                self.subs[nk]["subs"],
                f"substitutes drift for {nk} — edit scripts/ingredient_substitutions.json "
                "and re-run the generator, never the artifact",
            )
        # And the table is fully represented: every table row with a nameKey
        # in the index appears in the artifact.
        for nk in self.subs:
            if nk in self.index_keys:
                self.assertIn(nk, self.entries, f"curated row missing from artifact: {nk}")

    def test_attribution_recorded(self):
        # TheMealDB attribution rides the artifact (the detail sheet renders
        # it — owner directive) and the source is named.
        self.assertIn("TheMealDB", self.artifact["source"])
        self.assertTrue(self.artifact["license"].strip())


if __name__ == "__main__":
    unittest.main()
