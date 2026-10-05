#!/usr/bin/env python3
"""Author the household's first user recipe (ADR-0054) — the fluffy pancake.

A one-shot authoring helper, kept in the repo so the numbers in
`public/data/user_recipes.json` are REPRODUCIBLE and reviewable rather than
typed by hand. Re-run it after editing the prose here; it rewrites the entry
in place (idempotent).

    python3 scripts/add_user_recipe_pancake.py

Why a script at all, when the recipe is just JSON?

  * The `nutrition` block is DERIVED from the committed CIQUAL table
    (`build_ciqual_nutrition.recipe_nutrition`), including `meta.calories` and
    `meta.sodium_mg` which are PER SERVING (ADR-0004). A hand-typed block is
    exactly the fabrication ADR-0054 forbids, and it would drift from the
    table the moment an ingredient changed.
  * The `line_items` are the single source for both the nutrition derivation
    and the grocery list, so a quantity can never disagree with itself.

`addedAt` is passed in (the caller supplies the epoch ms) so re-running does
not silently move the NEW badge's 30-day window forward.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from build_ciqual_nutrition import recipe_nutrition, load_table  # noqa: E402

# ADR-0054 reserves the 900 000+ band for household recipes (the frozen
# catalog's highest id is 40 919), so a user id can never shadow a Mealime one.
VARIANT_ID = 900_001
RECIPE_ID = 900_001
# `recipe_id` is only used for display/lookup inside the app; the band keeps it
# out of the frozen catalog's own range (max 4433) for the same reason.
ADDED_AT_MS = 1_790_812_800_000  # 2026-10-01T00:00:00Z (the day the recipe was added)
STEM = "user_recipe_fluffy-pancake_fc1f294f"
IMAGE_BASE = "https://cdn-uploads.mealime.com/uploads/recipe/thumbnail/900/"

NAME = "Fluffy Pancakes"
SLUG = "fluffy-pancakes"
CATEGORY = "Breakfast"
COOKING_MINUTES = 25

# (quantity display string, ingredient_name). The names deliberately reuse the
# frozen catalog's spelling so the grocery list MERGES with the staples the
# household already buys instead of showing a second "flour" line, and so the
# CIQUAL table keys (which are nameKeys) resolve without a per-recipe map.
LINE_ITEMS = [
    ("400 g", "all-purpose flour"),
    ("35 g", "baking powder"),
    ("3 g", "salt"),
    ("50 g", "granulated sugar"),
    ("3 large eggs", "egg"),
    ("500 ml", "whole milk"),
    ("120 g", "butter, unsalted"),
    ("10 ml", "vanilla extract"),
]

# (primary_message, secondary_message | None). The secondary lines are the
# per-step measured amounts ADR-0022's cooking view reads; the "Pro Tips"
# bullets from the owner's markdown are folded into the steps they belong to
# rather than inventing a schema section the catalog does not have.
INSTRUCTIONS = [
    (
        "Prepare the buttermilk substitute, if using: combine the milk and the "
        "lemon juice or vinegar, then stand for 5 minutes to curdle slightly.",
        "500 ml whole milk\n40 ml lemon juice",
    ),
    (
        "Mix the dry ingredients: whisk together the flour, baking powder, salt "
        "and sugar.",
        "400 g all-purpose flour\n35 g baking powder\n3 g salt\n50 g granulated sugar",
    ),
    (
        "Combine the wet ingredients: whisk the eggs, then whisk in the milk (or "
        "the buttermilk substitute), the cooled melted butter and the vanilla.",
        "3 large eggs\n500 ml whole milk\n120 g butter, unsalted\n10 ml vanilla extract",
    ),
    (
        "Make the batter: pour the wet into the dry and fold gently until JUST "
        "combined. Lumpy is correct — overmixing makes tough pancakes.",
        None,
    ),
    (
        "Rest the batter for 5-10 minutes for maximum fluffiness.",
        None,
    ),
    (
        "Cook on medium-low heat on a lightly greased pan, about 60 ml of batter "
        "per pancake, about 2 minutes until bubbles appear and the edges set, "
        "then flip and cook 1-2 minutes more until golden.",
        "60 ml batter",
    ),
    (
        "Keep the cooked pancakes warm on a baking sheet in a 90C oven, and serve "
        "them straight away with butter, maple syrup and fresh fruit.",
        None,
    ),
]

COOKWARES = [
    {"id": 8, "name": "whisk", "slug": "whisk"},
    {"id": 2, "name": "chef's knife", "slug": "chefs-knife"},
    {"id": 6, "name": "frying pan", "slug": "frying-pan"},
    {"id": 10, "name": "baking sheet", "slug": "baking-sheet"},
]


def build_doc(nutrition):
    return {
        "id": VARIANT_ID,
        "recipe_id": RECIPE_ID,
        "serving_count": 8,
        "cooking_minutes": COOKING_MINUTES,
        "name": NAME,
        "slug": SLUG,
        "units": "Metric",
        "thumbnail_image_url": IMAGE_BASE + "thumbnail_" + STEM + ".jpeg",
        "presentation_image_url": IMAGE_BASE + "presentation_" + STEM + ".jpeg",
        "cookwares": COOKWARES,
        "instructions": [
            {"id": VARIANT_ID * 100 + i, "primary_message": p, "secondary_message": s}
            for i, (p, s) in enumerate(INSTRUCTIONS, start=1)
        ],
        "line_items": [
            {"id": VARIANT_ID * 1000 + i, "quantity": q, "ingredient_name": n}
            for i, (q, n) in enumerate(LINE_ITEMS, start=1)
        ],
        "nutrition": nutrition,
    }


def main() -> int:
    table = load_table()
    # Derive FIRST, from the line items above, so the block can never be a
    # transcription of a number someone computed by hand.
    nutrition = recipe_nutrition(build_doc({}), table)
    doc = build_doc(nutrition)

    energy = nutrition["energy"]
    sodium = nutrition["sodium"]
    # `macros` on the meta is the card's protein/carbs/fats line; it is
    # PER SERVING too, so it comes straight from the same derived block.
    meta = {
        "id": VARIANT_ID,
        "name": NAME,
        "is_pro": False,
        "is_secret": False,
        "macros": {
            "fats": nutrition["fat"],
            "carbs": nutrition["carbs"],
            "protein": nutrition["protein"],
        },
        # No invented stars: an unreviewed household recipe has no rating, and
        # `rating: 0` is what the catalog uses for an unrated variant.
        "rating": 0,
        "rating_count": 0,
        "popularity": {},
        "calories": energy,
        "sodium_mg": sodium,
        "cooking_minutes": COOKING_MINUTES,
        "serving_count": 8,
        "ingredient_names": [n for _q, n in LINE_ITEMS],
        # No variety tags: the tag ids are a Mealime taxonomy, and inventing one
        # would put the recipe in an overlap bucket it does not belong to.
        "variety_tag_ids": [],
        "price_per_serving": None,
        "thumbnail_image_url": doc["thumbnail_image_url"],
        "presentation_image_url": doc["presentation_image_url"],
        # The user recipe has no CDN document; the doc is embedded in
        # user_recipes.json and served from memory by getRecipe(). The empty
        # uuid is honest about that and is never fetched.
        "published_recipe_uuid": "",
        "recipe_id": RECIPE_ID,
        "first_published_at": ADDED_AT_MS,
        "ruleset": "breakfast",
    }

    data = {
        "category_name": CATEGORY,
        "boost": 0,
        "variety_tags": [],
        "perishable_amounts": {},
        "month_seasonalities": [],
        "recipe_id": RECIPE_ID,
    }

    entry = {
        "addedAt": ADDED_AT_MS,
        "source": "user",
        "meta": meta,
        "data": data,
        "doc": doc,
    }

    path = os.path.join(ROOT, "public", "data", "user_recipes.json")
    payload = {"version": 1, "recipes": []}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    recipes = [r for r in payload.get("recipes", []) if r.get("meta", {}).get("id") != VARIANT_ID]
    recipes.append(entry)
    recipes.sort(key=lambda r: r["meta"]["id"])
    payload["version"] = 1
    payload["recipes"] = recipes

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    print("wrote %s" % os.path.relpath(path, ROOT))
    print("  %s (id %d, %d servings)" % (NAME, VARIANT_ID, doc["serving_count"]))
    print("  derived per serving: %.1f kcal, %.1f g protein, %.1f g carbs, %.1f g fat"
          % (energy, nutrition["protein"], nutrition["carbs"], nutrition["fat"]))
    print("  derived per serving: %.1f mg sodium, fibre %.1f g, sugars %.1f g"
          % (sodium, nutrition["fiber"], nutrition["sugars"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
