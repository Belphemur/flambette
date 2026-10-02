#!/usr/bin/env python3
"""
Ingredient-index extractor for the offline ingredient autocomplete (ADR-0012).

Walks the frozen local catalog (public/data/recipes/*.json, 2,730 docs) and
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
    if len(recipe_files) != 2730:
        print(f"warning: expected 2,730 recipe docs, found {len(recipe_files)}", file=sys.stderr)

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
