# Product Requirements Document (PRD) & Product Brief: Flambette

---

## 1. Executive Summary & Product Vision

### 1.1 Product Vision
**Flambette** is a warm, photo-led, offline-first household meal planning and kitchen companion application. It transforms the often tedious journey of weekly meal coordination into a calm, intuitive ritual: **choose meals together, buy what you need without waste, and cook without friction.**

Unlike generic recipe scrapers, calorie-counting diaries, or bloated ad-supported food blogs, Flambette is built specifically around the physical realities of household cooking and supermarket shopping. Its primary value proposition is the direct, waste-aware path from appetizing recipe discovery to an unscheduled meal set, an auto-consolidated grocery list, and a distraction-free hands-free cooking mode.

### 1.2 Target Audience & User Personas
1. **The Household Meal Coordinator (Primary)**:
   - Needs to plan 3–6 dinners for the upcoming week for a family or partner.
   - Frustrated by recipe apps that leave them with half-used cilantro bunches, duplicate cream cartons, and sprawling supermarket trips.
   - Coordinates with a partner in real-time or asynchronously via simple household room sharing.
2. **The Active Home Cook (Secondary)**:
   - Interacts with the phone/tablet in the kitchen with wet or flour-dusted hands.
   - Needs legible typography from 2–3 feet away, integrated timers, and scaled ingredients per step rather than constantly scrolling between ingredient lists and instructions.
3. **The Self-Hoster & Privacy Enthusiast (Tertiary)**:
   - Prefers local data ownership, zero compulsory accounts, and complete offline capability (even if self-hosted via Docker or Cloudflare Workers).

---

## 2. Core Value Propositions & Product Pillars

1. **Zero Runtime Network Dependency (Offline-First)**:
   - Complete frozen catalog of **2,759 recipes** and pre-packaged local WebP imagery shipped with the client bundle.
   - Works fully unplugged on local storage; sync is an enhancement, not a barrier.
2. **Waste-Aware Auto-Plan (ADR-0024, ADR-0033)**:
   - Deterministic pack builder that scores recipes by *marginal package cost* (e.g. sharing whole commercial containers like feta, cream, or tortillas).
   - Generates an optimal pack with identical inputs; allows instant, reproducible regeneration seeds.
3. **Derived Smart Grocery List**:
   - Zero manual grocery entry needed: ingredients across all planned meals are parsed, scaled by serving size, merged by normalized lemma (`2 cloves` + `1 clove` → `3 cloves`), and sorted by canonical supermarket aisle.
   - Packaged vs. bulk unit intelligence (merges with a ceiling on packaged goods; linear on staples).
4. **Hands-Free Cooking Mode (ADR-0034)**:
   - Cook anytime without mandatory planning; single-step carousel view at a focused 672px reading measure with 20px body type, scaled ingredient chips, and persistent timers.
5. **Frictionless Real-Time Household Sync (ADR-0026, ADR-0038, ADR-0063)**:
   - Ephemeral or persistent room codes using three memorable words (`amber-falcon-lantern`).
   - Synchronizes meal plans, grocery checkmarks, custom pantry items, and connected member presence without user account creation or passwords.

---

## 3. Product Scope & Functional Requirements

### 3.1 Surface 1: Explore (Recipe Catalog & Search)
- **Catalog Browsing**: Responsive 1–4 column card grid (max container width 1100px) displaying 4:3 recipe photography, recipe title (max 2 lines reserved), preparation time, calorie counts, and semantic category indicator.
  - *Hard Constraint*: Sodium content is strictly omitted from browse cards to preserve metadata balance.
- **Search Engine**: In-browser instant search (MiniSearch) filtering across recipe names, ingredients, and tags.
- **Dietary & Exclusion Filters**:
  - Transparent keyword heuristics: Vegetarian, Vegan, No-Pork, No-Shellfish, No-Meat.
  - Category filters: Meat, Fish, Vegetarian, Vegan, Breakfast, Lunch, Dinner, Snack, Dessert.
- **Favourites & Ratings**: Local bookmarking toggled via an espresso heart disc; Bayesian vote-smoothed community ratings.

### 3.2 Surface 2: Operate — Meal Plan & Auto-Plan Pack Builder
- **Unscheduled List Paradigm (ADR-0024)**:
  - Explicit avoidance of rigid calendar slots (Monday–Sunday); households cook meals when convenient.
- **Serving Size Stepper**: Individual servings adjustment per recipe with real-time recalculation of total grocery volume.
- **Auto-Plan Pack Builder**:
  - Pack size selector (e.g., 3, 4, or 5 meals) and meal-type scoping (Dinner, Lunch, Any).
  - Deterministic generation based on pantry staples and minimum package waste.
  - Confirmation modal with visual recipe preview, add/replace toggles, seed regeneration, and 1-tap undo.
- **Ad-Hoc Cooking Shortcut (ADR-0034)**: Instant "Cook Now" button on any meal card without altering the plan state.

### 3.3 Surface 3: Operate — Derived Grocery List & Shopping Mode
- **Automatic Aggregation**:
  - Direct derivation from currently planned recipes and their configured servings.
  - Ingredient normalization (singularization, unit consolidation).
  - Provenance badges indicating which and how many recipes use an ingredient (e.g., "Used in 2 recipes").
- **Aisle Categorization**: Organized by standard store layout: Produce, Meat & Seafood, Dairy & Eggs, Pantry & Dry Goods, Spices & Baking, Bakery, Frozen.
- **Extra Pantry Items**: Add manual, custom line items (e.g., paper towels, coffee beans) pinned to the top.
- **In-Store Shopping Mode**:
  - High-contrast touch-first checklist.
  - Completed items auto-collapse into a checked drawer to maintain focus on remaining goods.
  - Household sync checkmark state updates in real-time across devices.

### 3.4 Surface 4: Command / Inspect — Cooking Mode
- **Focused Reading Ergonomics**:
  - Step-by-step reading carousel constrained to a 672px reading measure.
  - Scaled ingredient quantities highlighted per step (e.g., "Add 150g diced onions and 2 cloves minced garlic").
  - Large step numerals and minimum 20px typography readable at arm's length.
- **Integrated Timers**:
  - One-tap timers embedded in instruction text (e.g., "Simmer for 15 min").
  - Background-safe timer state stored in local storage, surviving app reloads and screen sleep.
- **Completion & History (ADR-0032)**:
  - Cooking completion logs an entry to the user's cooking history (shared with household room by default with opt-out).

### 3.5 Surface 5: Household Sync & Roster (ADR-0063)
- **Room Coordination**:
  - 3-word human-friendly room code generation.
  - Live status chip in header with connection pulse and peer headcount.
- **Member Roster Sheet**:
  - Generative hashvatars (deterministic dithered geometric canvas pattern based on display name).
  - List of active connected room members with clear local "You" identifier.
  - Ephemeral presence via WebSocket / Cloudflare Durable Objects.

---

## 4. Design System & UX Architecture ("Warm Culinary Paper")

### 4.1 Visual Theme Tokens
- **Theme**: Warm, tactile kitchen companion; avoids corporate grey dashboards or neon gradients.
- **Surfaces**:
  - Page Background: Cream Paper (`#FFF8F0` Light / Espresso `#171310` Dark)
  - Cards & Raised Containers: Pure White (`#FFFFFF` Light / Charcoal `#241C18` Dark)
  - Sunken / Metadata Bands: Peach-Cream (`#FFF0E6` Light / Cocoa `#32261F` Dark)
- **Primary Action (Tomato Red)**:
  - Primary: `#B3381F`
  - Hover / Active: `#8E2C17`
  - Subtle Tint: `#FBEAE5` (Light) / `#44241D` (Dark)
  - Text on Primary: `#FFFFFF` (measured WCAG contrast > 6.0:1)
- **Semantic Food & Diet Cues**:
  - Meat: `#B3381F` (Beef icon)
  - Fish: `#0E7490` (Fish icon)
  - Vegetarian: `#137A38` (Salad icon)
  - Vegan: `#047857` (Sprout icon)
  - Household / Custom: `#86198F` (NotebookPen icon)

### 4.2 Navigation Architecture
- **Persistent Bottom Navigation Bar**:
  - Anchored at the bottom (`fixed bottom-0 left-0 right-0 z-50`), optimized for single-thumb mobile ergonomics and centered within the desktop container.
  - Exactly 5 canonical tabs: **Recipes**, **Plan**, **Grocery**, **History**, **Settings**.
  - Minimum 44px hit targets with 56–64px height and brand backplate indicators.
- **Minimal Utility Top Header**:
  - Houses the Flambette wordmark/emblem, live room sync status chip, theme toggle, and search shortcut.

---

## 5. Technical Architecture & Non-Functional Requirements

### 5.1 Tech Stack
- **Frontend**: Vue 3 (`<script setup>`) + TypeScript + Vite.
- **State Management**: Pinia with `localStorage` persistence under `mealime-planner:v1:*` namespace.
- **Styling**: Tailwind CSS v4 with static token mappings and `@vueuse/core` dark mode sync.
- **Icons**: Bundled Lucide icons (offline-safe).
- **Search**: MiniSearch (in-memory client search).
- **Backend / Relay**:
  - Self-hosted: Bun WebSocket relay service (`bun server/relay.ts`) behind nginx.
  - Cloudflare hosted: Assets-only Worker on `flambette.app` + Durable Objects relay on `ws.flambette.app`.

### 5.2 Performance & Quality Benchmarks
- **Zero-Latency Offline Boot**: Cold start under 300ms from local cached bundle.
- **Deterministic Rendering**: Zero hydration mismatches, layout shifts (CLS < 0.05), or horizontal scrollbars at viewports down to 320px.
- **Accessibility (a11y)**: WCAG 2.1 AA compliance across all light and dark theme contrast pairs; 200% zoom support without clipping.

---

## 6. Release Roadmap & Success Metrics

| Milestone | Deliverables | Key Metric / Success Gate |
|---|---|---|
| **Phase 1: Foundation (Current)** | Complete frozen catalog, offline search, unscheduled plan, derived grocery list, bottom nav layout. | 100% offline functionality; 0 runtime CDN network calls. |
| **Phase 2: Kitchen Usability** | Refined step-by-step cooking reader, multi-timer persistence, mobile haptic feedback. | >80% cooking mode completion rate without app exit. |
| **Phase 3: Household Sync** | Three-word room relay, real-time shared checklist, hashvatar member presence. | <100ms sync latency across paired household devices. |
| **Phase 4: Optimization** | Enhanced package waste optimizer, seasonal catalog filters, custom recipe creation. | Reduction of excess grocery package cost by >25% in Auto-Plan. |
