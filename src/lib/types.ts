/** Static shapes for the Mealime data snapshot and CDN recipe documents. */

export interface Macros {
  fats: number
  carbs: number
  protein: number
}

/** One entry per recipe variant in `builder_data.variant_meta`. */
export interface VariantMeta {
  id: number
  name: string
  is_pro: boolean
  is_secret: boolean
  macros: Macros
  /** 0..1 */
  rating: number
  rating_count: number
  /** weekday (as string keys) -> count */
  popularity: Record<string, number>
  calories: number
  sodium_mg: number
  cooking_minutes: number
  serving_count: number
  ingredient_names: string[]
  variety_tag_ids: number[]
  price_per_serving: number | null
  thumbnail_image_url: string
  presentation_image_url: string
  /** Key for the full recipe document on cdn-recipes.mealime.com. */
  published_recipe_uuid: string
  recipe_id: number
  /** ms epoch */
  first_published_at: number
  ruleset: string
}

/** Per-variant auxiliary data in `builder_data.variant_data` (string-keyed by id). */
export interface VariantData {
  category_name: string
  boost: number
  variety_tags: number[]
  /** ingredient_id -> servings multiplier */
  perishable_amounts: Record<string, number>
  /** 12 floats, Jan..Dec */
  month_seasonalities: number[]
  recipe_id: number
}

export interface Favourite {
  id: number
  recipe_variant_id: number
  name: string
  image_url: string
}

export interface BuilderData {
  feasible_variants: number[]
  variant_data: Record<string, VariantData>
  /** list of variant-id lists (recently cooked) */
  recipe_history: number[][]
  /** ingredient_id -> package amount */
  perishable_package_amounts: Record<string, number>
  variant_meta: VariantMeta[]
  recipe_type_name: string
  is_favourites_builder_enabled: boolean
  favourited_feasible_variants: number[]
  favourites: Favourite[]
}

/* ---------- Full recipe document (cdn-recipes.mealime.com) ---------- */

export interface RecipeInstruction {
  id: number
  primary_message: string
  /** Per-step ingredient breakdown, newline separated; may be empty. */
  secondary_message: string
}

export interface LineItem {
  id: number
  /** Display string, e.g. "710 ml", "2 cups", "1 small bunch", "" */
  quantity: string
  ingredient_name: string
}

export interface Nutrition {
  energy: number
  carbs: number
  fiber: number
  sugars: number
  fat: number
  protein: number
  sodium: number
  [key: string]: number
}

export interface RecipeDoc {
  id: number
  recipe_id: number
  serving_count: number
  cooking_minutes: number
  name: string
  slug: string
  units: 'Metric' | 'Imperial'
  thumbnail_image_url: string
  presentation_image_url: string
  cookwares: string[]
  instructions: RecipeInstruction[]
  line_items: LineItem[]
  nutrition: Nutrition
}
