import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { COMPLETION_STEP, ONBOARDING_STEPS, useOnboardingStore } from './onboarding'

/**
 * ADR-0097: the getting-started tour's state machine. The store is the
 * WHOLE of the tour's logic (the overlay is presentation), so these cases
 * pin the contract that both the component and the e2e specs lean on:
 * rewind-to-first-incomplete on start(), stamp-only-on-real-interaction,
 * dismiss-preserves-stamps, restart-clears, and the completion step
 * (COMPLETION_STEP) never entering completedSteps.
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('onboarding store (ADR-0097)', () => {
  test('start() opens on the first step for a fresh device', () => {
    const s = useOnboardingStore()
    s.start()
    expect(s.active).toBe(true)
    expect(s.currentStep).toBe(0)
  })

  test('start() is a no-op while dismissedForever', () => {
    const s = useOnboardingStore()
    s.dismiss()
    s.start()
    expect(s.active).toBe(false)
    expect(s.dismissedForever).toBe(true)
  })

  test('start() is a no-op once every tour step is complete', () => {
    const s = useOnboardingStore()
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) s.completeStep(i)
    expect(s.isComplete).toBe(true)
    s.active = false
    s.currentStep = -1
    s.start()
    expect(s.active).toBe(false)
  })

  test('start() rewinds to the first INCOMPLETE step, stamps preserved', () => {
    const s = useOnboardingStore()
    // Simulate a reload mid-tour: steps 0 and 1 already earned.
    s.completedSteps = [0, 1]
    s.rewards = ['first-taste', 'sharp-eye']
    s.active = false
    s.currentStep = -1
    s.start()
    expect(s.active).toBe(true)
    expect(s.currentStep).toBe(2)
    expect(s.rewards).toHaveLength(2)
  })

  test('completeStep earns the stamp, records the step, and advances', () => {
    const s = useOnboardingStore()
    s.start()
    s.completeStep(0)
    expect(s.completedSteps).toEqual([0])
    expect(s.rewards).toEqual(['first-taste'])
    expect(s.currentStep).toBe(1)
  })

  test('completeStep on an already-completed step does not duplicate stamps', () => {
    const s = useOnboardingStore()
    s.completeStep(0)
    s.skipTo(0)
    s.completeStep(0)
    expect(s.completedSteps).toEqual([0])
    expect(s.rewards).toEqual(['first-taste'])
    // advanced once past the revisited step
    expect(s.currentStep).toBe(1)
  })

  test('next() advances without earning a stamp (the "Got it"/skip-ahead path)', () => {
    const s = useOnboardingStore()
    s.start()
    s.next()
    expect(s.currentStep).toBe(1)
    expect(s.completedSteps).toEqual([])
    expect(s.rewards).toEqual([])
  })

  test('completing the last tour step lands on the completion card, which is never recorded', () => {
    const s = useOnboardingStore()
    s.start()
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) s.completeStep(i)
    expect(s.currentStep).toBe(COMPLETION_STEP)
    expect(s.isComplete).toBe(true)
    expect(s.completedSteps).toHaveLength(5)
    expect(s.rewards).toEqual([
      'first-taste',
      'sharp-eye',
      'curious-cook',
      'planner',
      'provisioner',
    ])
  })

  test('dismiss() preserves stamps and sets dismissedForever', () => {
    const s = useOnboardingStore()
    s.completeStep(0)
    s.dismiss()
    expect(s.dismissedForever).toBe(true)
    expect(s.active).toBe(false)
    expect(s.rewards).toEqual(['first-taste'])
  })

  test('finish() ends the tour WITHOUT dismissing (qodo #11)', () => {
    const s = useOnboardingStore()
    // Finish via the completion card with every step really completed.
    for (let i = 0; i < 5; i++) s.completeStep(i)
    s.finish()
    expect(s.active).toBe(false)
    expect(s.currentStep).toBe(-1)
    expect(s.dismissedForever).toBe(false)
    expect(s.isComplete).toBe(true)
    // start() refuses to reopen a finished tour (isComplete gate).
    s.start()
    expect(s.active).toBe(false)
  })

  test('finish() with skipped steps resumes at the first incomplete one', () => {
    const s = useOnboardingStore()
    s.completeStep(0) // Start tour earns first-taste
    s.completeStep(1)
    s.skipTo(COMPLETION_STEP) // skipped 2–4 via "Got it"
    s.finish()
    expect(s.dismissedForever).toBe(false)
    s.start() // rewinds to the first incomplete step, stamps kept
    expect(s.active).toBe(true)
    expect(s.currentStep).toBe(2)
    expect(s.rewards).toEqual(['first-taste', 'sharp-eye'])
  })

  test('restart() clears stamps + dismissal and opens on the welcome step', () => {
    const s = useOnboardingStore()
    s.completeStep(0)
    s.dismiss()
    s.restart()
    expect(s.dismissedForever).toBe(false)
    expect(s.completedSteps).toEqual([])
    expect(s.rewards).toEqual([])
    expect(s.active).toBe(true)
    expect(s.currentStep).toBe(0)
  })

  test('earnStamp is idempotent', () => {
    const s = useOnboardingStore()
    s.earnStamp('sharp-eye')
    s.earnStamp('sharp-eye')
    expect(s.rewards).toEqual(['sharp-eye'])
  })

  test('skipTo clamps into the valid step range', () => {
    const s = useOnboardingStore()
    s.skipTo(-3)
    expect(s.currentStep).toBe(0)
    s.skipTo(99)
    expect(s.currentStep).toBe(COMPLETION_STEP)
  })
})
