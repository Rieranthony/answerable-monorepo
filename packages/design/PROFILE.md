# The Answerable profile of design.md

A DESIGN.md in the Answerable profile is a valid [design.md](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md) file. The profile adds what the spec leaves to prose:

- **Typed groups** for fonts, sizes, elevation, lines, focus, motion and output rules.
- **References anywhere** in the YAML tree, not only into the spec's groups.
- **Roles**, which bind the design's own names (`accent-coral`, `neutral-100`) to the slots the `@answerable/ui` components read (`destructive`, `muted`). A file without roles still renders: the parser infers them.

`parseDesign(markdown)` from `@answerable/design/parse` reads a file: Google's official linter first, then the profile pass. It returns a JSON `Design` with two lists of findings, the official linter's and the profile's.

## The groups

| Group | Shape | Defined by |
|---|---|---|
| `version`, `name`, `description`, `omitted` | Strings, as the spec says | Spec |
| `colors` | Name → CSS colour or reference | Spec |
| `typography` | Level → `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `fontFeature`, `fontVariation`; the profile adds `textTransform` and `fontVariantNumeric` | Spec, extended |
| `rounded` | Name → dimension | Spec |
| `spacing` | Name → dimension or number; the profile adds `unit` | Spec, extended |
| `components` | Component → property → value or reference | Spec |
| `fonts` | Key → font | Profile |
| `roles` | Role → reference or value | Profile |
| `sizes` | Name → dimension | Profile |
| `elevation` | Level → CSS shadow | Profile |
| `lines` | Name → `{ width, color }` | Profile |
| `focus` | `ring` → CSS shadow | Profile |
| `motion` | Name → duration or easing curve | Profile |
| `output-rules` | Name → rule, for agents producing documents with the design | Profile |

The official linter reports the profile groups as unknown keys and some as `token-like-ignored` warnings. Those warnings stay: the official tools do ignore the groups.

## References

Write `{path.to.value}` to take another value of the file. A path may end anywhere in the YAML tree: `{colors.neutral-100}`, `{sizes.control-md}`, `{fonts.sans.weights.body}`.

- **A whole value** that is one reference takes the referenced value, through any number of hops. It may name a group only in `components` (`typography: "{typography.button}"`), in `roles.font-sans` (`"{fonts.sans}"`) and in a level's `fontFamily`.
- **A reference inside text** (`"background {colors.background} + {focus.ring}"`) is replaced by the referenced value when that value is a single value; a reference to a group stays as written.
- **A key holding dots** is found as one key: `{spacing.0.5}` finds `spacing: { "0.5": 2px }`.
- **A missing or circular whole reference** is an error, and the value stays as written. A missing reference inside text is a warning.
- **The official linter** resolves references only into `colors`, `typography`, `rounded` and `spacing`, and reports a reference into a profile group as a `broken-ref` error. When the profile resolves it, the parser moves that error to a `profile-resolved-reference` info. A valid profile file has no errors.

## Colours

Any CSS colour [culori](https://culorijs.org) reads: hex, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color(display-p3 …)`, named colours and `transparent`. The model keeps the value as written and adds its sRGB hex: lowercase, six digits, or eight when the alpha is below 1 (`rgba(0, 0, 0, 0.5)` → `#00000080`). A colour culori does not read, such as `color-mix()`, takes the official linter's sRGB value, with an info.

Nested colour groups are flattened with dots, as the official linter does: `colors: { brand: { blue: … } }` is `colors.brand.blue`.

## Typography

```yaml
typography:
  heading-h1: { fontSize: 36px, fontWeight: 900, lineHeight: 1.1, letterSpacing: -0.8px }
  eyebrow:    { fontSize: 12px, fontWeight: 700, lineHeight: 1.2, letterSpacing: 1.2px, textTransform: uppercase }
  numeric:    { fontVariantNumeric: "tabular-nums" }
```

- **A level without `fontFamily`** takes the default font's family.
- **`fontFamily`** may be a family name, a stack (its first family counts), `{fonts.sans}` or `{fonts.sans.family}`.
- **Every entry is a level.** Fonts belong in `fonts`, rules in the prose: a `fontFamily` string, `weights` or `rules` beside the levels is a warning, and the official linter reads them as broken levels.
- Dimensions are kept as written. `lineHeight: 1.0` is the number 1.

Each level becomes a `type-<level>` Tailwind utility and a token per property: `--type-<level>-size`, `-weight`, `-leading`, `-tracking`, and `-transform`, `-numeric`, `-feature` or `-variation` where set. A level whose family is not the default font's also gets `-family`.

## Fonts

```yaml
fonts:
  sans:
    family: "Public Sans"
    provider: google
    weights:
      body: 400
      label: 700
      statement: 900
    fallback: "system-ui, sans-serif"
    default: true
```

| Key | Type | Rule |
|---|---|---|
| `family` | String | Required. The family as Google Fonts lists it; checked against the catalogue. |
| `provider` | `google` | Optional. Google Fonts is the only provider; any other is read as `google`, with a warning. |
| `weights` | Role → weight (1 to 1000) | Optional. `body`, `label` and `statement` give the weight roles; other names are allowed. A weight the family does not offer is a warning. |
| `fallback` | CSS font stack | Optional. Defaults by the catalogue's category: `system-ui, sans-serif`, `Georgia, serif` for serif, `ui-monospace, monospace` for monospace, `cursive` for handwriting. |
| `default` | Boolean | Optional. Levels without a family inherit the default font. With none marked, the first font is the default; with several, the first marked wins. |

A family a level names that `fonts` lacks becomes an inferred font, keyed by its name (`Space Grotesk` → `space-grotesk`), with an info. In a file without `fonts`, the default is the family of the first level whose name starts with `body`, else the family most levels use.

## Roles

`roles` binds each slot of the contract to a reference or a value:

```yaml
roles:
  primary: "{colors.primary}"
  destructive: "{colors.accent-coral}"
  font-sans: "{fonts.sans}"
  weight-body: "{fonts.sans.weights.body}"
  radius: "{rounded.default}"
  spacing-unit: "{spacing.unit}"
```

| Roles | Value |
|---|---|
| `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, `border`, `input`, `ring`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring` | A colour (shadcn's set) |
| `overlay`, `surface-dark`, `on-dark`, `on-accent`, `success`, `warning`, `info`, `highlight-1` to `highlight-4` (the rotation palette, in rotation order), `chart-1` to `chart-5` | A colour |
| `font-sans` | A font (`{fonts.sans}`), a family or a CSS stack |
| `weight-body`, `weight-label`, `weight-statement` | A weight |
| `radius`, `radius-full`, `spacing-unit` | A dimension |

A role the contract does not have is a warning. A value the role cannot take is an error, and the role is inferred instead.

### Inference

A role the file does not bind is inferred, with an info naming the source. The first source that exists wins; `colors.x` means the file's colour `x`.

| Role | Inferred from |
|---|---|
| `background` | `colors.background`, `colors.surface`, `#ffffff` |
| `foreground` | `colors.foreground`, `colors.on-background`, `colors.on-surface`, `#000000` |
| `primary` | `colors.primary`, `colors.foreground`, the foreground |
| `muted` | `colors.muted`, `colors.surface-container`, the neutral nearest the background, a 4% mix of the foreground into the background |
| `muted-foreground` | `colors.muted-foreground`, `colors.on-surface-variant`, a 60% mix |
| `card`, `popover` | `colors.card` (or `colors.popover`), `colors.surface-card`, `colors.surface-container-lowest`, the background |
| `secondary`, `accent`, `input` | `colors.secondary` (`accent`, `input`), the muted fill |
| `destructive` | `colors.destructive`, `colors.error`, the primary |
| `border` | `colors.border`, `colors.separator`, `colors.outline-variant`, `colors.outline`, a 10% mix |
| `ring` | `colors.ring`, the primary |
| `sidebar` | `colors.sidebar`, `colors.surface-container-low`, the background |
| `sidebar-primary`, `sidebar-accent`, `sidebar-border`, `sidebar-ring` | `colors.sidebar-…`, the primary, accent, border or ring |
| `overlay` | `colors.overlay`, `#00000080` |
| `surface-dark` | `colors.surface-dark`, `colors.inverse-surface`, the foreground |
| `on-dark` | `colors.on-dark`, `colors.inverse-on-surface`, the better contrast of foreground and background on `surface-dark` |
| `success`, `warning`, `info` | `colors.success` (`warning`, `info`), `#16a34a`, `#f59e0b`, `#0ea5e9` |
| `highlight-1` to `highlight-4` | `colors.highlight-n`, the file's `accent-*` colours in file order then `primary`, `secondary`, `tertiary`, `error`, repeated to fill four; the foreground when there are none |
| `on-accent` | `colors.on-accent`, the better contrast on `highlight-1` |
| `chart-1` to `chart-5` | `colors.chart-n`; the foreground, then the four highlights |
| `…-foreground` of `card`, `popover`, `primary`, `secondary`, `accent`, `destructive`, `sidebar`, `sidebar-primary`, `sidebar-accent` | `colors.<role>-foreground`; the `on-` colour of the colour the role came from (`primary` from `colors.primary` → `colors.on-primary`); the foreground on a background or `surface…` colour; the primary's or accent's foreground for a role copied from them; else the better contrast of foreground and background |
| `font-sans` | The default font; `system-ui, sans-serif` without fonts |
| `weight-body`, `weight-label`, `weight-statement` | The default font's `body`, `label` and `statement` weights; else 400, 700 and 900, each moved to the nearest weight the family offers |
| `radius` | `rounded.default`, `rounded.DEFAULT`, `rounded.md`, `rounded.sm`, `0px` |
| `radius-full` | `rounded.full`, `9999px` |
| `spacing-unit` | `spacing.unit`, `spacing.base`, `4px` |

## Sizes, elevation, lines, focus and motion

These groups feed the contract tokens by name. A token the file lacks takes the profile's default, with an info.

| Token | Read from | Default |
|---|---|---|
| `control-sm`, `control-md`, `control-lg`, `control-xl` | `sizes.<token>` | `32px`, `36px`, `40px`, `48px` |
| `nav-height`, `sidebar-width`, `content-max`, `prose-max` | `sizes.<token>` | `56px`, `256px`, `1200px`, `680px` |
| `elevation-none`, `-xs`, `-sm`, `-md`, `-lg` | `elevation.none` … `elevation.lg` | `none`, then Tailwind's `shadow-xs` to `shadow-lg` |
| `line-separator-width`, `-color` | `lines.separator`, or the first line named `…-separator` | `1px`, the border |
| `line-statement-width`, `line-statement-color` | `lines.statement`, or `lines.statement-standard` | `2px`, the foreground |
| `line-statement-emphasis-width`, `line-statement-heavy-width` | `lines.statement-emphasis`, `lines.statement-heavy` | `3px`, `4px` |
| `focus-ring` | `focus.ring` | `0 0 0 2px <background>, 0 0 0 4px <ring>` |
| `duration-fast`, `duration-base`, `duration-slow` | `motion.<token>` | `150ms`, `200ms`, `300ms` |
| `ease` | `motion.ease`, or `motion.easing` | `cubic-bezier(0.4, 0, 0.2, 1)` |

- **Values are copied as written**, except colours, which become lowercase hex.
- **`rule` and `usage`** inside `elevation`, `lines` and `focus` are prose: kept beside the tokens, never emitted.
- **Wrong shapes are warnings** and the value is ignored: a size that is not a dimension, a `duration-*` that is not a time (`120ms`, `0.2s`), a line without a dimensional `width` and a colour.
- Extra names are kept in the model but not emitted: the contract is the list above.

## Spacing

`spacing.unit` is the step Tailwind scales every `p-*`, `gap-*`, `h-*` and `size-*` from. The named steps stay as documentation. Keys must be CSS identifiers without dots (`half`, not `"0.5"`): Tailwind's export rejects a dotted name, so the parser warns.

## What the profile reports

Every profile finding has a `rule`:

| Rule | Severity | Meaning | What to do |
|---|---|---|---|
| `profile-yaml` | Error | No front matter or ```yaml block, YAML that does not parse, or a top-level key defined twice | Fix the YAML |
| `profile-reference` | Error, or warning inside text | A reference to nothing, a circular reference, or a colour referencing a group | Point it at a value |
| `profile-shape` | Warning | A group or value of the wrong shape; it is ignored | Follow the shapes above |
| `profile-color` | Info | A colour read with the official linter's value | None, or write hex |
| `profile-font` | Warning or info | A family not in the Google Fonts catalogue, a weight it lacks, several defaults; an inferred font | Use a catalogue family and its weights |
| `profile-role` | Error, warning or info | A role with a value it cannot take, an unknown role; an inferred role | Bind the role in `roles` |
| `profile-default` | Info | A contract token the groups lack, and the default it takes | Add it to its group |
| `profile-resolved-reference` | Info | An official `broken-ref` error the profile resolves | None |

The official findings keep their severities. `bun run --filter @answerable/design test` fails on any error in the repository's DESIGN.md.

## The contract and tokens.css

`packages/ui/src/styles/tokens.css` declares every token with this file's value behind a hook: `--primary: var(--design-primary, #000000)`. Declare `--design-<token>` anywhere and it wins. `bun run --filter @answerable/design generate` writes the file from the repository's DESIGN.md; a test fails when the committed file differs from the generator's output.

## Writing a design back

`designToMarkdown(original, design)` writes the design's values into the original file through the YAML Document API. Only values that differ from the file are rewritten, each in place; comments, order, alignment and prose stay byte for byte. A reference that still holds stays a reference. Colours are written as lowercase hex. Inferred roles and fonts, inherited families and components are not written.
