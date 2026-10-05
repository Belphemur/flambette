#!/usr/bin/env python3
"""
Ingredient-index extractor for the offline ingredient autocomplete (ADR-0012,
widened by ADR-0052).

Walks the frozen local catalog (public/data/recipes/*.json, 2,759 docs) and
produces public/data/ingredients.json — one row per distinct ingredient
nameKey with its store category and the most common purchase unit.

Data properties:
- The catalog carries NO store-section data, so the category is the app's own
  bucketFor heuristic (src/lib/sections.ts) applied per line item and
  majority-voted per nameKey; "Other" when nothing matched. The 17 ingredients
  of the bundled user_data.json current_meal_plan snapshot carry REAL Mealime
  section_ids — where a snapshot nameKey matches a catalog nameKey, the
  snapshot's section wins (authoritative over the heuristic).
- The unit is the observed majority unit per nameKey, normalized with the
  same unitKey rule as grocery aggregation, keeping the FIRST-SEEN spelling
  for display (mirrors UnitSum display in grocery.ts). Unparseable quantities
  ("3 (398 ml) cans") don't parse in the app either, so they contribute no
  unit.
- nameKey must stay in lockstep with src/lib/grocery.ts nameKey() so index
  matches merge exactly like grocery lines. Verify after touching either
  side by re-running this script and comparing counts.

ADR-0052 — SUPPLEMENTAL ENTRIES. A pure catalog walk can only ever suggest
ingredients some Mealime recipe already buys, so the index was unusable for a
household that swaps an item out: the catalog names 349 distinct ingredients
and ZERO of them are gluten-free, lactose-free or dairy-free (censused over
all 2,759 docs: no `gluten`, `lactose`, `dairy-free`, `oat milk`, `soy milk`,
`xanthan`, `bouillon` or `stock` line item anywhere). SUPPLEMENTAL below is a
curated, HAND-AUTHORED table of those purchaseable substitutes plus common
pantry staples the recipes happen not to name. Each row states its category
EXPLICITLY: bucketFor() is a first-match keyword lens tuned for authored
recipe prose, and it misreads several of these ("gluten-free bread flour" ->
Bakery on `bread`, "pea milk" -> Produce on `pea`, "potato starch" -> Produce
on `potato"), so the table does not lean on it.

Merge precedence, in order: snapshot override > catalog majority vote >
SUPPLEMENTAL row. A supplemental row is therefore a FILLER — it only lands on
a nameKey no recipe uses — so re-adding "oat milk" can never shadow a real
recipe ingredient or its observed unit/category. Keeping the table a pure
filler is what lets the catalog stay authoritative instead of introducing a
second source of truth that could contradict it.

Stdlib only; idempotent; no network. Re-run with:
    python3 scripts/extract_ingredients.py
"""

import collections
import glob

from catalog_paths import recipe_doc_paths
import json
import os
import re
import sys
from datetime import datetime

# ---------------------------------------------------------------------------
# TS-parity helpers (mirror src/lib/grocery.ts / src/lib/quantity.ts)
# ---------------------------------------------------------------------------

UNICODE_FRACTIONS = {
    "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
    "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
}

FRACTION_RE = re.compile(f"^[{''.join(UNICODE_FRACTIONS)}]+")
ASCII_FRACTION_RE = re.compile(r"^(\d+)/(\d+)")
NUM_RE = re.compile(r"^\d+(?:[.,]\d+)?")


def parse_quantity(raw: str):
    """Mirror of parseQuantity() in src/lib/quantity.ts. -> (amount, unit)|None"""
    s = raw.strip()
    if not s:
        return None
    amount = 0.0
    matched = False
    m = NUM_RE.match(s)
    if m:
        amount = float(m.group(0).replace(",", "."))
        s = s[m.end():]
        matched = True
    s = s.lstrip()
    ascii_m = ASCII_FRACTION_RE.match(s)
    if ascii_m:
        amount += int(ascii_m.group(1)) / int(ascii_m.group(2))
        s = s[ascii_m.end():]
        matched = True
    else:
        uni = FRACTION_RE.match(s)
        if uni:
            for ch in uni.group(0):
                amount += UNICODE_FRACTIONS.get(ch, 0)
            s = s[uni.end():]
            matched = True
    if not matched:
        return None
    return amount, s.strip()


def name_key(name: str) -> str:
    """Mirror of nameKey() in src/lib/grocery.ts."""
    s = name.strip().lower()
    if len(s) > 3 and s.endswith("oes"):
        s = s[:-2]
    elif len(s) > 4 and s.endswith(("ses", "xes", "zes", "ches", "shes")):
        s = s[:-2]
    elif len(s) > 3 and s.endswith("s"):
        s = s[:-1]
    return s


def unit_key(unit: str) -> str:
    """Mirror of the private unitKey() in src/lib/grocery.ts."""
    u = unit.strip().lower()
    if len(u) > 3 and u.endswith("es"):
        u = u[:-2]
    if len(u) > 2 and u.endswith("s"):
        u = u[:-1]
    return u


# ---------------------------------------------------------------------------
# bucketFor port (src/lib/sections.ts) — first-match keyword table
# ---------------------------------------------------------------------------

SECTIONS = [
    "Produce", "Deli & Specialty Cheese", "Bakery", "Meat & Seafood",
    "Dairy, Cheese & Eggs", "Breakfast", "Coffee & Tea", "Nut Butters, Honey & Jams",
    "Baking & Spices", "Rice, Grains & Beans", "Canned & Jarred Goods",
    "Pasta & Sauces", "Oils, Sauces & Condiments", "International", "Frozen",
    "Snacks", "Nuts, Seeds & Dried Fruit", "Candy", "Beverages",
    "Wine, Beer & Spirits", "Personal Care", "Health", "Baby", "Household",
    "Kitchen", "Cleaning Products", "Pet Care", "Party", "Floral",
    "Customer Service", "Other",
]

HEURISTIC = [
    ("Frozen", ["frozen"]),
    ("Bakery", [
        "bread", "bun", "brioche", "bagel", "baguette", "pita", "tortilla", "naan",
        "flatbread", "croissant", "english muffin", "ciabatta", "focaccia",
        "crouton", "toast", "roll",
    ]),
    ("Baking & Spices", [
        "black pepper", "peppercorn", "salt", "cinnamon", "cumin", "paprika",
        "turmeric", "curry powder", "chili powder", "chilli powder", "vanilla",
        "cocoa", "chocolate", "cornstarch", "cornflour", "baking powder",
        "baking soda", "yeast", "nutmeg", "cardamom", "cloves", "allspice",
        "garam masala", "sumac", "za’atar", "bay leaf", "flour", "sugar",
        "spice",
    ]),
    ("Oils, Sauces & Condiments", [
        "olive oil", "oil", "vinegar", "soy sauce", "fish sauce", "hot sauce",
        "sriracha", "mustard", "ketchup", "mayo", "mayonnaise", "maple syrup",
        "worcestershire", "salsa", "dressing", "vinaigrette", "teriyaki",
        "hoisin", "oyster sauce", "gochujang", "harissa", "tahini",
        "hot honey",
    ]),
    ("Nut Butters, Honey & Jams", [
        "peanut butter", "almond butter", "nut butter", "cashew butter",
        "sunflower butter", "honey", "jam", "jelly", "marmalade", "preserves",
    ]),
    ("Pasta & Sauces", [
        "pasta", "spaghetti", "penne", "macaroni", "fusilli", "linguine",
        "fettuccine", "rigatoni", "tagliatelle", "noodles", "ramen", "udon",
        "soba", "gnocchi", "lasagne", "lasagna", "orzo", "ravioli",
        "tortellini", "marinara", "alfredo sauce", "pasta sauce",
    ]),
    ("Canned & Jarred Goods", [
        "canned", "tin of", "can of", "passata", "capers", "olive", "pickle",
        "cornichon", "tomato paste", "artichoke hearts", "coconut milk",
        "sun-dried tomato", "broth", "stock", "chipotle", "chipotles",
    ]),
    ("Rice, Grains & Beans", [
        "rice", "quinoa", "couscous", "barley", "bulgur", "farro", "millet",
        "oats", "oatmeal", "porridge", "lentil", "chickpea", "cannellini",
        "black beans", "kidney beans", "pinto", "navy beans", "polenta",
        "grits", "buckwheat", "freekeh", "dried beans", "black-eyed pea",
    ]),
    ("Produce", [
        # legume-adjacent produce first (checked before generic bean words)
        "green bean", "string bean", "snap pea", "snow pea", "sugar pea",
        "edamame",
        "onion", "scallion", "spring onion", "shallot", "leek", "garlic",
        "ginger", "bell pepper", "green pepper", "red pepper", "orange pepper",
        "yellow pepper", "jalapeño", "jalapeno", "chili", "chilli",
        "pepper", "tomato", "tomatillo", "carrot", "celery", "lettuce",
        "spinach", "kale", "cabbage", "broccoli", "broccolini", "cauliflower",
        "cucumber", "zucchini", "courgette", "eggplant", "aubergine", "potato",
        "sweet potato", "yam", "mushroom", "cilantro", "coriander", "parsley",
        "basil", "mint", "thyme", "rosemary", "oregano", "sage", "dill",
        "chive", "tarragon", "arugula", "rocket", "watercress", "bok choy",
        "fennel", "parsnip", "turnip", "beet", "radish", "asparagus",
        "artichoke", "squash", "pumpkin", "corn", "pea", "bean sprout",
        "apple", "banana", "avocado", "lemon", "lime", "orange", "grapefruit",
        "tangerine", "clementine", "mango", "pineapple", "strawberry",
        "blueberry", "raspberry", "blackberry", "cherry", "peach", "nectarine",
        "pear", "plum", "grape", "melon", "watermelon", "cantaloupe", "kiwi",
        "apricot", "fig", "date", "herb",
    ]),
    ("Nuts, Seeds & Dried Fruit", [
        "nut", "almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut",
        "macadamia", "brazil nut", "pine nut", "peanut", "seed", "chia",
        "flax", "linseed", "hemp", "sunflower seed", "pumpkin seed",
        "sesame seed", "raisin", "sultana", "dried apricot",
        "dried cranberry", "dried fruit", "prune", "desiccated coconut",
        "shredded coconut", "coconut flake",
    ]),
    ("Meat & Seafood", [
        "chicken", "turkey", "beef", "steak", "ground beef", "mince", "pork",
        "bacon", "ham", "prosciutto", "pancetta", "sausage", "chorizo",
        "salami", "pepperoni", "lamb", "veal", "duck", "meatball", "rib",
        "brisket", "roast", "short rib", "fish", "salmon", "tuna", "cod",
        "tilapia", "halibut", "sea bass", "bass", "trout", "mackerel",
        "sardine", "anchovy", "shrimp", "prawn", "crab", "lobster", "mussel",
        "clam", "scallop", "squid", "calamari", "octopus", "jerky",
    ]),
    ("Deli & Specialty Cheese", ["deli", "lunch meat"]),
    ("Dairy, Cheese & Eggs", [
        "milk", "cream", "butter", "yogurt", "yoghurt", "cheese", "parmesan",
        "parmigiano", "cheddar", "mozzarella", "feta", "goat cheese",
        "halloumi", "ricotta", "mascarpone", "cream cheese", "sour cream",
        "crème fraîche", "creme fraiche", "egg", "ghee", "custard",
        "buttermilk", "condensed milk", "evaporated milk", "almond milk",
        "oat milk", "soy milk", "coconut yogurt",
    ]),
    ("Breakfast", ["cereal", "granola", "pancake mix", "waffle", "breakfast"]),
    ("Coffee & Tea", ["coffee", "espresso", "tea", "matcha", "chai"]),
    ("Beverages", [
        "juice", "soda", "sparkling water", "seltzer", "coconut water",
        "lemonade", "cider", "drink", "beverage",
    ]),
    ("Wine, Beer & Spirits", [
        "wine", "beer", "lager", "ale", "prosecco", "champagne", "vodka",
        "rum", "whiskey", "whisky", "gin", "tequila", "sake", "vermouth",
        "triple sec", "bourbon", "scotch", "kahlúa", "kahlua",
    ]),
    ("International", ["miso", "mirin", "nori", "seaweed", "tofu", "tempeh", "kimchi", "wasabi", "ponzu"]),
    ("Snacks", ["chips", "crisps", "cracker", "popcorn", "pretzel", "snack"]),
    ("Candy", ["candy", "marshmallow", "sprinkle", "caramel bit", "toffee"]),
]

_KEYWORD_RES = [
    (section, [re.compile(r"\b" + re.escape(kw) + r"(?:s|es)?\b", re.I) for kw in kws])
    for section, kws in HEURISTIC
]


def bucket_for(ingredient_name: str) -> str:
    """Mirror of bucketFor() in src/lib/sections.ts."""
    if re.search(r",\s*(?:ground|dried)\b", ingredient_name, re.I) or re.search(r"\bpowder\b", ingredient_name, re.I):
        return "Baking & Spices"
    for section, regexes in _KEYWORD_RES:
        if any(rx.search(ingredient_name) for rx in regexes):
            return section
    return "Other"


# ---------------------------------------------------------------------------
# ADR-0052: SUPPLEMENTAL ENTRIES — hand-authored, catalog-independent
# ---------------------------------------------------------------------------
#
# (display name, category). `unit` is intentionally None for every row: these
# are never recipe line items, so there is no observed majority unit to report,
# and inventing one ("(1 L) cartons") would print a purchase format the app
# cannot honour — the unit is only a hint on the suggestion row, and an absent
# one is honest.
#
# Categories are from STORE_SECTIONS (src/lib/sections.ts) and stated here
# rather than inferred, because bucketFor()'s keyword lens reads authored recipe
# prose, not a shopping list: it sends "gluten-free bread flour" to Bakery (on
# `bread`) and "pea milk" to Produce (on `pea`). A wrong bucket is worse than no
# heuristic here — the category is what files the item into the store section
# the user then shops by.
#
# Merge precedence keeps every row a FILLER: a row whose nameKey already exists
# in the catalog is skipped, so the catalog's observed category + unit always
# win and this table can never contradict a real recipe ingredient.
SUPPLEMENTAL: list[tuple[str, str]] = [
    # ---- Gluten-free flours, starches & binders -------------------------
    # Baking & Spices, matching the catalog's own all-purpose/almond flour.
    ("gluten-free all-purpose flour", "Baking & Spices"),
    ("gluten-free bread flour", "Baking & Spices"),
    ("gluten-free cake flour", "Baking & Spices"),
    ("gluten-free whole wheat flour", "Baking & Spices"),
    ("gluten-free oat flour", "Baking & Spices"),
    ("gluten-free rice flour", "Baking & Spices"),
    ("gluten-free flour blend", "Baking & Spices"),
    ("rice flour", "Baking & Spices"),
    ("tapioca starch", "Baking & Spices"),
    ("potato starch", "Baking & Spices"),
    ("psyllium husk", "Baking & Spices"),
    ("xanthan gum", "Baking & Spices"),
    ("guar gum", "Baking & Spices"),
    ("cream of tartar", "Baking & Spices"),
    ("active dry yeast", "Baking & Spices"),
    ("baker's yeast", "Baking & Spices"),
    ("silica gel", "Baking & Spices"),
    # ---- Gluten-free bakery ---------------------------------------------
    ("gluten-free bread", "Bakery"),
    ("gluten-free breadcrumbs", "Bakery"),
    ("gluten-free panko breadcrumbs", "Bakery"),
    ("gluten-free pita bread", "Bakery"),
    ("gluten-free tortilla", "Bakery"),
    ("gluten-free bagel", "Bakery"),
    ("gluten-free bun", "Bakery"),
    ("gluten-free english muffin", "Bakery"),
    ("gluten-free naan", "Bakery"),
    ("gluten-free pizza crust", "Bakery"),
    ("gluten-free croutons", "Bakery"),
    # ---- Gluten-free pasta, grains & condiments -------------------------
    ("gluten-free pasta", "Pasta & Sauces"),
    ("gluten-free spaghetti", "Pasta & Sauces"),
    ("gluten-free penne", "Pasta & Sauces"),
    ("gluten-free lasagna noodles", "Pasta & Sauces"),
    ("gluten-free rice noodles", "Pasta & Sauces"),
    ("gluten-free egg noodles", "Pasta & Sauces"),
    ("gluten-free orzo", "Pasta & Sauces"),
    ("gluten-free rolled oats", "Rice, Grains & Beans"),
    ("gluten-free cereal", "Breakfast"),
    ("gluten-free soy sauce", "Oils, Sauces & Condiments"),
    ("gluten-free tamari", "Oils, Sauces & Condiments"),
    # ---- Lactose-free (still dairy — belongs beside its milk/cheese) ----
    ("lactose-free milk", "Dairy, Cheese & Eggs"),
    ("lactose-free half-and-half", "Dairy, Cheese & Eggs"),
    ("lactose-free butter", "Dairy, Cheese & Eggs"),
    ("lactose-free cream", "Dairy, Cheese & Eggs"),
    ("lactose-free sour cream", "Dairy, Cheese & Eggs"),
    ("lactose-free cheese", "Dairy, Cheese & Eggs"),
    ("lactose-free cheddar cheese", "Dairy, Cheese & Eggs"),
    ("lactose-free mozzarella cheese", "Dairy, Cheese & Eggs"),
    ("lactose-free yogurt", "Dairy, Cheese & Eggs"),
    ("lactose-free greek yogurt", "Dairy, Cheese & Eggs"),
    ("lactose-free cottage cheese", "Dairy, Cheese & Eggs"),
    ("lactose-free cream cheese", "Dairy, Cheese & Eggs"),
    ("lactose-free ice cream", "Dairy, Cheese & Eggs"),
    # ---- Dairy-free substitutes ----------------------------------------
    ("dairy-free milk", "Dairy, Cheese & Eggs"),
    ("dairy-free butter", "Dairy, Cheese & Eggs"),
    ("dairy-free cream", "Dairy, Cheese & Eggs"),
    ("dairy-free sour cream", "Dairy, Cheese & Eggs"),
    ("dairy-free cheese", "Dairy, Cheese & Eggs"),
    ("dairy-free cheddar", "Dairy, Cheese & Eggs"),
    ("dairy-free mozzarella", "Dairy, Cheese & Eggs"),
    ("dairy-free parmesan", "Dairy, Cheese & Eggs"),
    ("dairy-free cream cheese", "Dairy, Cheese & Eggs"),
    ("dairy-free yogurt", "Dairy, Cheese & Eggs"),
    ("dairy-free cottage cheese", "Dairy, Cheese & Eggs"),
    ("dairy-free ice cream", "Dairy, Cheese & Eggs"),
    ("dairy-free chocolate", "Baking & Spices"),
    ("plant-based cream cheese", "Dairy, Cheese & Eggs"),
    ("plant-based butter", "Dairy, Cheese & Eggs"),
    # ---- Plant milks ----------------------------------------------------
    # Not 'Beverages': these substitute a milk the recipe measures, so they
    # file beside whole milk where the shopper will actually look for them.
    ("oat milk", "Dairy, Cheese & Eggs"),
    ("soy milk", "Dairy, Cheese & Eggs"),
    ("almond milk", "Dairy, Cheese & Eggs"),
    ("cashew milk", "Dairy, Cheese & Eggs"),
    ("pea milk", "Dairy, Cheese & Eggs"),
    ("coconut milk beverage", "Dairy, Cheese & Eggs"),
    # ---- Vegan dairy equivalents ----------------------------------------
    ("coconut yogurt", "Dairy, Cheese & Eggs"),
    ("coconut cream", "Dairy, Cheese & Eggs"),
    ("vegan butter", "Dairy, Cheese & Eggs"),
    ("vegan cheese", "Dairy, Cheese & Eggs"),
    ("vegan cream", "Dairy, Cheese & Eggs"),
    ("vegan sour cream", "Dairy, Cheese & Eggs"),
    ("vegan chocolate", "Baking & Spices"),
    ("coconut aminos", "Oils, Sauces & Condiments"),
    ("nutritional yeast", "Baking & Spices"),
    # ---- Broths & stocks (recipes say "chicken or vegetable broth") ------
    ("chicken stock", "Canned & Jarred Goods"),
    ("vegetable stock", "Canned & Jarred Goods"),
    ("beef stock", "Canned & Jarred Goods"),
    ("fish stock", "Canned & Jarred Goods"),
    ("lamb stock", "Canned & Jarred Goods"),
    ("bone broth", "Canned & Jarred Goods"),
    ("chicken bouillon", "Canned & Jarred Goods"),
    ("vegetable bouillon", "Canned & Jarred Goods"),
    ("beef bouillon", "Canned & Jarred Goods"),
    # ---- Cooking fats & oils -------------------------------------------
    ("coconut oil", "Oils, Sauces & Condiments"),
    ("avocado oil", "Oils, Sauces & Condiments"),
    ("neutral oil", "Oils, Sauces & Condiments"),
    ("vegetable oil", "Oils, Sauces & Condiments"),
    ("olive oil", "Oils, Sauces & Condiments"),
    ("garlic-infused oil", "Oils, Sauces & Condiments"),
    ("ghee", "Dairy, Cheese & Eggs"),
    ("margarine", "Dairy, Cheese & Eggs"),
    # ---- Sweeteners ------------------------------------------------------
    ("agave nectar", "Nut Butters, Honey & Jams"),
    ("date syrup", "Nut Butters, Honey & Jams"),
    ("molasses", "Nut Butters, Honey & Jams"),
    ("corn syrup", "Nut Butters, Honey & Jams"),
    ("coconut sugar", "Baking & Spices"),
    # ---- Chocolate & extracts ------------------------------------------
    ("dark chocolate", "Baking & Spices"),
    ("bittersweet chocolate", "Baking & Spices"),
    ("white chocolate", "Baking & Spices"),
    ("chocolate chips", "Baking & Spices"),
    ("vanilla bean paste", "Baking & Spices"),
    ("almond extract", "Baking & Spices"),
    ("mint extract", "Baking & Spices"),
    # ---- International condiments the catalog lacks ---------------------
    ("ponzu", "International"),
    ("harissa", "Oils, Sauces & Condiments"),
    ("gochujang", "Oils, Sauces & Condiments"),
    ("sriracha", "Oils, Sauces & Condiments"),
    ("yuba", "International"),
    ("miso paste", "International"),
    ("seaweed", "International"),
    ("chili crisp", "Oils, Sauces & Condiments"),
    ("oyster sauce", "Oils, Sauces & Condiments"),
    ("teriyaki sauce", "Oils, Sauces & Condiments"),
    ("chili garlic sauce", "Oils, Sauces & Condiments"),
    ("yellow mustard", "Oils, Sauces & Condiments"),
    ("honey mustard", "Oils, Sauces & Condiments"),
    ("balsamic glaze", "Oils, Sauces & Condiments"),
    ("sherry vinegar", "Oils, Sauces & Condiments"),
    # ---- Grains, seeds & nuts ------------------------------------------
    ("amaranth", "Rice, Grains & Beans"),
    ("buckwheat", "Rice, Grains & Beans"),
    ("black rice", "Rice, Grains & Beans"),
    ("brown rice", "Rice, Grains & Beans"),
    ("white rice", "Rice, Grains & Beans"),
    ("wild rice", "Rice, Grains & Beans"),
    ("oat flour", "Rice, Grains & Beans"),
    ("steel-cut oats", "Rice, Grains & Beans"),
    ("rolled oats", "Rice, Grains & Beans"),
    ("farro", "Rice, Grains & Beans"),
    ("millet", "Rice, Grains & Beans"),
    ("barley", "Rice, Grains & Beans"),
    ("bulgur", "Rice, Grains & Beans"),
    ("black lentils", "Rice, Grains & Beans"),
    ("navy beans", "Rice, Grains & Beans"),
    ("black-eyed peas", "Rice, Grains & Beans"),
    ("hemp seeds", "Nuts, Seeds & Dried Fruit"),
    ("flax seeds", "Nuts, Seeds & Dried Fruit"),
    ("sunflower seeds", "Nuts, Seeds & Dried Fruit"),
    ("hazelnuts", "Nuts, Seeds & Dried Fruit"),
    ("macadamia nuts", "Nuts, Seeds & Dried Fruit"),
    ("brazil nuts", "Nuts, Seeds & Dried Fruit"),
    ("peanuts", "Nuts, Seeds & Dried Fruit"),
    ("peanut butter", "Nut Butters, Honey & Jams"),
    ("almond butter", "Nut Butters, Honey & Jams"),
    ("cashew butter", "Nut Butters, Honey & Jams"),
    ("sunflower seed butter", "Nut Butters, Honey & Jams"),
    ("figs", "Nuts, Seeds & Dried Fruit"),
    ("dates", "Nuts, Seeds & Dried Fruit"),
    # ---- Produce the recipes never name --------------------------------
    ("arugula", "Produce"),
    ("watercress", "Produce"),
    ("mixed greens", "Produce"),
    ("chard", "Produce"),
    ("cabbage", "Produce"),
    ("cucumber", "Produce"),
    ("beets", "Produce"),
    ("fennel", "Produce"),
    ("zucchini", "Produce"),
    ("mushrooms", "Produce"),
    ("snap peas", "Produce"),
    ("cherries", "Produce"),
    ("grapes", "Produce"),
    ("kiwi", "Produce"),
    ("watermelon", "Produce"),
    ("cantaloupe", "Produce"),
    ("berries", "Produce"),
    ("plantain", "Produce"),
    # ---- Eggs & dairy basics -------------------------------------------
    ("egg whites", "Dairy, Cheese & Eggs"),
    ("egg yolks", "Dairy, Cheese & Eggs"),
    ("butter", "Dairy, Cheese & Eggs"),
    ("buttermilk", "Dairy, Cheese & Eggs"),
    ("parmesan", "Dairy, Cheese & Eggs"),
    ("pecorino", "Dairy, Cheese & Eggs"),
    ("mozzarella", "Dairy, Cheese & Eggs"),
    ("cheddar", "Dairy, Cheese & Eggs"),
    ("feta", "Dairy, Cheese & Eggs"),
    ("ricotta", "Dairy, Cheese & Eggs"),
    ("halloumi", "Dairy, Cheese & Eggs"),
    ("greek yogurt", "Dairy, Cheese & Eggs"),
    ("plain yogurt", "Dairy, Cheese & Eggs"),
    ("sour cream", "Dairy, Cheese & Eggs"),
    ("whipping cream", "Dairy, Cheese & Eggs"),
    ("heavy cream", "Dairy, Cheese & Eggs"),
    ("milk", "Dairy, Cheese & Eggs"),
    # ---- Meat, poultry & seafood ---------------------------------------
    ("chicken breast", "Meat & Seafood"),
    ("chicken thighs", "Meat & Seafood"),
    ("chicken wings", "Meat & Seafood"),
    ("turkey breast", "Meat & Seafood"),
    ("ground beef", "Meat & Seafood"),
    ("ground pork", "Meat & Seafood"),
    ("beef chuck", "Meat & Seafood"),
    ("beef sirloin", "Meat & Seafood"),
    ("pork tenderloin", "Meat & Seafood"),
    ("pork shoulder", "Meat & Seafood"),
    ("sausage", "Meat & Seafood"),
    ("ham", "Meat & Seafood"),
    ("pancetta", "Meat & Seafood"),
    ("salmon", "Meat & Seafood"),
    ("tuna", "Meat & Seafood"),
    ("cod", "Meat & Seafood"),
    ("shrimp", "Meat & Seafood"),
    ("tilapia", "Meat & Seafood"),
    ("halibut", "Meat & Seafood"),
    ("mackerel", "Meat & Seafood"),
    ("sardines", "Meat & Seafood"),
    ("anchovies", "Meat & Seafood"),
    ("scallops", "Meat & Seafood"),
    ("crab", "Meat & Seafood"),
    ("lobster", "Meat & Seafood"),
    ("mussels", "Meat & Seafood"),
    ("clams", "Meat & Seafood"),
    ("oysters", "Meat & Seafood"),
    # ---- Spices, salt & pantry basics ----------------------------------
    ("bay leaf", "Baking & Spices"),
    ("oregano", "Baking & Spices"),
    ("thyme", "Baking & Spices"),
    ("rosemary", "Baking & Spices"),
    ("sage", "Baking & Spices"),
    ("dill", "Baking & Spices"),
    ("basil", "Produce"),
    ("parsley", "Produce"),
    ("cinnamon", "Baking & Spices"),
    ("nutmeg", "Baking & Spices"),
    ("cloves", "Baking & Spices"),
    ("cardamom", "Baking & Spices"),
    ("allspice", "Baking & Spices"),
    ("turmeric", "Baking & Spices"),
    ("coriander", "Baking & Spices"),
    ("cumin", "Baking & Spices"),
    ("white pepper", "Baking & Spices"),
    ("pink peppercorns", "Baking & Spices"),
    ("flaky salt", "Baking & Spices"),
    ("kosher salt", "Baking & Spices"),
    ("sea salt", "Baking & Spices"),
    ("smoked salt", "Baking & Spices"),
    ("garlic salt", "Baking & Spices"),
    ("onion salt", "Baking & Spices"),
    ("chili flakes", "Baking & Spices"),
    # ---- Drinks ---------------------------------------------------------
    ("coffee", "Coffee & Tea"),
    ("espresso", "Coffee & Tea"),
    ("tea", "Coffee & Tea"),
    ("green tea", "Coffee & Tea"),
    ("black tea", "Coffee & Tea"),
    ("herbal tea", "Coffee & Tea"),
    ("matcha", "Coffee & Tea"),
    ("chai concentrate", "Coffee & Tea"),
    ("orange juice", "Beverages"),
    ("apple juice", "Beverages"),
    ("lemonade", "Beverages"),
    ("coconut water", "Beverages"),
    ("sparkling water", "Beverages"),
    ("ginger ale", "Beverages"),
    ("white wine", "Wine, Beer & Spirits"),
    ("red wine", "Wine, Beer & Spirits"),
    ("rosé", "Wine, Beer & Spirits"),
    ("beer", "Wine, Beer & Spirits"),
    ("gluten-free beer", "Wine, Beer & Spirits"),
    ("prosecco", "Wine, Beer & Spirits"),
    ("champagne", "Wine, Beer & Spirits"),
    # ---- ADR-0052 tranche 2: everyday staples the census missed ----------
    # Found by censusing a hand-written ~450-name household shopping list
    # against the built index and keeping only names with NO whole-word
    # match in any existing key (so "fettuccine" is not a gap --
    # "fettuccine pasta" is already there). Same filler rule as above.
    # ---- Produce ----
    ("bamboo shoots", "Produce"),
    ("broccolini", "Produce"),
    ("butter lettuce", "Produce"),
    ("cherry tomatoes", "Produce"),
    ("delicata squash", "Produce"),
    ("endive", "Produce"),
    ("green onions", "Produce"),
    ("habanero", "Produce"),
    ("iceberg lettuce", "Produce"),
    ("jicama", "Produce"),
    ("microgreens", "Produce"),
    ("nectarines", "Produce"),
    ("papaya", "Produce"),
    ("persimmon", "Produce"),
    ("poblano", "Produce"),
    ("pomegranate", "Produce"),
    ("radicchio", "Produce"),
    ("rhubarb", "Produce"),
    ("rutabaga", "Produce"),
    ("scotch bonnet", "Produce"),
    ("serrano", "Produce"),
    ("tarragon", "Produce"),
    # ---- Meat & Seafood ----
    ("bratwurst", "Meat & Seafood"),
    ("brisket", "Meat & Seafood"),
    ("calamari", "Meat & Seafood"),
    ("catfish", "Meat & Seafood"),
    ("chorizo", "Meat & Seafood"),
    ("chuck roast", "Meat & Seafood"),
    ("duck", "Meat & Seafood"),
    ("hot dog", "Meat & Seafood"),
    ("meatballs", "Meat & Seafood"),
    ("monkfish", "Meat & Seafood"),
    ("pepperoni", "Meat & Seafood"),
    ("pork chops", "Meat & Seafood"),
    ("pork loin", "Meat & Seafood"),
    ("prawns", "Meat & Seafood"),
    ("salami", "Meat & Seafood"),
    ("sea bass", "Meat & Seafood"),
    ("short ribs", "Meat & Seafood"),
    ("squid", "Meat & Seafood"),
    ("surimi", "Meat & Seafood"),
    ("trout", "Meat & Seafood"),
    ("veal", "Meat & Seafood"),
    # ---- Dairy, Cheese & Eggs ----
    ("2% milk", "Dairy, Cheese & Eggs"),
    ("brie", "Dairy, Cheese & Eggs"),
    ("camembert", "Dairy, Cheese & Eggs"),
    ("crème fraîche", "Dairy, Cheese & Eggs"),
    ("edam", "Dairy, Cheese & Eggs"),
    ("gouda", "Dairy, Cheese & Eggs"),
    ("gruyere", "Dairy, Cheese & Eggs"),
    ("hard-boiled eggs", "Dairy, Cheese & Eggs"),
    ("mascarpone", "Dairy, Cheese & Eggs"),
    ("parmigiano", "Dairy, Cheese & Eggs"),
    ("provolone", "Dairy, Cheese & Eggs"),
    ("queso fresco", "Dairy, Cheese & Eggs"),
    ("romano cheese", "Dairy, Cheese & Eggs"),
    ("salted butter", "Dairy, Cheese & Eggs"),
    ("skim milk", "Dairy, Cheese & Eggs"),
    ("skyr", "Dairy, Cheese & Eggs"),
    ("swiss cheese", "Dairy, Cheese & Eggs"),
    ("unsalted butter", "Dairy, Cheese & Eggs"),
    # ---- Coffee & Tea ----
    ("espresso beans", "Coffee & Tea"),
    ("ground coffee", "Coffee & Tea"),
    ("instant coffee", "Coffee & Tea"),
    ("rooibos", "Coffee & Tea"),
    # ---- Baking & Spices ----
    ("almond flour", "Baking & Spices"),
    ("chocolate bar", "Baking & Spices"),
    ("dried herbs", "Baking & Spices"),
    ("milk chocolate", "Baking & Spices"),
    ("pastry flour", "Baking & Spices"),
    ("semolina", "Baking & Spices"),
    # ---- Rice, Grains & Beans ----
    ("arborio rice", "Rice, Grains & Beans"),
    ("grits", "Rice, Grains & Beans"),
    ("oatmeal", "Rice, Grains & Beans"),
    ("sushi rice", "Rice, Grains & Beans"),
    # ---- Canned & Jarred Goods ----
    ("brown lentils", "Canned & Jarred Goods"),
    ("butter beans", "Canned & Jarred Goods"),
    ("canned artichoke hearts", "Canned & Jarred Goods"),
    ("canned carrots", "Canned & Jarred Goods"),
    ("canned corn", "Canned & Jarred Goods"),
    ("canned jalapeños", "Canned & Jarred Goods"),
    ("canned mushrooms", "Canned & Jarred Goods"),
    ("canned peas", "Canned & Jarred Goods"),
    ("canned tomatoes", "Canned & Jarred Goods"),
    ("cannellini beans", "Canned & Jarred Goods"),
    ("chickpeas", "Canned & Jarred Goods"),
    ("crushed tomatoes", "Canned & Jarred Goods"),
    ("dried beans", "Canned & Jarred Goods"),
    ("garbanzo beans", "Canned & Jarred Goods"),
    ("green lentils", "Canned & Jarred Goods"),
    ("kalamata olives", "Canned & Jarred Goods"),
    ("lima beans", "Canned & Jarred Goods"),
    ("pickled onions", "Canned & Jarred Goods"),
    ("pickles", "Canned & Jarred Goods"),
    ("red lentils", "Canned & Jarred Goods"),
    ("roasted red peppers", "Canned & Jarred Goods"),
    ("salsa verde", "Canned & Jarred Goods"),
    ("split peas", "Canned & Jarred Goods"),
    # ---- Pasta & Sauces ----
    ("pasta sauce", "Pasta & Sauces"),
    ("ramen", "Pasta & Sauces"),
    ("rigatoni", "Pasta & Sauces"),
    ("soba noodles", "Pasta & Sauces"),
    ("udon", "Pasta & Sauces"),
    # ---- Oils, Sauces & Condiments ----
    ("anchovy paste", "Oils, Sauces & Condiments"),
    ("canola oil", "Oils, Sauces & Condiments"),
    ("caraway seed", "Oils, Sauces & Condiments"),
    ("celiac seed", "Oils, Sauces & Condiments"),
    ("distilled vinegar", "Oils, Sauces & Condiments"),
    ("fennel seed", "Oils, Sauces & Condiments"),
    ("fenugreek", "Oils, Sauces & Condiments"),
    ("grapeseed oil", "Oils, Sauces & Condiments"),
    ("lard", "Oils, Sauces & Condiments"),
    ("mustard seed", "Oils, Sauces & Condiments"),
    ("nigella seed", "Oils, Sauces & Condiments"),
    ("relish", "Oils, Sauces & Condiments"),
    ("rice syrup", "Oils, Sauces & Condiments"),
    ("saffron", "Oils, Sauces & Condiments"),
    ("shortening", "Oils, Sauces & Condiments"),
    ("sumac", "Oils, Sauces & Condiments"),
    ("sunflower oil", "Oils, Sauces & Condiments"),
    ("za'atar", "Oils, Sauces & Condiments"),
    # ---- Snacks ----
    ("beef jerky", "Snacks"),
    ("energy bars", "Snacks"),
    ("granola bars", "Snacks"),
    ("popcorn", "Snacks"),
    ("potato chips", "Snacks"),
    ("pretzels", "Snacks"),
    ("rice crackers", "Snacks"),
    ("trail mix", "Snacks"),
    # ---- Nuts, Seeds & Dried Fruit ----
    ("candied nuts", "Nuts, Seeds & Dried Fruit"),
    ("coconut chips", "Nuts, Seeds & Dried Fruit"),
    ("coconut flakes", "Nuts, Seeds & Dried Fruit"),
    ("currants", "Nuts, Seeds & Dried Fruit"),
    ("desiccated coconut", "Nuts, Seeds & Dried Fruit"),
    ("dried figs", "Nuts, Seeds & Dried Fruit"),
    ("pistachios", "Nuts, Seeds & Dried Fruit"),
    ("prunes", "Nuts, Seeds & Dried Fruit"),
    ("roasted almonds", "Nuts, Seeds & Dried Fruit"),
    ("salted peanuts", "Nuts, Seeds & Dried Fruit"),
    ("shredded coconut", "Nuts, Seeds & Dried Fruit"),
    ("sultanas", "Nuts, Seeds & Dried Fruit"),
    # ---- Candy ----
    ("candied cherries", "Candy"),
    ("candied ginger", "Candy"),
    ("candy", "Candy"),
    ("caramel", "Candy"),
    ("fruit leather", "Candy"),
    ("gumdrops", "Candy"),
    ("marshmallows", "Candy"),
    ("sprinkles", "Candy"),
    ("toffee", "Candy"),
    # ---- Beverages ----
    ("cola", "Beverages"),
    ("grenadine", "Beverages"),
    ("root beer", "Beverages"),
    ("seltzer", "Beverages"),
    ("tonic water", "Beverages"),
    # ---- Wine, Beer & Spirits ----
    ("bourbon", "Wine, Beer & Spirits"),
    ("cider", "Wine, Beer & Spirits"),
    ("gin", "Wine, Beer & Spirits"),
    ("lager", "Wine, Beer & Spirits"),
    ("liqueur", "Wine, Beer & Spirits"),
    ("rum", "Wine, Beer & Spirits"),
    ("sake", "Wine, Beer & Spirits"),
    ("sangria", "Wine, Beer & Spirits"),
    ("stout", "Wine, Beer & Spirits"),
    ("tequila", "Wine, Beer & Spirits"),
    ("vermouth", "Wine, Beer & Spirits"),
    ("vodka", "Wine, Beer & Spirits"),
    ("whiskey", "Wine, Beer & Spirits"),
    # ---- ADR-0052 tranche 3: gaps found by diffing the CIQUAL food
    # composition table (ANSES, English edition, Zenodo 4770202 — 3 186
    # foods) against this index. Only SHOPPABLE single ingredients were
    # kept: CIQUAL is French and dish-heavy, so its regional cheeses
    # (Boulette d'Avesnes, Maroilles), charcuterie (chitterling sausage,
    # coppa, bresaola), named wines (Calvados, Marsala, pastis) and
    # prepared dishes (moussaka, paella, feasts) are NOT shopping items
    # for this app and were deliberately dropped. Provenance is a
    # REFERENCE for the list, not a dependency: nothing is fetched at
    # build or run time, and the rows are hand-curated below.
    # ---- flours & starches ----
    ("barley flour", "Baking & Spices"),
    ("buckwheat flour", "Baking & Spices"),
    ("chestnut flour", "Baking & Spices"),
    ("chickpea flour", "Baking & Spices"),
    ("maize flour", "Baking & Spices"),
    ("maize starch", "Baking & Spices"),
    ("millet flour", "Baking & Spices"),
    ("rice starch", "Baking & Spices"),
    ("rye flour", "Baking & Spices"),
    ("self-raising flour", "Baking & Spices"),
    ("soya flour", "Baking & Spices"),
    ("spelt flour", "Baking & Spices"),
    # ---- raising agents, sugars & cocoa ----
    ("black treacle", "Baking & Spices"),
    ("cane molasses", "Baking & Spices"),
    ("caramel sauce", "Baking & Spices"),
    ("cocoa butter", "Baking & Spices"),
    ("fructose", "Baking & Spices"),
    ("gelling agent", "Baking & Spices"),
    ("glucose", "Baking & Spices"),
    ("golden syrup", "Baking & Spices"),
    ("lecithin", "Baking & Spices"),
    ("sodium bicarbonate", "Baking & Spices"),
    # ---- Produce ----
    ("celeriac", "Produce"),
    ("chayote", "Produce"),
    ("chervil", "Produce"),
    ("cucurbit seeds", "Produce"),
    ("escaroles", "Produce"),
    ("glasswort", "Produce"),
    ("horseradish", "Produce"),
    ("longan", "Produce"),
    ("oyster leaf", "Produce"),
    ("rambutan", "Produce"),
    # ---- Bakery ----
    ("brioche", "Bakery"),
    ("crispbread", "Bakery"),
    ("croissant", "Bakery"),
    ("rusk", "Bakery"),
    ("rye crispbread", "Bakery"),
    ("sandwich loaf", "Bakery"),
    ("toast", "Bakery"),
    # ---- Dairy, Cheese & Eggs ----
    ("goat milk", "Dairy, Cheese & Eggs"),
    ("kefir", "Dairy, Cheese & Eggs"),
    ("milk powder", "Dairy, Cheese & Eggs"),
    ("processed cheese", "Dairy, Cheese & Eggs"),
    ("semi-skimmed milk", "Dairy, Cheese & Eggs"),
    ("sheep milk", "Dairy, Cheese & Eggs"),
    ("soy cream", "Dairy, Cheese & Eggs"),
    # ---- Coffee & Tea ----
    ("decaffeinated coffee", "Coffee & Tea"),
    ("tea leaves", "Coffee & Tea"),
    # ---- Rice, Grains & Beans ----
    ("bran", "Rice, Grains & Beans"),
    ("corn bran", "Rice, Grains & Beans"),
    ("haricot beans, dry", "Rice, Grains & Beans"),
    ("khorasan wheat", "Rice, Grains & Beans"),
    ("oat bran", "Rice, Grains & Beans"),
    ("rice bran", "Rice, Grains & Beans"),
    ("rye", "Rice, Grains & Beans"),
    ("soya beans", "Rice, Grains & Beans"),
    ("spelt", "Rice, Grains & Beans"),
    # ---- Canned & Jarred Goods ----
    ("canned fish", "Canned & Jarred Goods"),
    ("green olives", "Canned & Jarred Goods"),
    ("pickled gherkins", "Canned & Jarred Goods"),
    # ---- Oils, Sauces & Condiments ----
    ("almond oil", "Oils, Sauces & Condiments"),
    ("argan oil", "Oils, Sauces & Condiments"),
    ("corn oil", "Oils, Sauces & Condiments"),
    ("cottonseed oil", "Oils, Sauces & Condiments"),
    ("frying oil", "Oils, Sauces & Condiments"),
    ("hazelnut oil", "Oils, Sauces & Condiments"),
    ("linseed oil", "Oils, Sauces & Condiments"),
    ("mustard sauce", "Oils, Sauces & Condiments"),
    ("palm oil", "Oils, Sauces & Condiments"),
    ("peanut oil", "Oils, Sauces & Condiments"),
    ("poppyseed oil", "Oils, Sauces & Condiments"),
    ("rapeseed oil", "Oils, Sauces & Condiments"),
    ("rice bran oil", "Oils, Sauces & Condiments"),
    ("safflower oil", "Oils, Sauces & Condiments"),
    ("soy oil", "Oils, Sauces & Condiments"),
    ("walnut oil", "Oils, Sauces & Condiments"),
    ("white sauce", "Oils, Sauces & Condiments"),
    # ---- Frozen ----
    ("frozen yogurt", "Frozen"),
    ("ice lolly", "Frozen"),
    ("sorbet", "Frozen"),
    # ---- Snacks ----
    ("prawn crackers", "Snacks"),
    ("salty snacks", "Snacks"),
    ("wheat crackers", "Snacks"),
    # ---- Nuts, Seeds & Dried Fruit ----
    ("flaxseed", "Nuts, Seeds & Dried Fruit"),
    ("sesame seeds, husked", "Nuts, Seeds & Dried Fruit"),
    # ---- Beverages ----
    ("carrot juice", "Beverages"),
    ("chicory powder", "Beverages"),
    ("fruit juice", "Beverages"),
    ("grape juice", "Beverages"),
    ("grapefruit juice", "Beverages"),
    ("lemon juice", "Beverages"),
    ("lime juice", "Beverages"),
    ("pineapple juice", "Beverages"),
    ("prune juice", "Beverages"),
    ("tomato juice", "Beverages"),
    ("vegetable juice", "Beverages"),
    # ---- Wine, Beer & Spirits ----
    ("blackcurrant liqueur", "Wine, Beer & Spirits"),
    ("calvados", "Wine, Beer & Spirits"),
    ("marsala", "Wine, Beer & Spirits"),
    ("non-alcoholic beer", "Wine, Beer & Spirits"),
    ("pastis", "Wine, Beer & Spirits"),
    ("sparkling fruit wine", "Wine, Beer & Spirits"),
]


def snapshot_section_map() -> dict:
    """Real Mealime sections (section_id -> name) for the 17 named
    ingredients of the bundled user_data.json snapshot, keyed by nameKey."""
    with open(os.path.join("public", "data", "user_data.json")) as f:
        data = json.load(f)
    plan = data.get("current_meal_plan") or {}
    sections = {s["id"]: s["name"] for s in plan.get("sections", [])}
    out = {}
    for item in plan.get("items", []):
        sid = item.get("section_id")
        if sid in sections:
            out[name_key(item["ingredient_name"])] = sections[sid]
    return out


def main() -> int:
    recipe_files = recipe_doc_paths()
    if len(recipe_files) != 2759:
        print(f"warning: expected 2,759 recipe docs, found {len(recipe_files)}", file=sys.stderr)

    counts = collections.Counter()
    cat_votes = collections.defaultdict(collections.Counter)
    # (normalized unitKey, first-seen display spelling) -> occurrences
    unit_votes = collections.defaultdict(collections.Counter)
    first_seen = {}

    for path in recipe_files:
        with open(path) as f:
            doc = json.load(f)
        for li in doc.get("line_items") or []:
            name = li["ingredient_name"]
            key = name_key(name)
            if not key:
                continue
            counts[key] += 1
            first_seen.setdefault(key, name.strip())
            cat_votes[key][bucket_for(name)] += 1

            parsed = parse_quantity(li.get("quantity", ""))
            if parsed:
                unit = parsed[1].strip()
                uk = unit_key(unit)
                if uk:
                    unit_votes[key][(uk, unit)] += 1

    # Authoritative section overrides from the user snapshot
    overrides = snapshot_section_map()
    matched_overrides = [k for k in overrides if k in counts]

    ingredients = []
    for key in sorted(counts):
        if key in overrides:
            cat = overrides[key]
        else:
            votes = cat_votes[key]
            cat = votes.most_common(1)[0][0] if votes else "Other"
        best = unit_votes[key].most_common(1)
        unit = best[0][0][1] if best else None  # first-seen display spelling
        ingredients.append({
            "name": first_seen[key],
            "nameKey": key,
            "category": cat,
            "unit": unit,
        })

    # ADR-0052: merge the hand-authored SUPPLEMENTAL rows as FILLERS. Skipping
    # any nameKey the catalog already produced is what keeps the catalog
    # authoritative — a supplemental row can never overwrite a recipe's
    # observed category or unit, it only fills a gap the catalog has.
    catalog_keys = {i["nameKey"] for i in ingredients}
    added, shadowed = 0, []
    for name, cat in SUPPLEMENTAL:
        key = name_key(name)
        if not key:
            continue
        if key in catalog_keys:
            shadowed.append(name)
            continue
        ingredients.append({
            "name": name,
            "nameKey": key,
            "category": cat,
            # No observed unit: these are never recipe line items.
            "unit": None,
        })
        catalog_keys.add(key)
        added += 1
    ingredients.sort(key=lambda i: i["nameKey"])

    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "count": len(ingredients),
        "ingredients": ingredients,
    }
    out_path = os.path.join("public", "data", "ingredients.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")

    # ---- summary ----
    coverage = collections.Counter(i["category"] for i in ingredients)
    print(f"read {len(recipe_files)} recipe docs -> {len(ingredients)} ingredients")
    print(f"ADR-0052 supplemental rows added: {added} "
          f"(skipped {len(shadowed)} already in the catalog: {', '.join(sorted(shadowed))})")
    print(f"snapshot section overrides applied: {len(matched_overrides)} "
          f"({', '.join(sorted(overrides[k] for k in matched_overrides))})")
    print("category coverage:")
    for cat, n in coverage.most_common():
        print(f"  {cat}: {n}")
    misses = [i["name"] for i in ingredients if i["category"] == "Other"]
    print(f"'Other' misses ({len(misses)}): {misses[:15]}")
    no_unit = [i["name"] for i in ingredients if i["unit"] is None]
    print(f"no-unit keys ({len(no_unit)}), top: {no_unit[:15]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
