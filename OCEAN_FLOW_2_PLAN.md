# Ocean Flow 2 / Clinical Glass: implementation plan

This plan evolves the existing Ocean Flow design system into Clinical Glass
without changing behaviour. Only styling changes: no business logic, API
calls, permissions, routing, break-glass rules or workflows are touched.

- **Branch:** `design/ocean-flow-2`, cut from `main` at `22be4b4`.
- **Restore point:** tag `restore-point-2026-09-25`.
- **Status:** Phases 1–3 are done. Phases 4 and 5 have not started.

---

## 1. What exists today

| Layer | Where | Notes |
|---|---|---|
| Tokens | `luminary-frontend-project/tailwind.config.js` | 41 colours, 8 font sizes, 5 radii. Enforced by `npm run verify:tokens` and `verify:contrast`. |
| Global CSS and `lh-*` classes | `src/index.css` | `lh-card`, `lh-card-pad` (55 uses), `lh-section-label` (50), `lh-primary-button` (20), `lh-secondary-button` (22), `lh-page-*`, `lh-metric`, `lh-table-*`, the dark-mode overrides and the print layouts. |
| React primitives | `src/components/ui.jsx` | `Modal`, `Field`, `Input`, `Select`, `Textarea`, `Button`, `Toast`, `EmptyState`, `HumanAvatar`, `OceanWaveDecoration` |
| Shared components | `src/components/shared/*` | `StatusPill` (used by 16 files), plus a second `EmptyState` (used by 6 pages) |
| Shell | `src/components/LuminaryDemo.jsx` | Sidebar, header, menus, command palette, context bar and all dialogs, written as inline utility classes |

**Duplicated styling to consolidate**

1. **Two `EmptyState` components with different looks.** Consolidated in
   Phase 2: `shared/EmptyState` now re-exports the `ui.jsx` one.
2. **Buttons exist three ways:** the `Button` component, the
   `lh-primary-button` / `lh-secondary-button` classes, and around 100 inline
   `rounded-lg border … px-3 py-2` buttons in the shell and pages. Phase 2
   points the first two at the new `lh-btn-*` classes. The inline buttons move
   in Phases 3 and 5.
3. **The menu styling appears four times** (workspace, account,
   mobile account and alerts menus in the shell). It becomes `lh-popover` and
   `lh-menu-item` in Phase 3.
4. **The metric tile is written inline** in the Dashboard, Audit,
   Communications, AI, Billing, Claims and Reports pages. It moves to `Metric` /
   `lh-metric-value` in Phase 5.
5. **Tab and segmented toggles are hand-built** in `ScheduleCalendar`
   (Day/Rooms/Week), `PatientFile` (10 tabs), Claims and Reports. They move to
   `SegmentedControl` / `Tabs` in Phase 5.

---

## 2. Token map: Ocean Flow to Clinical Glass

### Typography

The legacy step names keep working. Body and table sizes are unchanged, so
dense screens stay dense. Only the smallest step and the heading steps move.

| Legacy class | Before | After | Clinical Glass name |
|---|---|---|---|
| `text-2xs` | 9px | **10px** | (too small for the new scale; being phased out) |
| `text-xs` | 11px | 11px | `text-micro` |
| `text-sm` | 12px | 12px | `text-caption` |
| `text-base` | 13px | 13px | `text-small` |
| `text-md` | 14px | 14px | `text-copy` / `text-control` |
| `text-lg` | 16px | **17px** | `text-section` |
| `text-xl` | 19px | **20px** | `text-heading` |
| `text-2xl` | 23px | **28px** | `text-page` / `text-metric` |
| (none) | — | 15px, 32px, 36px | `text-copy-lg`, `text-page-lg`, `text-display` |

The body size token is called **`copy`**, not `body`. `body` is already a
text colour, and when two tokens share a name Tailwind emits both rules, so
every `text-body` paragraph would have been silently resized to 14px.

**Font family:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter,
system-ui, sans-serif`. Inter is now the fallback rather than the primary
font. The print layouts keep their own font stack.

### Radius

| Class | Before | After |
|---|---|---|
| `rounded-xs` | — | 6px |
| `rounded-sm` | 5px | 8px |
| `rounded` | 7px | 10px |
| `rounded-md` | 10px | 12px (buttons, inputs) |
| `rounded-lg` | 13px | 14px (grouped controls) |
| `rounded-xl` | — | 16px (tables, toasts) |
| `rounded-2xl` | — | 20px (cards, popovers, context bar) |
| `rounded-3xl` | — | 24px |
| `rounded-4xl` | — | 28px (modals) |

### Colour

The palette is unchanged apart from `canvas` (`#f7fafe` → `#f5f8fc`) and new
`--canvas-top` / `--canvas-bottom` gradient stops. The spec's suggested
tertiary ink `#73839a` is **not** adopted: it measures about 3.9:1 on white
and would fail WCAG AA for small text. `muted` (`#5f7085`) stays as the lowest
text tone.

### New token families

- **Shadows:** `shadow-hairline`, `card`, `raised`, `float`, `modal`,
  `control`, `focus`, `nav-active`. All are blue-tinted and none are grey.
- **Glass:** `backdrop-blur-subtle` (18px), `-glass` (22px), `-elevated`
  (28px), each paired with a `backdrop-saturate-*`. The fills come from the
  CSS variables `--lh-glass-subtle` (0.62), `--lh-glass` (0.78) and
  `--lh-glass-elevated` (0.90), which dark mode swaps out.
- **Control heights:** `h-control-sm` 32px, `h-control` 38px,
  `h-control-lg` 42px, `h-nav` 38px.
- **Motion:** `duration-instant` 80ms, `fast` 120ms, `normal` 180ms,
  `slow` 240ms. `ease-fluid` is `cubic-bezier(.2,.8,.2,1)` and `ease-spring`
  is also available. The **default `transition` class** is now 180ms with the
  fluid curve, so every existing transition picks it up.
- **Animations:** `animate-modal-in`, `pop-in`, `fade-in`, `toast-in` and
  `shimmer`. `prefers-reduced-motion` still collapses all of them.
- **Z-index names:** `z-header` 20, `z-backdrop` 30, `z-menu` 40, `z-modal`
  50, `z-palette` 55, `z-toast` 60. These are the same numbers as before, now
  named.
- **Letter spacing:** `tracking-heading` (−0.015em), `tracking-title`
  (−0.025em).
- **Spacing:** Tailwind's default scale already covers 2–64px (`0.5` through
  `16`), so no new spacing tokens were needed.

---

## 3. Shared primitives

### CSS classes (`src/index.css`)

| Group | Classes |
|---|---|
| Glass | `lh-glass-subtle`, `lh-glass`, `lh-glass-elevated` |
| Surfaces | `lh-surface`, `lh-surface-soft` |
| Cards | `lh-card`, `lh-card-pad` (restyled), `lh-card-flat`, `lh-card-elevated`, `lh-card-soft` |
| Page | `lh-page-title` (28px), `lh-page-subtitle` (15px), `lh-page-kicker`, `lh-section-title` |
| Metrics | `lh-metric`, `lh-metric-icon`, `lh-metric-value`, `lh-metric-label` |
| Buttons | `lh-btn-primary`, `-secondary`, `-tertiary`, `-danger` (outline), `-danger-solid`, `lh-btn-icon`. The legacy `lh-primary-button` and `lh-secondary-button` are aliases. |
| Forms | `lh-label`, `lh-input`, `lh-select`, `lh-textarea` |
| Navigation | `lh-segmented`, `lh-segmented-item`, `lh-segmented-thumb`, `lh-tabs`, `lh-tab` |
| Data | `lh-table-shell`, `lh-table-head`, `lh-table-row`, `lh-list-row`, `lh-section-label` (now 12px sentence case), `lh-eyebrow` (kept uppercase for metadata) |
| Floating | `lh-popover`, `lh-menu-item`, `lh-modal`, `lh-backdrop`, `lh-context-bar` |
| Status and AI | `lh-pill`, `lh-ai-surface`, `lh-ai-thinking`, `lh-skeleton` |

Every class that is white has an explicit `body.lh-dark` rule. The older
`[class*="bg-white"]` dark overrides cannot see fills applied through
`@apply`.

### React (`src/components/ui.jsx`)

| Component | Change |
|---|---|
| `Modal` | Elevated glass, 28px radius, fade and scale entrance, softer backdrop. The focus trap, Escape handling, first-field focus and focus return are **unchanged**. |
| `Field` | Label is now 12px medium sentence case, instead of 9px uppercase. |
| `Input` / `Select` / `Textarea` | 42px high, 12px radius, 14px text, a soft focus ring rather than an outline. |
| `Button` | Adds `tertiary` and `danger-solid` variants. Now **merges `className`** (it was silently dropped before; this affects one call site, `SettingsPage.jsx:723` `mt-3`). |
| `Toast` | Dark translucent glass, 16px radius, info icon, entrance animation. Still `role="status"` with `aria-live="polite"`. |
| `EmptyState` | Quiet soft surface with a small round icon. It is now the only empty state. |
| `HumanAvatar` | Shadow moved to a token. |
| **New:** `SegmentedControl` | Radio-group semantics, arrow-key navigation, a sliding thumb measured with `ResizeObserver`. |
| **New:** `Tabs` | `role="tablist"`, scrolls horizontally for long tab sets, optional counts. |
| **New:** `Metric`, `Badge`, `Skeleton` | Unframed metric by default (`framed` for a tile), a neutral count badge, and a shimmer placeholder. |

`shared/StatusPill` now has a soft fill, a hairline ring, 11px text and
sentence case. Sentence case is applied with `first-letter:uppercase`, so
**the DOM text is unchanged**.

---

## 4. Migration sequence

| Phase | Scope | Files | Status |
|---|---|---|---|
| 1. Foundation | Tokens, CSS variables, dark-mode variables, verifier scales | `tailwind.config.js`, `index.css`, `scripts/verify-tokens.mjs`, `scripts/verify-contrast.mjs` | **Done** (`89f3816`) |
| 2. Primitives | Shared classes and `ui.jsx` components, StatusPill, EmptyState consolidation | `index.css`, `ui.jsx`, `shared/StatusPill.jsx`, `shared/EmptyState.jsx` | **Done** (`6ed1603`) |
| 3. Shell | Sidebar grouping (Care / Finance / Engagement / Intelligence, still role-filtered), nav item styling, header search trigger, alerts, account and workspace menus → `lh-popover`, command palette, fewer waves | `LuminaryDemo.jsx` (chrome markup only), `config/access.js` (adds a presentation-only `navGroups` list; permissions untouched) | **Done** (`536d9ba`) |
| 4. Context | Patient context bar → `lh-context-bar`, patient file banner, allergy and break-glass strips | `LuminaryDemo.jsx`, `PatientFile.jsx` | Not started |
| 5. Pages | In order: Overview, Patients, Patient file, Appointments (and `ScheduleCalendar`), Clinical (and `EncounterNote`), Orders, Billing, Billing queue, Claims, Tariffs, Communications, Reports, Luminary AI, Audit, Settings | `components/pages/*`, `PatientFile.jsx`, `EncounterNote.jsx`, `ScheduleCalendar.jsx` | Not started |

Each phase is its own commit, or several for Phase 5 (one per page), so any
single step can be undone with `git revert`.

---

## 5. Regression risks and how each is checked

| Risk | Where | Mitigation |
|---|---|---|
| Token name collision (a font size and a colour with the same name) | `tailwind.config.js` | Found and fixed (`body` → `copy`). The config is checked programmatically for size/colour name clashes. |
| Controls grow taller (38–42px), so tight rows may wrap | Forms in dialogs, Settings, Billing queue | Visual pass in Phase 5. Only text-like inputs use `Input`, so there are no checkbox or file inputs at 42px. |
| `text-2xl` grows 23 → 28px | Claims header, Billing receipt amount, Clinical tiles | None are in fixed-width boxes. Reviewed page by page in Phase 5. |
| Dark mode misses a new fill | Any `@apply`-only white surface | Each primitive has an explicit `body.lh-dark` rule. Check dark mode in each phase. |
| Blur creates stacking contexts, so dropdowns end up underneath | Header, context bar, glass cards | The layering notes in `index.css` are kept. `verify:menus` runs after each phase. |
| Motion and accessibility | Modal, toast, segmented thumb | Reduced-motion rule is unchanged. The segmented control uses radio semantics and arrow keys. The modal focus logic is untouched. |
| Printing | Receipts, invoices, statements, prescriptions | The print CSS is untouched and uses its own font stack. |
| Behaviour change | Anywhere | No handlers, props, API calls or permission checks change. `verify:render` renders as all 8 seeded users and checks tenancy each phase. |

### Checks run after each phase

```text
npm run verify:tokens     npm run verify:contrast   npm run verify:money
npm run verify:render     npm run verify:menus      npm run build
eslint on every changed file
```

The baseline on `main` before any change already had **2 contrast failures**
(`text-muted` on `bg-line` in `ClaimsPage.jsx:392` and `ReportsPage.jsx:488`)
and **6 `verify:menus` failures**. Both phases reproduce exactly those results
and add no new failures. The contrast pair will be fixed when those pages are
migrated in Phase 5.

---

## 6. How to revert

| To undo | Run |
|---|---|
| Everything | `git switch main`. `main` has not been touched. To discard the branch: `git branch -D design/ocean-flow-2` |
| Phase 2 only | `git revert <phase-2 commit>` |
| Phase 1 only | `git revert <phase-2 commit> 89f3816` (Phase 2 depends on the Phase 1 tokens, so revert both, newest first) |
| Return to the exact starting point | `git switch -c recovered restore-point-2026-09-25` |

Nothing has been pushed to `origin` or `demo`, and nothing has been deployed.
