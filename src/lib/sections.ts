/**
 * Store-section bucketing for grocery items.
 *
 * The canonical section list is copied from `user_data.json`
 * (current_meal_plan.sections). The CDN recipe documents do NOT carry
 * section ids, so items are bucketed with the keyword heuristic below
 * (first match wins, checked in order); anything unmatched falls back
 * to "Other".
 */

/** Canonical grocery store section names (from the data snapshot). */
export const STORE_SECTIONS = [
  'Produce',
  'Deli & Specialty Cheese',
  'Bakery',
  'Meat & Seafood',
  'Dairy, Cheese & Eggs',
  'Breakfast',
  'Coffee & Tea',
  'Nut Butters, Honey & Jams',
  'Baking & Spices',
  'Rice, Grains & Beans',
  'Canned & Jarred Goods',
  'Pasta & Sauces',
  'Oils, Sauces & Condiments',
  'International',
  'Frozen',
  'Snacks',
  'Nuts, Seeds & Dried Fruit',
  'Candy',
  'Beverages',
  'Wine, Beer & Spirits',
  'Personal Care',
  'Health',
  'Baby',
  'Household',
  'Kitchen',
  'Cleaning Products',
  'Pet Care',
  'Party',
  'Floral',
  'Customer Service',
  'Other',
] as const

export type StoreSection = (typeof STORE_SECTIONS)[number]

/** Fallback bucket when no keyword matches. */
export const OTHER_SECTION: StoreSection = 'Other'

/** Ordered keyword table — first matching entry wins. */
const HEURISTIC: [StoreSection, string[]][] = [
  ['Frozen', ['frozen']],
  ['Bakery', [
    'bread', 'bun', 'brioche', 'bagel', 'baguette', 'pita', 'tortilla', 'naan',
    'flatbread', 'croissant', 'english muffin', 'ciabatta', 'focaccia',
    'crouton', 'toast', 'roll',
  ]],
  ['Baking & Spices', [
    'black pepper', 'peppercorn', 'salt', 'cinnamon', 'cumin', 'paprika',
    'turmeric', 'curry powder', 'chili powder', 'chilli powder', 'vanilla',
    'cocoa', 'chocolate', 'cornstarch', 'cornflour', 'baking powder',
    'baking soda', 'yeast', 'nutmeg', 'cardamom', 'cloves', 'allspice',
    'garam masala', 'sumac', 'za\u2019atar', 'bay leaf', 'flour', 'sugar',
    'spice',
  ]],
  ['Oils, Sauces & Condiments', [
    'olive oil', 'oil', 'vinegar', 'soy sauce', 'fish sauce', 'hot sauce',
    'sriracha', 'mustard', 'ketchup', 'mayo', 'mayonnaise', 'maple syrup',
    'worcestershire', 'salsa', 'dressing', 'vinaigrette', 'teriyaki',
    'hoisin', 'oyster sauce', 'gochujang', 'harissa', 'tahini', 'sriracha',
    'hot honey',
  ]],
  ['Nut Butters, Honey & Jams', [
    'peanut butter', 'almond butter', 'nut butter', 'cashew butter',
    'sunflower butter', 'honey', 'jam', 'jelly', 'marmalade', 'preserves',
  ]],
  ['Pasta & Sauces', [
    'pasta', 'spaghetti', 'penne', 'macaroni', 'fusilli', 'linguine',
    'fettuccine', 'rigatoni', 'tagliatelle', 'noodles', 'ramen', 'udon',
    'soba', 'gnocchi', 'lasagne', 'lasagna', 'orzo', 'ravioli',
    'tortellini', 'marinara', 'alfredo sauce', 'pasta sauce',
  ]],
  ['Canned & Jarred Goods', [
    'canned', 'tin of', 'can of', 'passata', 'capers', 'olive', 'pickle',
    'cornichon', 'tomato paste', 'artichoke hearts', 'coconut milk',
    'sun-dried tomato', 'broth', 'stock', 'chipotle', 'chipotles',
  ]],
  ['Rice, Grains & Beans', [
    'rice', 'quinoa', 'couscous', 'barley', 'bulgur', 'farro', 'millet',
    'oats', 'oatmeal', 'porridge', 'lentil', 'chickpea', 'cannellini',
    'black beans', 'kidney beans', 'pinto', 'navy beans', 'polenta',
    'grits', 'buckwheat', 'freekeh', 'dried beans', 'black-eyed pea',
  ]],
  ['Produce', [
    // legume-adjacent produce first (checked before generic bean words above)
    'green bean', 'string bean', 'snap pea', 'snow pea', 'sugar pea',
    'edamame',
    'onion', 'scallion', 'spring onion', 'shallot', 'leek', 'garlic',
    'ginger', 'bell pepper', 'green pepper', 'red pepper', 'orange pepper',
    'yellow pepper', 'jalape\u00f1o', 'jalapeno', 'chili', 'chilli',
    'pepper', 'tomato', 'tomatillo', 'carrot', 'celery', 'lettuce',
    'spinach', 'kale', 'cabbage', 'broccoli', 'broccolini', 'cauliflower',
    'cucumber', 'zucchini', 'courgette', 'eggplant', 'aubergine', 'potato',
    'sweet potato', 'yam', 'mushroom', 'cilantro', 'coriander', 'parsley',
    'basil', 'mint', 'thyme', 'rosemary', 'oregano', 'sage', 'dill',
    'chive', 'tarragon', 'arugula', 'rocket', 'watercress', 'bok choy',
    'fennel', 'parsnip', 'turnip', 'beet', 'radish', 'asparagus',
    'artichoke', 'squash', 'pumpkin', 'corn', 'pea', 'bean sprout',
    'apple', 'banana', 'avocado', 'lemon', 'lime', 'orange', 'grapefruit',
    'tangerine', 'clementine', 'mango', 'pineapple', 'strawberry',
    'blueberry', 'raspberry', 'blackberry', 'cherry', 'peach', 'nectarine',
    'pear', 'plum', 'grape', 'melon', 'watermelon', 'cantaloupe', 'kiwi',
    'apricot', 'fig', 'date', 'herb',
  ]],
  ['Nuts, Seeds & Dried Fruit', [
    'nut', 'almond', 'walnut', 'cashew', 'pecan', 'pistachio', 'hazelnut',
    'macadamia', 'brazil nut', 'pine nut', 'peanut', 'seed', 'chia',
    'flax', 'linseed', 'hemp', 'sunflower seed', 'pumpkin seed',
    'sesame seed', 'raisin', 'sultana', 'dried apricot',
    'dried cranberry', 'dried fruit', 'prune', 'desiccated coconut',
    'shredded coconut', 'coconut flake',
  ]],
  ['Meat & Seafood', [
    'chicken', 'turkey', 'beef', 'steak', 'ground beef', 'mince', 'pork',
    'bacon', 'ham', 'prosciutto', 'pancetta', 'sausage', 'chorizo',
    'salami', 'pepperoni', 'lamb', 'veal', 'duck', 'meatball', 'rib',
    'brisket', 'roast', 'short rib', 'fish', 'salmon', 'tuna', 'cod',
    'tilapia', 'halibut', 'sea bass', 'bass', 'trout', 'mackerel',
    'sardine', 'anchovy', 'shrimp', 'prawn', 'crab', 'lobster', 'mussel',
    'clam', 'scallop', 'squid', 'calamari', 'octopus', 'jerky',
  ]],
  ['Deli & Specialty Cheese', ['deli', 'lunch meat']],
  ['Dairy, Cheese & Eggs', [
    'milk', 'cream', 'butter', 'yogurt', 'yoghurt', 'cheese', 'parmesan',
    'parmigiano', 'cheddar', 'mozzarella', 'feta', 'goat cheese',
    'halloumi', 'ricotta', 'mascarpone', 'cream cheese', 'sour cream',
    'cr\u00e8me fra\u00eeche', 'creme fraiche', 'egg', 'ghee', 'custard',
    'buttermilk', 'condensed milk', 'evaporated milk', 'almond milk',
    'oat milk', 'soy milk', 'coconut yogurt',
  ]],
  ['Breakfast', ['cereal', 'granola', 'pancake mix', 'waffle', 'breakfast']],
  ['Coffee & Tea', ['coffee', 'espresso', 'tea', 'matcha', 'chai']],
  ['Beverages', [
    'juice', 'soda', 'sparkling water', 'seltzer', 'coconut water',
    'lemonade', 'cider', 'drink', 'beverage',
  ]],
  ['Wine, Beer & Spirits', [
    'wine', 'beer', 'lager', 'ale', 'prosecco', 'champagne', 'vodka',
    'rum', 'whiskey', 'whisky', 'gin', 'tequila', 'sake', 'vermouth',
    'triple sec', 'bourbon', 'scotch', 'kahl\u00faa', 'kahlua',
  ]],
  ['International', ['miso', 'mirin', 'nori', 'seaweed', 'tofu', 'tempeh', 'kimchi', 'wasabi', 'ponzu']],
  ['Snacks', ['chips', 'crisps', 'cracker', 'popcorn', 'pretzel', 'snack']],
  ['Candy', ['candy', 'marshmallow', 'sprinkle', 'caramel bit', 'toffee']],
]

const keywordRegexes: [StoreSection, RegExp[]][] = HEURISTIC.map(
  ([section, keywords]) => [
    section,
    keywords.map((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i')),
  ],
)

/** Bucket an ingredient display name into a store section. */
export function bucketFor(ingredientName: string): StoreSection {
  // "cumin, ground" / "dill, dried" / "garlic powder" are pantry, not produce.
  if (/,\s*(?:ground|dried)\b/i.test(ingredientName) || /\bpowder\b/i.test(ingredientName)) {
    return 'Baking & Spices'
  }
  for (const [section, regexes] of keywordRegexes) {
    if (regexes.some((re) => re.test(ingredientName))) return section
  }
  return OTHER_SECTION
}
