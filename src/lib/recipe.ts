import { scaleQuantity } from './quantity'
import type { RecipeDoc } from './types'

/** One instruction step, scaled to the target servings. */
export interface ScaledStep {
  primary: string
  details: string[]
}

/**
 * Scale a recipe's instruction steps by a servings factor. Shared by the
 * detail sheet and the cooking view so both render identical step text.
 * Each newline of `secondary_message` becomes a detail line (scaled, empty
 * lines dropped).
 */
export function scaleSteps(doc: RecipeDoc, factor: number): ScaledStep[] {
  return doc.instructions.map((step) => ({
    primary: step.primary_message,
    details: (step.secondary_message ?? '')
      .split('\n')
      .map((line) => scaleQuantity(line, factor))
      .filter((line) => line.trim().length > 0),
  }))
}
