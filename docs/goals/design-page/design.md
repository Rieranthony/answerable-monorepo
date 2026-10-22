# The design page: design

Written 2026-10-22, before any code. Facts come from [findings.md](findings.md); each decision the owner has to take is listed at the end as D1 to D14.

## What we build

A page at `/design` on the landing site that takes a `DESIGN.md`, turns it into the CSS variables the `@answerable/ui` components consume, and shows the design system working: the palette, the type scale, the shape and line rules, every interface component and every statement component, with a floating pane at the top right that changes any token live. Ours first; later anyone's file, and files generated on the fly.

Three pieces make that possible, and each is useful on its own:

1. **A token contract in `@answerable/ui`.** Every visual decision a component makes reads a CSS variable with our default, and every default can be overridden by a second variable the library itself never sets. Tailwind utilities and the shadcn components both go through the contract, so one injected block restyles the whole tree.
2. **`@answerable/design`, our spec on top of design.md.** A pure TypeScript package: the Answerable profile of the format, a parser built on Google's official linter, a resolver for the profile's extension groups and for the roles that bind a design's own token names to the library's semantic slots, a CSS emitter, colour conversion, and the Google Fonts catalogue.
3. **The runtime and the page.** A provider that holds the design state and injects the variables at the root (one component, shared state, no prop drilling), a font loader, the showcase, and the pane.

## 1. The token contract

### The override pattern

The library declares each contract variable with a hook and a default:

```css
:where(:root, [data-design-scope]) {
  --primary: var(--design-primary, #000000);
  --control-md: var(--design-control-md, 36px);
}
@theme inline {
  --color-primary: var(--primary);
}
```

- **The hook** (`--design-*`) is never declared by the library. Whoever declares it wins without a specificity fight: an inline style on `<html>`, a hoisted `<style>` block, a `style` attribute on a section. `unset` restores the default.
- **`@theme inline`** makes Tailwind emit `var(--primary)` straight into the utility (verified: `.bg-primary { background-color: var(--primary) }`), so utilities read the variable where the element sits.
- **`:where()`** keeps the defaults at zero specificity, and `[data-design-scope]` lets a subtree re-declare them: the pane wears the default design even while the page around it is being changed, and a later "compare two designs" view can host two scopes side by side.
- The `.dark` block uses the same hooks with dark defaults: `--primary: var(--design-primary, #ffffff)`.

Tailwind's own scales become overridable the same way, inline with a fallback (all verified in [findings.md](findings.md)): `--spacing: var(--design-spacing-unit, 0.25rem)` scales every `p-*`, `gap-*`, `h-*`, `size-*` and `/n` leading at once; `--radius-*` derive from `--radius`; `--shadow-xs|sm|md|lg` read the elevation tokens; `--font-weight-*`, `--tracking-*`, `--ease-*` and the default transition duration read theirs.

### The contract (the variables components consume)

| Group | Variables | Source in the profile |
|---|---|---|
| Colour roles (shadcn's set) | `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, `border`, `input`, `ring`, `sidebar-*` | `roles` |
| Colour roles (ours) | `overlay`, `surface-dark`, `on-dark`, `on-accent`, `success`, `warning`, `info`, `highlight-1` to `highlight-4` (the rotation palette, in rotation order), `chart-1` to `chart-5` | `roles`, defaulting from `colors` by name |
| Fonts | `font-sans`, `font-mono`, `font-system` | `fonts` |
| Type levels | per level `type-<level>-size`, `-weight`, `-leading`, `-tracking`, plus `-transform` and `-numeric` where set | `typography` |
| Weights | `weight-body`, `weight-label`, `weight-statement` | `fonts.<default>.weights` roles |
| Shape | `radius`, `radius-full` | `rounded` |
| Spacing | `spacing-unit` | `spacing.unit` |
| Sizes | `control-sm`, `control-md`, `control-lg`, `control-xl`, `nav-height`, `sidebar-width`, `content-max`, `prose-max` | `sizes` |
| Elevation | `elevation-none`, `-xs`, `-sm`, `-md`, `-lg` | `elevation` |
| Lines | `line-separator-width`, `line-separator-color`, `line-statement-width`, `line-statement-emphasis-width`, `line-statement-heavy-width`, `line-statement-color` | `lines` |
| Focus | `focus-ring` | `focus.ring` |
| Motion | `duration-fast`, `duration-base`, `duration-slow`, `ease` | `motion` |

Every one of them exists as `--<name>` (consumed) and `--design-<name>` (hook). The list is the contract: the emitter writes exactly these, the stylesheet declares exactly these, and a test in `@answerable/design` fails when they drift.

### Type levels as utilities

Each typography level becomes a Tailwind utility generated from the design: `type-heading-h2`, `type-ui-text`, `type-statement-xl`, … setting size, weight, line height, letter spacing (and transform or numeric where the level has them), each through its variables. Components use `type-button`, `type-label`, `type-badge` instead of `text-sm font-medium`, so a level edited in the pane moves every component that uses it. Tailwind's `text-xs`, `text-sm`, `text-base` and `text-lg` are bound to the four interface levels (badge, ui-text, body-md, body-lg) so the shadcn components we import keep working and still follow the design.

### Defaults generated from DESIGN.md

`packages/ui/src/styles/tokens.css` (the `:where(:root …)` block and the `type-*` utilities) is written by `bun run --filter @answerable/design generate` from the repository's `DESIGN.md` and committed, like `openapi.json` and the MCP manifests: a test fails when the file drifts from the source. The dark scheme stays hand-written in `globals.css` until the profile grows a `schemes` group, so the landing site and ID's pages keep their dark look.

### The components

The showcase needs the interface layer the DESIGN.md names. `packages/ui` gains, from the base-nova registry (all verified served): badge, card, tabs, switch, checkbox, radio-group, select, slider, dialog, tooltip, popover, dropdown-menu, table, alert, progress, skeleton, avatar, separator, textarea, toggle-group, kbd, label, scroll-area and toast. The existing button, input, field, form, combobox and input-group stay. Every component is then restyled to the DESIGN.md through the contract: fills instead of borders, square corners, the three weights, `control-*` heights, elevation instead of outlines, the black focus ring. The button grows the `accent` variant (rotation palette, 48px) and the `sm | md | lg | xl` sizes. ID's login inputs read `inputClassName`, so they change with it; its dark scheme is checked by eye in the kind stack or the ID dev server before landing.

The statement layer (hero statement, stat, stat display, quote panel, highlight panel, numbered steps, statement divider, accent button) is new and lives in `packages/ui/src/components/statement/*`: these are the pieces a presentation or report page would use, so they belong to the library, not to the page.

## 2. The Answerable profile of design.md

### Stance

A file in the Answerable profile is a valid design.md file: the base groups keep the spec's types, sections keep the spec's order, and the official tools read it. The profile adds typed groups the spec leaves to prose, and lets a reference point anywhere in the YAML tree, which the spec's own wording allows ("an object path to another value in the YAML tree") but the official linter does not implement. So the official linter reports a reference into a profile group as `broken-ref` (20 errors on our file today); our linter wraps the official rules, resolves those references, and reports the rest. We open an issue upstream for references into unknown groups; until it lands, the page shows both verdicts side by side.

### Groups

Base (unchanged): `version`, `name`, `description`, `omitted`, `colors`, `typography`, `rounded`, `spacing`, `components`.

Profile:

| Group | Shape | Why |
|---|---|---|
| `fonts` | map of `{ family, provider: google, weights: number[], fallback, default?: true }` | One place for the typeface, its weights and where to load it from; typography levels without `fontFamily` inherit the default font. Replaces the `fontFamily`, `weights` and `rules` keys our file has beside the levels (the official model iterates them as levels today: 43 warnings). |
| `roles` | map of role → reference or literal, for every contract colour, `radius`, `font-sans`, `font-mono` | Binds a design's own names (`accent-coral`, `neutral-100`) to the library's slots. Missing roles are inferred: `primary` ← `colors.primary` ?? `colors.foreground`; `background` ← `colors.background` ?? `colors.surface` ?? white; `muted` ← `colors.muted` ?? the lightest neutral; `destructive` ← `colors.destructive` ?? `colors.error`; and so on. Inference is what lets someone else's file render at all. |
| `sizes` | map of Dimension | Control heights, nav height, sidebar and content widths. |
| `elevation` | map of CSS shadow string | Soft shadows by level. |
| `lines` | map of `{ width: Dimension, color: Color }` | Separators and dividers. |
| `focus` | `{ ring: CSS shadow string }` | The focus ring. |
| `motion` | map of duration or easing | Durations and the easing curve. |
| `output-rules` | map of string | Rules for agents producing documents with the system; kept, shown on the page, never styled. |
| `spacing.unit` | Dimension, required by the profile | Tailwind 4 scales from one unit; named steps stay as documentation. |

Profile rules: a `typography` level may set `textTransform` and `fontVariantNumeric` (our file already does); `spacing` keys must be CSS identifiers (`half`, not `"0.5"`: the official Tailwind export rejects it); section headings accept British spelling and extra sections (the official linter already accepts "Colour" and "Shape"; only the order of Elevation and Layout is out of spec in our file).

### What changes in our DESIGN.md

1. Remove the code fence on lines 1 and 870 and the blank line before the front matter (the file has no front matter at line 1 today, so nothing parses).
2. `statement-quote:{` and `nav-link-active:{` need a space after the colon (YAML rejects the file).
3. Move `typography.fontFamily`, `typography.weights` and `typography.rules` into `fonts.sans` and the Typography prose.
4. Add `spacing.unit: 4px`; rename `"0.5"` to `half`.
5. Add `colors.primary: "{colors.foreground}"` (the official `missing-primary` warning; every other consumer looks for it).
6. Add the `roles` group (about 25 lines).
7. Swap the Layout and Elevation sections (the one official `section-order` warning).

Nothing else moves: the prose, the components, the accents, the rules stay the owner's words.

## 3. `@answerable/design`

`packages/design`, no semicolons, Bun tests, 100% line and function coverage like the other packages. Two entry points:

- **`@answerable/design`** (client-safe, no Node): the `Design` type (JSON, what the server hands the page), `designToCss(design) → { [hook]: value }`, `serializeCss(vars, selector)`, `designToMarkdown(design)` (writes the edited tokens back into the original document, so "Copy DESIGN.md" exports what the pane changed), `parseColor` / `formatColor` / `contrast` on culori's tree-shakeable `fn` build, `googleFontsHref(families)`, and the fonts catalogue loader.
- **`@answerable/design/parse`** (server): `parseDesign(markdown) → { design, findings }` on `@google/design.md/linter`'s `lint()`: the official model and findings, then the profile pass (extension groups from `unknownKeyValues`, references across the tree, roles with inference, fonts, type levels). The official module imports `node:fs` and friends, so it never reaches the client bundle; the page parses at build, and a future "paste a file" runs it in a server action.
- **`google-fonts.json`**: generated by `bun run --filter @answerable/design fonts` from Google's public metadata (family, category, weights, italic, axes), committed, refreshed by hand. 1,950 families; the pane loads it lazily.
- **Fixtures**: our DESIGN.md and the three Google examples (Atmospheric Glass, Paws & Paths, Totality Festival), so the roles inference is proven on files that never heard of us. A test runs our linter on the repository's `DESIGN.md` and fails on any error, so CI guards the file.

The package depends on `@google/design.md` 0.4.0 (zod 3 nests under it with the hoisted linker; web's zod 4 and the single `fumadocs-core` are untouched, and `apps/web/lib/fumadocs.test.ts` keeps proving that), `culori` 4.0.2 and `yaml` 2.9.1.

## 4. The runtime in `@answerable/ui`

`packages/ui/src/design/`:

- `DesignProvider` (client): holds `{ design, overrides }`, exposes `useDesign()` (the resolved tokens, `set(path, value)`, `reset(path?)`, `css`, `markdown`). The provider is the only state; the pane and the showcase both read it.
- `DesignVars`: renders `<style href="design-vars" precedence="design">:root { --design-…: … }</style>`; React 19 hoists it into `<head>` on the server and the client (verified), so the first paint already carries the design and later edits replace the block. A `scope` prop renders `[data-design-scope="…"] { … }` instead.
- `DesignFonts`: for every font the design or an override names that `next/font` did not self-host, a hoisted `<link rel="stylesheet" precedence="design-fonts">` to the CSS2 API with the weights the design uses (`wght@400;700;900`, verified). Public Sans stays on `next/font` (self-hosted, no layout shift).

## 5. The page

### Routing

Two root layouts through route groups (Next 16 supports several, each with its own `<html>`): `app/(site)/layout.tsx` (today's dark layout; `page.tsx`, `docs/`, `oauth-test/` move under it) and `app/(design)/layout.tsx` (light, `viewport.colorScheme: "light"`, Public Sans from `next/font`, `DesignProvider` around the page). Route handlers, icons, `robots.ts` and `sitemap.ts` stay at `app/`. `/design.md` serves the raw DESIGN.md with `text/markdown`, as the docs do.

### Static

`app/(design)/design/page.tsx` reads `../../DESIGN.md` at build (`../../DESIGN.md` joins `web#build`'s inputs in `turbo.json`), parses it with `@answerable/design/parse`, and passes the `Design` JSON to the provider. No fetch at runtime; the official linter stays on the server.

### Showcase, top to bottom

Content follows the file's own sections, so a different DESIGN.md reorders the page by itself. Each section is a real layout built from the library, with the matching prose one click away ("Read the rule").

1. **Header.** The design's `name`, `description` and `version`, the lint verdicts (ours and the official one), and the actions: Copy CSS, Copy DESIGN.md, Download.
2. **Overview.** A hero statement in `statement-xl` with the lead copy, followed by one accent button (rotation, Sky first).
3. **Colour.** Core, neutral and accent swatches with their hex and oklch, every role's contrast against its background with the WCAG verdict, and the rotation explained with four stat blocks.
4. **Typography.** The full scale as a specimen table (every level set in itself), the three weights, a paragraph at `prose-max`.
5. **Shape, lines and focus.** Square controls, the two line kinds, the focus ring on a focused control.
6. **Elevation.** The four levels on the shell background, next to the flat statement panel.
7. **Layout.** The app shell: 56px top nav, 256px sidebar, content at 1200px, the two cards on their right surfaces.
8. **Components, interface layer.** Buttons (every variant and size), forms (input, textarea, select, checkbox, radio, switch, the error marker), surfaces (card, dialog, dropdown, popover, tooltip), navigation (tabs, sidebar), feedback (badge, alert with its marker, toast, skeleton, progress), data (a table with tabular numbers and a small chart in the four accents).
9. **Components, statement layer.** Stat row, stat display, both quote panels, highlight panel, numbered steps, divider.
10. **Do's and don'ts.** Two columns from the prose.
11. **Lint.** Every finding with its path, ours and the official one.

Everything above is a client-neutral server component tree except the pane and the few interactive demos; the provider sits at the layout.

### The pane

A floating panel at the top right inside a `data-design-scope` so it always wears the default design, collapsing to a 36px square. Sections, each an accordion item:

- **Colours**: one row per role and per named colour: swatch, a text field that accepts any CSS colour (hex, rgb, hsl, oklch, lab, named; culori parses them), converted on blur to the canonical form, a hex and an oklch readout, and the contrast against the role's background.
- **Type**: the typeface (a combobox over the Google Fonts catalogue, grouped by category, loading the family on pick), the three weight roles, and the level table (size, weight, leading, tracking per level).
- **Shape**: the radius (0 to 24px) and `radius-full`.
- **Spacing**: the unit (2 to 8px).
- **Sizes**, **Elevation**, **Lines**, **Motion**: their tokens.
- **Actions**: Reset all, Copy CSS, Copy DESIGN.md.

State lives only in the provider; the URL carries nothing yet (a share link is a later step, below).

## 6. Later, not in this goal

- **Other people's files**: paste, upload or a URL, parsed by a server action with the same `parseDesign`; the roles inference and the fixtures make this a page change, not a library change.
- **Share links**: the overrides encoded in the URL.
- **Generate with AI**: a server action that writes a DESIGN.md from a prompt with the Claude API, then the same pipeline; the profile's typed groups are the schema the model fills.
- **Dark scheme in the profile** (`schemes.dark`), so the site's hand-written `.dark` block is generated too.
- **Upstream**: the issue on references into unknown groups; the three example files prove our reader on theirs.

## 7. Gates

- `bun run --filter @answerable/design test` (100% coverage; fixtures; the repository DESIGN.md lint; the contract and the generated stylesheet drift tests).
- `bun run typecheck`, `bun run lint`, `bun run build`, `bun --filter web test` (link check, Fumadocs single-core test), `scripts/check-metadata.ts` against the production build with `/design` added to its paths.
- `bunx knip` after adding the package (`knip.json` gets its entries).
- By eye, in the Browser pane: `/design` at desktop and phone width, the pane open and closed, a colour, a font, the radius and the unit changed; `/`, `/docs` and ID's login page unchanged in dark.

## 8. Briefs

Three briefs for Opus 5.5, each a session in its own worktree:

- **B1, the contract and the components** (`packages/ui`): tokens.css by hand per the contract, `globals.css` on the hooks, the type utilities, the registry components added and restyled, the statement components, the runtime (`DesignProvider`, `DesignVars`, `DesignFonts`).
- **B2, the package** (`packages/design` and the DESIGN.md edits): parser, profile, roles, emitter, markdown writer, colour, fonts catalogue and script, generator, fixtures, tests.
- **B3, the page** (`apps/web`): route groups, `/design`, `/design.md`, the showcase, the pane, turbo inputs, metadata, sitemap, check-metadata.

B1 and B2 run in parallel against the contract table above; B3 starts when both have landed. B2's generator must reproduce B1's hand-written tokens.css byte for byte (the drift test), which is the proof that the contract was followed on both sides.

## Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Edit DESIGN.md as listed in section 2 (fence, blank line, two YAML typos, fonts group, spacing unit, primary, roles, section swap) | Yes; nothing in the prose changes |
| D2 | The profile accepts that the official linter reports references into profile groups as errors, and we file the upstream issue | Yes; the alternative (literal values in components) loses the references that make the file readable |
| D3 | A new pure package `@answerable/design` plus the React runtime in `@answerable/ui`, rather than everything in the UI package | Yes; the parser and emitter are testable and reusable without React, and the official module is server only |
| D4 | The UI library's light defaults are generated from DESIGN.md and committed with a drift test; the dark scheme stays hand-written for now | Yes |
| D5 | Restyle every component to DESIGN.md through the contract (fills, square, three weights, control heights), knowing ID's inputs follow | Yes; it is also the brand rule the memory records (no borders, filled inputs) |
| D6 | Type levels as generated `type-<level>` utilities, with `text-xs/sm/base/lg` bound to the four interface levels | Yes |
| D7 | Two root layouts through route groups; `/design` is light, the rest of the site stays dark | Yes |
| D8 | Our file is parsed at build; other files later through a server action, never in the browser | Yes |
| D9 | The fonts catalogue is generated from Google's public metadata endpoint (categories, popularity) and committed | Yes; Next's own list has no categories |
| D10 | Colours are kept as written, converted to hex for DESIGN.md and CSS, with an oklch readout in the pane | Yes; the spec recommends hex and the official model works in sRGB |
| D11 | The statement layer components live in the library, not in the page | Yes |
| D12 | `/design.md` serves the raw file | Yes |
| D13 | The page header shows the design's `name` and `description` (its metadata), although the output rules forbid the brand name in produced documents | Yes; the page is about the system, not a document made with it |
| D14 | Three briefs to Opus 5.5 in worktree sessions, B1 and B2 in parallel, then B3, landed straight on main | Yes |
