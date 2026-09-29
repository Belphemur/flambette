import { describe, expect, test } from 'bun:test'
import { classifyDiets, dietVerdictFor, matchesDiet, matchesAllDiets, resetDietVerdictCache } from './dietFilter'

const chicken = ['chicken breast', 'olive oil', 'salt']
const porkRecipe = ['pork shoulder', 'white sugar', 'bBQ sauce']
const tofuRecipe = ['tofu', 'broccoli', 'soy sauce', 'tahini']
const salmonRecipe = ['salmon fillet', 'lemon', 'dill']
const shrimpRecipe = ['shrimp', 'garlic', 'olive oil']
const veganCandidate = ['chickpeas', 'tomato', 'cumin', 'spinach']
const creamyPasta = ['pasta', 'milk', 'butter', 'parmesan']
const eggDish = ['eggs', 'spinach', 'feta cheese']
const plantMilkBake = ['oat milk', 'cocoa powder', 'banana']
const mysteryStock = ['vegetable stock', 'carrot', 'celery']

describe('diet rules (ADR-0018)', () => {
  test('no-pork is a strict pork-only rule', () => {
    expect(matchesDiet(chicken, 'no-pork')).toBe(true)
    expect(matchesDiet(porkRecipe, 'no-pork')).toBe(false)
    expect(matchesDiet(salmonRecipe, 'no-pork')).toBe(true)
  })

  test('no-shellfish', () => {
    expect(matchesDiet(shrimpRecipe, 'no-shellfish')).toBe(false)
    expect(matchesDiet(chicken, 'no-shellfish')).toBe(true)
  })

  test('no-meat allows fish but not meat', () => {
    expect(matchesDiet(salmonRecipe, 'no-meat')).toBe(true)
    expect(matchesDiet(chicken, 'no-meat')).toBe(false)
    expect(matchesDiet(porkRecipe, 'no-meat')).toBe(false)
    expect(matchesDiet(shrimpRecipe, 'no-meat')).toBe(true)
  })

  test('vegetarian excludes fish and hidden animal products', () => {
    expect(matchesDiet(tofuRecipe, 'vegetarian')).toBe(true)
    expect(matchesDiet(salmonRecipe, 'vegetarian')).toBe(false)
    expect(matchesDiet(['gelatin', 'water'], 'vegetarian')).toBe(false)
    expect(matchesDiet(['vegetable stock', 'carrot'], 'vegetarian')).toBe(true)
  })

  test('vegan additionally excludes dairy, egg and honey', () => {
    expect(matchesDiet(veganCandidate, 'vegan')).toBe(true)
    expect(matchesDiet(creamyPasta, 'vegan')).toBe(false)
    expect(matchesDiet(eggDish, 'vegan')).toBe(false)
    expect(matchesDiet(['honey', 'oats'], 'vegan')).toBe(false)
    // Plant milks are exempt even though the word "milk" is in the name.
    expect(matchesDiet(plantMilkBake, 'vegan')).toBe(true)
  })

  test('word boundaries: eggplant is not an egg, chamfer is not ham', () => {
    expect(matchesDiet(['eggplant', 'tomato'], 'vegan')).toBe(true)
    expect(matchesDiet(['black beans', 'rice'], 'vegan')).toBe(true)
  })

  test('classifyDiets reports every rule at once', () => {
    const verdict = classifyDiets(tofuRecipe)
    expect(verdict).toEqual({
      'no-pork': true,
      'no-shellfish': true,
      'no-meat': true,
      vegetarian: true,
      vegan: true,
    })
    expect(classifyDiets(creamyPasta).vegan).toBe(false)
    expect(classifyDiets(salmonRecipe)).toMatchObject({ 'no-meat': true, vegetarian: false, vegan: false })
  })

  test('multi-select is an intersection', () => {
    const verdict = classifyDiets(mysteryStock)
    expect(matchesAllDiets(verdict, [])).toBe(true)
    expect(matchesAllDiets(verdict, ['vegan'])).toBe(true)
    expect(matchesAllDiets(verdict, ['no-pork', 'no-shellfish', 'vegan'])).toBe(true)
    expect(matchesAllDiets(verdict, ['no-meat', 'vegetarian'])).toBe(true)
    const carnivore = classifyDiets(chicken)
    expect(matchesAllDiets(carnivore, ['no-pork', 'vegan'])).toBe(false)
  })

  test('verdicts are memoized per variant id', () => {
    resetDietVerdictCache()
    expect(dietVerdictFor(7, porkRecipe)['no-pork']).toBe(false)
    // Same id, different names: the memo wins (frozen catalog assumption).
    expect(dietVerdictFor(7, chicken)['no-pork']).toBe(false)
    resetDietVerdictCache()
    expect(dietVerdictFor(7, chicken)['no-pork']).toBe(true)
  })

  test('anchovy and caviar are fish, not shellfish (qodo 4128519626)', () => {
    // No-shellfish recipes keep fish products that merely LOOK like
    // shellfish keywords in name only.
    expect(matchesDiet(['anchovies', 'lemon', 'parsley'], 'no-shellfish')).toBe(true)
    expect(matchesDiet(['caviar', 'blini'], 'no-shellfish')).toBe(true)
    // Plural must singularize through the new -ies → -y rule.
    expect(matchesDiet(['cig kofte with anchovies'], 'no-shellfish')).toBe(true)
    // …but they are still animal products: vegetarian/vegan drop them
    // (no-meat explicitly allows fish).
    expect(matchesDiet(['anchovy', 'pasta'], 'vegetarian')).toBe(false)
    expect(matchesDiet(['caviar'], 'vegan')).toBe(false)
    // Shellfish verdicts are unchanged.
    expect(matchesDiet(shrimpRecipe, 'no-shellfish')).toBe(false)
  })

  test('nut butters and butter lettuce are vegan-safe (qodo 4128519626)', () => {
    expect(matchesDiet(['natural peanut butter', 'oats'], 'vegan')).toBe(true)
    expect(matchesDiet(['almond butter', 'toast'], 'vegan')).toBe(true)
    expect(matchesDiet(['nut butter'], 'vegan')).toBe(true)
    expect(matchesDiet(['butter (boston) lettuce', 'tomato'], 'vegan')).toBe(true)
    // Real dairy still trips the rule.
    expect(matchesDiet(['butter', 'toast'], 'vegan')).toBe(false)
    // The existing exemptions keep working.
    expect(matchesDiet(['butter beans', 'apple butter'], 'vegan')).toBe(true)
    // Pluralized exemptions too.
    expect(matchesDiet(['peanut butters'], 'vegan')).toBe(true)
  })
})
