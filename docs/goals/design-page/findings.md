# Findings

Facts verified against the repository, installed sources or the network. Each has a source.

## The repository (2026-10-22)

- `DESIGN.md` at the root (untracked) is wrapped in a ``` fence on its first and last line (lines 1 and 870); the real front matter starts on line 3. `version: beta` (the spec says `alpha`). It uses sections the spec does not name: `output-rules`, `sizes`, `elevation`, `lines`, `focus`, `motion`, and colour references like `"{colors.neutral-100}"`; `typography` carries a `fontFamily` string, `weights` and `rules` beside the levels; components carry free-text values ("4px square destructive marker beside the label").
- `packages/ui` (`@answerable/ui`): source-only exports `./globals.css`, `./components/*`, `./lib/*`. shadcn `base-nova` style on `@base-ui/react` 1.7, Tailwind 4, `tw-animate-css`, `class-variance-authority`. Components today: button, combobox, country-select, field, flag, form, input-group, input. `globals.css` holds `@theme inline` (fonts, colours, radius steps computed from `--radius`) and `:root` / `.dark` palettes in oklch, `--radius: 0`.
- `apps/web`: Next 16.2.6, React 19.2.4, Tailwind 4 via `@tailwindcss/postcss`. Root layout is dark only (`className="dark"`, `viewport.colorScheme = "dark"`), loads Public Sans with `next/font/google` into `--font-sans`. Prettier without semicolons. `app/globals.css` imports the UI CSS and the Fumadocs presets. Pages: `/`, `/docs/*`, `/oauth-test`, `/llms*`, `/og/*`.
- `knip.json` lists `apps/web` entries (`app/**`, tests, scripts) and `packages/*` entries (`src/index.ts`, tests); a new package needs an entry there.
- Gates for web: `bun run typecheck` (`next typegen && tsc`), `bun run lint`, `bun run build`, `bun --filter web test`. `packages/ui` has typecheck and lint, no tests yet.

## The design.md spec (google-labs-code/design.md, docs/spec.md, fetched 2026-10-22)

- Two parts: markdown prose and YAML tokens, in front matter and/or ```yaml blocks; blocks merge; a top-level key defined twice is an error.
- Schema keys: `version`, `name`, `description`, `omitted`, `colors` (map of CSS colour strings), `typography` (map of {fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, fontFeature, fontVariation}), `rounded` (map of Dimension), `spacing` (map of Dimension | number), `components` (map of map of string | reference). Dimension units: px, em, rem. References: `{path.to.token}`; primitives only outside `components`.
- Sections, in order, all `##`: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts. Unknown sections are preserved; unknown token names accepted when the value is valid; unknown component properties accepted with a warning; duplicate section headings or duplicate top-level keys reject the file.
- Component property tokens: backgroundColor, textColor, typography, rounded, padding, size, height, width.
- The spec is "alpha"; the components part is "actively evolving".

## Probes (2026-10-22)

### Tailwind 4.3.3 emission (compiled with `@tailwindcss/node` from `apps/web`)

- `@theme inline { --color-primary: var(--primary) }` emits `.bg-primary { background-color: var(--primary) }`: the utility reads the variable where the element sits, so an override on `:root` or on any ancestor applies.
- `@theme { --color-brand: var(--brand) }` (not inline) emits `:root { --color-brand: var(--brand) }` in the theme layer and `.bg-brand { background-color: var(--color-brand) }`: an override of `--brand` works on `:root` only.
- Inline works for every kind of token, with a fallback: `--text-sm: var(--ui-text-sm, 0.875rem)` → `.text-sm { font-size: var(--ui-text-sm, 0.875rem) }`; `--font-weight-medium: var(--ui-weight-label, 500)` → `.font-medium { font-weight: var(--ui-weight-label, 500) }`; `--radius-lg: var(--ui-radius-control, 0)` → `.rounded-lg { border-radius: var(--ui-radius-control, 0) }`; `--spacing: var(--ui-space, 0.25rem)` → `.h-8 { height: calc(var(--ui-space, 0.25rem) * 8) }` and `.text-sm/6` → `line-height: calc(var(--ui-space, 0.25rem) * 6)`; `--shadow-md: var(--ui-elevation-md, …)` → `.shadow-md { --tw-shadow: var(--ui-elevation-md, …) }`; `--ease-out`, `--tracking-tight` and `--default-transition-duration` the same way. One `--spacing` variable scales every `p-*`, `gap-*`, `h-*`, `w-*`, `size-*` and `/n` leading at once.
- Today `packages/ui/src/styles/globals.css` already uses `@theme inline` for colours, fonts and radius; sizes, weights, shadows, spacing, easing and durations are Tailwind's literal defaults.

### shadcn 4.19.0

- `shadcn/tailwind.css` (imported by the UI stylesheet) holds no colour tokens: the base-nova `data-*` custom variants, `scroll-fade-*`, `shimmer` and the accordion keyframes. The colour variables come from the `:root` and `.dark` blocks the init wrote into our globals.css.
- The base-nova registry (`https://ui.shadcn.com/r/styles/base-nova/<item>.json`) serves: accordion, alert, alert-dialog, avatar, badge, breadcrumb, button, button-group, card, checkbox, collapsible, combobox, command, context-menu, dialog, drawer, dropdown-menu, empty, field, hover-card, input, input-group, input-otp, item, kbd, label, menubar, native-select, navigation-menu, pagination, popover, progress, radio-group, scroll-area, select, separator, sheet, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toast, toggle, toggle-group, tooltip. Not served: meter, number-field, preview-card (Base UI has them; no shadcn wrapper).
- Base UI 1.7.0 ships accordion, alert-dialog, autocomplete, avatar, button, checkbox, checkbox-group, collapsible, combobox, context-menu, dialog, drawer, field, fieldset, form, input, menu, menubar, meter, navigation-menu, number-field, otp-field, popover, preview-card, progress, radio, radio-group, scroll-area, select, separator, slider, switch, tabs, toast, toggle, toggle-group, toolbar, tooltip.
- `apps/id` imports `inputClassName`, `cn`, the logo paths and the directory logos from `@answerable/ui/lib/*`, not the components or the stylesheet: restyling `inputClassName` changes ID's login inputs too.

### The official tooling: `@google/design.md` 0.4.0 (npm, 2026-07-27)

- Exports `lint(content) → { designSystem, findings, summary, tailwindConfig, sections, documentSections }` from `@google/design.md/linter`, plus `runLinter`, `DEFAULT_RULES` (broken-ref, missing-primary, contrast-ratio, orphaned-tokens, token-summary, missing-sections, missing-typography, unknown-key, token-like-ignored, omitted, section-order), `contrastRatio`, the emitters `CssVarsEmitterHandler` + `serializeCssVars({ prefix })`, `TailwindV4EmitterHandler` + `serializeTailwindV4`, `TailwindEmitterHandler` (v3 JSON), `DtcgEmitterHandler`, and `fixSectionOrder`. CLI: `lint`, `diff`, `export --format css-tailwind|json-tailwind|dtcg|css-vars`, `spec`.
- Model: `DesignSystemState` with `colors` (hex + rgb + alpha + luminance), `typography` (fontFamily, fontSize/lineHeight/letterSpacing as {value, unit}, fontWeight), `rounded`, `spacing`, `components` (properties map + `unresolvedRefs`), `symbolTable`, `unknownKeys` + `unknownKeyValues` (raw YAML of extension groups), `sections`, `documentSections` (heading + raw markdown).
- Dependencies: unified/remark (parse, frontmatter, mdx, stringify), yaml 2, zod 3 (we run zod 4; with Bun's hoisted linker a second zod nests under the package without touching web's or fumadocs' zod). Unpacked 1.6 MB. `dist/linter/index.js` imports `node:fs`, `node:path`, `node:url`, `node:module` and `node:process`: server only, never in the client bundle.
- Runs under Bun 1.3.1 (`bun api-probe.ts` in the scratchpad).
- The Tailwind v4 export rejects our spacing key `"0.5"` (`INVALID_TOKEN_NAME`); the css-vars export emits 43 declarations (`--dm-color-accent-coral: #e9895e`, …) and skips components.

### Our DESIGN.md through the official linter

- As committed, nothing parses: the file is wrapped in a code fence (lines 1 and 870) and starts with a blank line, so there is no front matter at line 1 ("No YAML content found"). With the fence and the blank line removed, YAML still fails: `statement-quote:{` (line 84) and `nav-link-active:{` (line 110) lack the space after the colon ("Nested mappings are not allowed in compact mappings").
- With those four edits: 28 colours, 29 typography levels, 3 rounded, 12 spacing, 42 components parse. Summary: 20 errors, 142 warnings, 1 info. Errors: 20 `broken-ref` for references into our groups (`{sizes.control-md}`, `{elevation.xs}`, `{lines.interface-separator}`, `{sizes.sidebar-width}`, …). Warnings: 43 "not a recognized typography property" because `typography.fontFamily` (a string), `weights` and `rules` sit beside the levels and the model iterates them as levels; 83 `broken-ref` warnings for references inside free-text values ("background {colors.background} + {focus.ring}"); 9 `orphaned-tokens`; 1 `missing-primary` (no `colors.primary`); 1 `section-order`; 3 `token-like-ignored`; 2 `contrast-ratio`. `unknownKeys`: output-rules, sizes, elevation, lines, focus, motion.
- The official model resolves `{colors.neutral-100}` chains (muted → #f4f4f5), `rgba(0, 0, 0, 0.5)` (overlay → #00000080, a 0.5), typography references inside components (`typography: "{typography.button}"` → the level), and keeps unresolvable strings verbatim.

### Colour: culori 4.0.2 (npm, 2026-04-03)

- `parse()` reads hex (#RGB to #RRGGBBAA), rgb()/rgba(), hsl(), hwb(), lab(), oklch(), named colours and `transparent`; it does not read `color-mix()` or bare `display-p3 …`. `formatHex`, `formatHex8`, `formatCss(oklch)` and `wcagContrast` work: black on Coral 8.20:1, white on Coral 2.56:1, #52525B on white 7.73:1 (the DESIGN.md's "about 7:1" claim holds). Tree-shakeable (`culori/fn`), 1.5 MB installed, no side effects on `./fn`.

### Fonts

- `next/font/google` self-hosts a family named at build time; it cannot load a family chosen at runtime. Its metadata (`node_modules/next/dist/compiled/@next/font/dist/google/font-data.json`, 479 KB) lists 1,911 families with weights, styles, axes and subsets, without category or popularity.
- Google's public metadata endpoint (`https://fonts.google.com/metadata/fonts`, JSON after a `)]}'` prefix) lists 1,950 families with category (Sans Serif 722, Display 468, Handwriting 358, Serif 351, Monospace 51), per-weight entries, axes, subsets, popularity and lastModified. Public Sans: wght 100–900 variable, italics, popularity 82.
- The CSS2 API loads any family at runtime: `https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;700;900&family=Space+Grotesk:wght@300..700&display=swap` returns `@font-face` rules (verified).

### React and Next

- react-dom 19.2.4 hoists `<style href precedence>` and `<link rel="stylesheet" precedence>` into `<head>` (the client runtime documents the `precedence="default"` + `href` contract), so a client component can own a `:root { … }` block that the server also renders.
- Next 16.2.6 supports several root layouts through route groups (`app/(site)/layout.tsx`, `app/(design)/layout.tsx`, no top-level `layout.tsx`); navigating between them is a full page load. The web app's routes today: `page.tsx`, `docs/`, `oauth-test/`, `api/`, `og/`, `llms.txt`, `llms-full.txt`, `llms.mdx`, `actions.ts`, icons, `robots.ts`, `sitemap.ts` (only `/` is listed), `globals.css`.
- `scripts/check-metadata.ts` asserts canonical, OG and robots tags on `/`, `/docs`, one docs page and one API page against a production build; `createMetadata({ pathname, title, description, index })` in `lib/metadata.ts` builds them.
