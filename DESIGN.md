---
version: beta
name: Answerable
description: >
  A presentation and product design system for a professional development and
  accountability platform for the built environment. Output must never include
  a logo, wordmark or brand name. The system has two layers: a quiet Interface
  layer of utilitarian, modernist components that get out of the way, and a
  bold Statement layer for headline moments, oversized numbers and quotes.
  Pure white (#FFFFFF) is the default background and pure black (#000000) the
  default text colour. A cool neutral scale supports surfaces, secondary text
  and separators. Four equal accent colours — Coral (#E9895E), Sky Blue
  (#A8DCE8), Yellow (#F3DD8F) and Green (#98AF48) — are used only for
  highlights and semantic states, always with black text and square corners,
  and are rotated so no single accent (especially Coral) dominates. Only three
  weights of Public Sans are used: Regular (400) for body text, Bold (700) for
  subheadings and labels, and Black (900) for main headings and big statements.
  Everything must be readable and clear in all situations. Components are
  defined by fill, space, typography and elevation — never by outlines or borders.

output-rules:
  logos: "Never render a logo, wordmark, monogram, corner marks or any brand device."
  brand-name: "Never write the brand name in titles, headers, footers, slide masters, captions or alt text unless the user's own content explicitly contains it."
  footers: "No branded footers, taglines, copyright lines or 'Presented by' slides."
  focus: "Produce the presentation content only."

colors:
  # Accent colours — equal status, highlights and semantic states only.
  # None is the default. Rotate them (see Colour > Accent rotation).
  accent-coral: "#E9895E"
  accent-sky: "#A8DCE8"
  accent-yellow: "#F3DD8F"
  accent-green: "#98AF48"

  # Core
  background: "#FFFFFF"
  foreground: "#000000"
  primary: "{colors.foreground}"
  on-dark: "#FFFFFF"
  on-accent: "#000000"

  # Neutral scale — cool, never warm (no beige/cream)
  neutral-50: "#FAFAFA"       # App shell / sidebar background
  neutral-100: "#F4F4F5"      # Input fills, muted surfaces, tab lists, skeletons
  neutral-200: "#E4E4E7"      # Interface separators, hover fills, unchecked controls
  neutral-300: "#D4D4D8"      # Pressed fills, disabled control fills
  neutral-500: "#71717A"      # Disabled states only — never meaningful text
  neutral-600: "#52525B"      # Muted foreground (secondary text, helper text, placeholders) ~7:1 on white
  neutral-800: "#27272A"      # Hover state on black surfaces
  neutral-900: "#18181B"      # Pressed state on black surfaces

  # Semantic roles
  muted: "{colors.neutral-100}"
  muted-foreground: "{colors.neutral-600}"
  separator: "{colors.neutral-200}"
  surface-card: "#FFFFFF"
  surface-dark: "#000000"
  overlay: "rgba(0, 0, 0, 0.5)"
  ring: "#000000"
  rule-statement: "#000000"

  success: "{colors.accent-green}"
  warning: "{colors.accent-yellow}"
  info: "{colors.accent-sky}"
  destructive: "{colors.accent-coral}"

fonts:
  sans:
    family: "Public Sans"
    provider: google
    weights:
      body: 400        # Body text — the default
      label: 700       # Subheadings, labels, buttons
      statement: 900   # Main headings, statements, big numbers
    fallback: "system-ui, sans-serif"
    default: true

typography:
  # ── Statement layer (Black 900) ──
  statement-xl:   { fontSize: 72px, fontWeight: 900, lineHeight: 1.0,  letterSpacing: -2px }
  statement-lg:   { fontSize: 56px, fontWeight: 900, lineHeight: 1.02, letterSpacing: -1.5px }
  statement-md:   { fontSize: 40px, fontWeight: 900, lineHeight: 1.05, letterSpacing: -1px }
  statement-quote: { fontSize: 28px, fontWeight: 900, lineHeight: 1.2,  letterSpacing: -0.4px }
  number-display: { fontSize: 96px, fontWeight: 900, lineHeight: 0.9,  letterSpacing: -3px }
  number-stat:    { fontSize: 48px, fontWeight: 900, lineHeight: 1.0,  letterSpacing: -1.5px }
  list-marker:    { fontSize: 32px, fontWeight: 900, lineHeight: 1.0,  letterSpacing: -1px }

  # ── Main heading (Black 900) ──
  heading-h1:     { fontSize: 36px, fontWeight: 900, lineHeight: 1.1,  letterSpacing: -0.8px }

  # ── Subheadings (Bold 700) ──
  heading-h2:     { fontSize: 24px, fontWeight: 700, lineHeight: 1.25, letterSpacing: -0.3px }
  heading-h3:     { fontSize: 18px, fontWeight: 700, lineHeight: 1.35, letterSpacing: -0.1px }
  heading-h4:     { fontSize: 16px, fontWeight: 700, lineHeight: 1.4,  letterSpacing: 0 }

  # ── Body (Regular 400) ──
  lead-lg:        { fontSize: 28px, fontWeight: 400, lineHeight: 1.35, letterSpacing: -0.3px }
  lead:           { fontSize: 22px, fontWeight: 400, lineHeight: 1.45, letterSpacing: -0.2px }
  body-lg:        { fontSize: 18px, fontWeight: 400, lineHeight: 1.6,  letterSpacing: 0 }
  body-md:        { fontSize: 16px, fontWeight: 400, lineHeight: 1.6,  letterSpacing: 0 }
  body-sm:        { fontSize: 14px, fontWeight: 400, lineHeight: 1.5,  letterSpacing: 0 }
  caption:        { fontSize: 14px, fontWeight: 400, lineHeight: 1.4,  letterSpacing: 0 }

  # ── Interface ──
  ui-text:        { fontSize: 14px, fontWeight: 400, lineHeight: 1.43, letterSpacing: 0 }
  label:          { fontSize: 14px, fontWeight: 700, lineHeight: 1.2,  letterSpacing: 0 }
  button:         { fontSize: 14px, fontWeight: 700, lineHeight: 1.0,  letterSpacing: 0 }
  nav-link:       { fontSize: 14px, fontWeight: 400, lineHeight: 1.4,  letterSpacing: 0 }
  nav-link-active: { fontSize: 14px, fontWeight: 700, lineHeight: 1.4,  letterSpacing: 0 }
  badge:          { fontSize: 12px, fontWeight: 700, lineHeight: 1.0,  letterSpacing: 0.1px }
  eyebrow:        { fontSize: 12px, fontWeight: 700, lineHeight: 1.2,  letterSpacing: 1.2px, textTransform: uppercase }
  table-head:     { fontSize: 12px, fontWeight: 700, lineHeight: 1.3,  letterSpacing: 0.2px }
  numeric:        { fontVariantNumeric: "tabular-nums" }

rounded:
  none: 0px
  full: 9999px   # Radio buttons and avatars ONLY
  default: "{rounded.none}"

spacing:
  unit: 4px
  half: 2px
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "10": 40px
  "12": 48px
  "16": 64px
  "24": 96px

sizes:
  control-sm: 32px
  control-md: 36px
  control-lg: 40px
  control-xl: 48px
  nav-height: 56px
  sidebar-width: 256px
  content-max: 1200px
  prose-max: 680px

elevation:
  none: "none"
  xs: "0 1px 2px rgba(0, 0, 0, 0.06)"
  sm: "0 2px 8px rgba(0, 0, 0, 0.08)"
  md: "0 8px 24px rgba(0, 0, 0, 0.12)"
  lg: "0 16px 48px rgba(0, 0, 0, 0.16)"
  rule: "Shadows must always have blur. Never use zero-blur or spread-only shadows that imitate an outline."

lines:
  interface-separator: { width: 1px, color: "{colors.separator}" }
  statement-standard:  { width: 2px, color: "{colors.rule-statement}" }
  statement-emphasis:  { width: 3px, color: "{colors.rule-statement}" }
  statement-heavy:     { width: 4px, color: "{colors.rule-statement}" }
  usage: "Separators divide rows, groups and sections. They never enclose, outline or frame a component."

focus:
  ring: "0 0 0 2px #FFFFFF, 0 0 0 4px #000000"
  usage: "Shown on :focus-visible for every interactive element. A focus ring is a temporary state indicator, not a border."

motion:
  duration-fast: 120ms
  duration-base: 180ms
  duration-slow: 260ms
  easing: "cubic-bezier(0.2, 0, 0, 1)"

components:
  # ════════ INTERFACE LAYER ════════
  button-default:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.on-dark}"
    hover: "{colors.neutral-800}"
    pressed: "{colors.neutral-900}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    height: "{sizes.control-md}"
    padding: "0 16px"
  button-secondary:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.foreground}"
    hover: "{colors.neutral-200}"
    pressed: "{colors.neutral-300}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    height: "{sizes.control-md}"
    padding: "0 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    hover: "{colors.neutral-100}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    height: "{sizes.control-md}"
    padding: "0 12px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    hover: "underline, 2px, offset 4px"
    typography: "{typography.button}"
    padding: "0"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-accent}"
    hover: "opacity 0.9"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    height: "{sizes.control-md}"
    padding: "0 16px"
  button-icon:
    backgroundColor: "transparent"
    hover: "{colors.neutral-100}"
    rounded: "{rounded.none}"
    size: "{sizes.control-md}"
    iconSize: 16px

  input:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.foreground}"
    placeholderColor: "{colors.neutral-600}"
    hover: "{colors.neutral-200}"
    focus: "background {colors.background} + {focus.ring}"
    invalid: "4px square destructive marker beside the label + helper text in foreground"
    typography: "{typography.ui-text}"
    rounded: "{rounded.none}"
    height: "{sizes.control-md}"
    padding: "0 12px"
  textarea:
    inherits: "input"
    minHeight: 96px
    padding: "8px 12px"
  select:
    inherits: "input"
    chevron: "16px, foreground"
  label:
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    gap: "{spacing.2}"
  helper-text:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.caption}"
  checkbox:
    size: 16px
    unchecked: "{colors.neutral-200}"
    checked: "{colors.foreground} fill, white check"
    rounded: "{rounded.none}"
  radio:
    size: 16px
    unchecked: "{colors.neutral-200}"
    checked: "{colors.foreground} fill, 6px white centre dot"
    rounded: "{rounded.full}"
  switch:
    track: "36px × 20px"
    off: "{colors.neutral-200}"
    on: "{colors.foreground}"
    thumb: "16px white, elevation xs"
    rounded: "{rounded.none}"

  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.foreground}"
    elevation: "{elevation.xs}"
    rounded: "{rounded.none}"
    padding: "24px"
    titleTypography: "{typography.heading-h3}"
    descriptionTypography: "{typography.body-sm}"
    descriptionColor: "{colors.muted-foreground}"
  card-muted:
    backgroundColor: "{colors.muted}"
    elevation: "{elevation.none}"
    rounded: "{rounded.none}"
    padding: "24px"
  badge:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.foreground}"
    typography: "{typography.badge}"
    rounded: "{rounded.none}"
    padding: "4px 8px"
  badge-accent:
    variants: ["accent-coral", "accent-sky", "accent-yellow", "accent-green"]
    textColor: "{colors.on-accent}"
    typography: "{typography.badge}"
    rounded: "{rounded.none}"
    padding: "4px 8px"
  alert:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    marker: "8px square in the semantic accent, aligned to the title"
    rounded: "{rounded.none}"
    padding: "16px"
  tabs:
    list: "{colors.neutral-100} fill, 4px padding"
    trigger: "{typography.nav-link}, muted-foreground"
    triggerActive: "white fill, {elevation.xs}, {typography.nav-link-active}, foreground"
    rounded: "{rounded.none}"
  table:
    headTypography: "{typography.table-head}"
    headColor: "{colors.muted-foreground}"
    cellTypography: "{typography.ui-text}"
    rowSeparator: "{lines.interface-separator}"
    rowHover: "{colors.neutral-50}"
    rowSelected: "{colors.neutral-100}"
    numbers: "tabular-nums, right-aligned"
    cellPadding: "12px 16px"
  dropdown-menu:
    backgroundColor: "{colors.background}"
    elevation: "{elevation.md}"
    rounded: "{rounded.none}"
    padding: "4px"
    item: "{typography.ui-text}, 32px height, 8px horizontal padding"
    itemHover: "{colors.neutral-100}"
    groupSeparator: "{lines.interface-separator}"
  popover:
    backgroundColor: "{colors.background}"
    elevation: "{elevation.md}"
    rounded: "{rounded.none}"
    padding: "16px"
  dialog:
    backgroundColor: "{colors.background}"
    overlay: "{colors.overlay}"
    elevation: "{elevation.lg}"
    rounded: "{rounded.none}"
    padding: "24px"
    titleTypography: "{typography.heading-h2}"
    maxWidth: 480px
  tooltip:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.caption}"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  toast:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.ui-text}"
    elevation: "{elevation.lg}"
    rounded: "{rounded.none}"
    padding: "16px"
  sidebar:
    backgroundColor: "{colors.neutral-50}"
    width: "{sizes.sidebar-width}"
    item: "{typography.nav-link}, 36px height, 12px horizontal padding"
    itemHover: "{colors.neutral-100}"
    itemActive: "{colors.neutral-200} fill, {typography.nav-link-active}"
    groupLabel: "{typography.eyebrow}, muted-foreground"
  top-nav:
    backgroundColor: "{colors.background}"
    height: "{sizes.nav-height}"
    left: "Page or section title in heading-h4. No logo."
    bottomSeparator: "{lines.interface-separator}"
  avatar:
    size: 32px
    backgroundColor: "{colors.neutral-200}"
    initials: "{typography.badge}"
    rounded: "{rounded.full}"
  skeleton:
    backgroundColor: "{colors.neutral-100}"
    animation: "pulse, 1.5s"
    rounded: "{rounded.none}"
  progress:
    track: "{colors.neutral-100}, 8px height"
    indicator: "{colors.foreground}"
    rounded: "{rounded.none}"
  separator:
    line: "{lines.interface-separator}"

  # ════════ STATEMENT LAYER ════════
  button-accent:
    backgroundColor: "Any one accent — rotate, do not default to Coral"
    textColor: "{colors.on-accent}"
    hover: "opacity 0.9"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    height: "{sizes.control-xl}"
    padding: "0 24px"
    usage: "One per screen, for the single most important call to action."
  hero-statement:
    headline: "{typography.statement-xl}"
    lead: "{typography.lead-lg}"
    backgroundColor: "{colors.background}"
    padding: "96px 0"
  stat:
    number: "{typography.number-stat}"
    label: "{typography.body-sm}"
    labelColor: "{colors.muted-foreground}"
    highlight: "Optional square accent block behind or beside the number, accent chosen by rotation"
  stat-display:
    number: "{typography.number-display}"
    label: "{typography.lead}"
  quote-panel-black:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.statement-quote}"
    attribution: "{typography.body-sm}"
    rounded: "{rounded.none}"
    padding: "40px"
  quote-panel-white:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.statement-quote}"
    rounded: "{rounded.none}"
    padding: "40px 0"
  highlight-panel-black:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    headingTypography: "{typography.statement-md}"
    bodyTypography: "{typography.body-md}"
    rounded: "{rounded.none}"
    padding: "40px"
  numbered-steps:
    marker: "{typography.list-marker}"
    title: "{typography.heading-h3}"
    body: "{typography.body-md}"
    gap: "{spacing.6}"
  statement-divider:
    line: "{lines.statement-emphasis}"
    width: "100%"
  photo-tile:
    rounded: "{rounded.none}"
    padding: "0"

roles:
  background: "{colors.background}"
  foreground: "{colors.foreground}"
  card: "{colors.surface-card}"
  card-foreground: "{colors.foreground}"
  popover: "{colors.background}"
  popover-foreground: "{colors.foreground}"
  primary: "{colors.primary}"
  primary-foreground: "{colors.on-dark}"
  secondary: "{colors.neutral-100}"
  secondary-foreground: "{colors.foreground}"
  muted: "{colors.muted}"
  muted-foreground: "{colors.muted-foreground}"
  accent: "{colors.neutral-100}"         # Hover fills
  accent-foreground: "{colors.foreground}"
  destructive: "{colors.destructive}"
  destructive-foreground: "{colors.on-accent}"
  border: "{colors.separator}"
  input: "{colors.neutral-100}"
  ring: "{colors.ring}"
  sidebar: "{colors.neutral-50}"
  sidebar-foreground: "{colors.foreground}"
  sidebar-primary: "{colors.foreground}"
  sidebar-primary-foreground: "{colors.on-dark}"
  sidebar-accent: "{colors.neutral-100}"
  sidebar-accent-foreground: "{colors.foreground}"
  sidebar-border: "{colors.separator}"
  sidebar-ring: "{colors.ring}"
  overlay: "{colors.overlay}"
  surface-dark: "{colors.surface-dark}"
  on-dark: "{colors.on-dark}"
  on-accent: "{colors.on-accent}"
  success: "{colors.success}"
  warning: "{colors.warning}"
  info: "{colors.info}"
  # The rotation order: Sky Blue, Yellow, Green, Coral
  highlight-1: "{colors.accent-sky}"
  highlight-2: "{colors.accent-yellow}"
  highlight-3: "{colors.accent-green}"
  highlight-4: "{colors.accent-coral}"
  chart-1: "{colors.foreground}"
  chart-2: "{colors.accent-sky}"
  chart-3: "{colors.accent-yellow}"
  chart-4: "{colors.accent-green}"
  chart-5: "{colors.accent-coral}"
  radius: "{rounded.default}"
  radius-full: "{rounded.full}"
  font-sans: "{fonts.sans}"
  weight-body: "{fonts.sans.weights.body}"
  weight-label: "{fonts.sans.weights.label}"
  weight-statement: "{fonts.sans.weights.statement}"
  spacing-unit: "{spacing.unit}"
---

# Design System

## Output rules

These rules apply every time this system is used to produce a presentation, page or screen.

- **No logos.** Never draw, insert or imitate a logo, wordmark, monogram, corner marks or any other brand device.
- **No brand name.** Never write the brand or company name in titles, headers, footers, slide masters, captions or alt text. The only exception is when it appears in the user's own supplied content.
- **No brand furniture.** No branded title slides, closing slides, taglines, copyright lines or "Presented by" credits.
- **Just the presentation.** Spend the space on the content. The design language itself (type, colour, shape) is the only identity needed.

---

## Overview

Most of what people see is the content: data, arguments, steps and evidence. That content should feel calm and precise. It should be easy to scan and should never compete with the message.

The system also has something to say. Its voice comes through in a small number of deliberate **statement moments**: a huge number, a confident headline or a black quote panel. These moments are bold because everything around them is quiet.

The system is built from two layers that share one typeface, one colour logic and one shape language.

| Layer | Character | Weights | Colour | Share of a typical screen |
|---|---|---|---|---|
| **Interface** | Utilitarian, modernist, recessive | Regular 400 for text, Bold 700 for subheadings and labels | White, black, cool neutrals | ~90% |
| **Statement** | Editorial, confident, oversized | Black 900, with Regular 400 supporting copy | Black, white, one accent highlight | ~10% |

**Rule of thumb:** use at most one statement moment per screen or slide. If everything shouts, nothing is heard.

### Key characteristics

- Pure white (#FFFFFF) is the default background and pure black (#000000) the default text colour.
- A cool neutral scale (#FAFAFA–#18181B) supports fills, secondary text, hover states and separators. It never uses warm greys, beige or cream.
- Four equal accent colours — Coral, Sky Blue, Yellow and Green — are used only for highlights and semantic states. They are rotated so no single accent dominates. They are always paired with black text and always square-cornered.
- Public Sans is used in **three weights only**:
  - **Regular (400)** for all body text. This is the default.
  - **Bold (700)** for subheadings, labels and buttons.
  - **Black (900)** for main headings and big statements.
- Everything must be readable and clear in all situations: projectors, small screens, bright rooms and print.
- All components are square-cornered. The only exceptions are radio buttons and avatars, which are circular by function.
- Components are defined by fill, space, typography and soft elevation. They never have outlines or perimeter borders.
- Interface separators are 1px neutral lines between rows or groups. Statement dividers are 2–4px black.
- Every interactive element shows a black focus ring on keyboard focus.

---

## Readability

Every output must be readable and clear in all situations, including projected slides, small laptop screens, bright rooms, screenshots and print. When in doubt, choose the larger size and the stronger contrast.

- **Contrast:** all text reaches at least 4.5:1 against its background. Pure black on white is the default. Black text on all four accents passes.
- **Minimum sizes:**
  - Regular text is never smaller than 14px.
  - Bold labels (badges, eyebrows, table headers) are never smaller than 12px.
- **Slides:** body text is never smaller than body-lg (18px on a 1280×720 canvas). Scale all sizes proportionally for larger canvases, for example ×1.5 at 1920×1080.
- **Muted text:** grey text uses neutral-600 only, on white, neutral-50 or neutral-100 surfaces. Never put grey text on black or on an accent. Never use neutral-500 for anything a reader needs.
- **Line length:** keep paragraphs to around 680px (roughly 60–75 characters) so lines are easy to follow.
- **Density on slides:** prefer fewer, larger words. If text doesn't fit at the minimum size, split the slide rather than shrinking the type.
- **Don't rely on colour alone.** Accent highlights and semantic states always come with a label, marker or text that carries the meaning.

---

## Colour

### Core

- **Background (#FFFFFF):** the default page, slide and component surface.
- **Foreground (#000000):** primary text, icons and the default button fill.
- **Surface Dark (#000000):** tooltips, toasts and statement panels, always with white text.

### Neutrals

The neutral scale lets the interface recede. It is cool and slightly blue-grey, never warm.

| Token | Hex | Use |
|---|---|---|
| neutral-50 | #FAFAFA | App shell and sidebar background, table row hover |
| neutral-100 | #F4F4F5 | Input fills, muted cards, tab lists, secondary buttons, skeletons |
| neutral-200 | #E4E4E7 | Interface separators, hover fills, unchecked controls, active nav item |
| neutral-300 | #D4D4D8 | Pressed fills, disabled control fills |
| neutral-500 | #71717A | Disabled states only. Never meaningful text |
| neutral-600 | #52525B | Muted foreground: helper text, metadata, descriptions, placeholders (about 7:1 on white) |
| neutral-800 | #27272A | Hover state on black buttons |
| neutral-900 | #18181B | Pressed state on black buttons |

Muted grey text is for secondary information only. Primary content, headings and anything essential stay pure black.

### Accent colours

The four accents have **equal status**. None is the primary or default.

| Accent | Hex | Highlight use | Semantic role (interface only) |
|---|---|---|---|
| Coral | #E9895E | Highlights, data points, stat blocks, accent button | Destructive / error |
| Sky Blue | #A8DCE8 | Highlights, data points, stat blocks, accent button | Info |
| Yellow | #F3DD8F | Highlights, data points, stat blocks, accent button | Warning |
| Green | #98AF48 | Highlights, data points, stat blocks, accent button | Success |

### Accent rotation

- **Do not default to Coral.** Coral should appear no more often than any other accent.
- **Vary by section.** Across a presentation or multi-section page, give each section or slide its own accent and cycle through all four. A sensible default order is Sky Blue → Yellow → Green → Coral.
- **One accent per slide or local area.** Within a single slide or section, use one accent for highlights so the area stays coherent.
- **Charts are the exception.** All four may be used together as a series palette.
- **Choose by meaning when it exists.** If the content is positive, cautionary or informational, Green, Yellow or Sky Blue may be chosen to match. Otherwise follow the rotation.
- **Never use a run of the same accent.** Three or more consecutive slides or sections with the same accent is a mistake.

### Accent rules

- **Black text only.** All four accents pass WCAG AA with black text. Never set text in an accent colour.
- **Square corners always.** No rounding on any accent-filled element.
- **Small areas only.** Use accents for badges, markers, chart data, a highlighted word, a single CTA or a stat highlight. Never use them as page, section, slide or card backgrounds.
- **Semantic use inside app interfaces:** in functional app screens, Coral means destructive or error, so the primary app action stays black. In presentations and statement contexts, Coral is just one of the four rotating highlights.

---

## Typography

Public Sans is the only typeface, and only **three weights** are used. Weight does the heavy lifting in the hierarchy. Body text is Regular and calm, so the Black moments really land.

- Regular text is never smaller than 14px. Bold labels are never smaller than 12px.
- All text must reach at least 4.5:1 contrast with its background. Prefer pure black.
- On slides, body text is never smaller than body-lg (18px at a 1280×720 canvas); scale proportionally for larger canvases.

### Weight roles

| Weight | Role |
|---|---|
| **Regular (400)** | All body text: paragraphs, lead copy, bullet text, captions, table cells, inputs, inactive nav. **This is the default.** |
| **Bold (700)** | Subheadings (H2–H4), form labels, buttons, badges, eyebrows, table headers, active nav. |
| **Black (900)** | Main headings (H1), statement headlines, big numbers, list markers and statement quotes. Use it whenever you want to make a big statement on screen. |

> **No other weights.** Never use Thin (100), Extra Light (200), Light (300), Medium (500), Semibold (600) or Extra Bold (800).

### Heading hierarchy

| Element | Token | Weight | Size | Use |
|---|---|---|---|---|
| H1 | heading-h1 | Black 900 | 36px | Main heading, page or slide title (one per page/slide) |
| H2 | heading-h2 | Bold 700 | 24px | Subheading for major sections, dialog titles |
| H3 | heading-h3 | Bold 700 | 18px | Subsections, card titles |
| H4 | heading-h4 | Bold 700 | 16px | Minor groups, form section titles |

Use headings in semantic order. If a page or slide needs a giant headline, apply a **statement** style (such as statement-xl) to the H1 element. Do not skip levels.

### Full scale

| Token | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|
| statement-xl | 72px | 900 | 1.0 | -2px | Hero statement |
| statement-lg | 56px | 900 | 1.02 | -1.5px | Section statement |
| statement-md | 40px | 900 | 1.05 | -1px | Highlight panel heading |
| statement-quote | 28px | 900 | 1.2 | -0.4px | Statement quotes |
| number-display | 96px | 900 | 0.9 | -3px | Hero numerals |
| number-stat | 48px | 900 | 1.0 | -1.5px | Headline metrics |
| list-marker | 32px | 900 | 1.0 | -1px | Step markers |
| heading-h1 | 36px | 900 | 1.1 | -0.8px | Main heading |
| heading-h2 | 24px | 700 | 1.25 | -0.3px | Subheading |
| heading-h3 | 18px | 700 | 1.35 | -0.1px | Card / subsection title |
| heading-h4 | 16px | 700 | 1.4 | 0 | Minor heading |
| lead-lg | 28px | 400 | 1.35 | -0.3px | Hero supporting copy |
| lead | 22px | 400 | 1.45 | -0.2px | Intro paragraphs |
| body-lg | 18px | 400 | 1.6 | 0 | Presentation body, long-form reading |
| body-md | 16px | 400 | 1.6 | 0 | Default running text |
| body-sm | 14px | 400 | 1.5 | 0 | Supporting text, descriptions |
| caption | 14px | 400 | 1.4 | 0 | Metadata, helper text, chart labels |
| ui-text | 14px | 400 | 1.43 | 0 | Dense interface text |
| label | 14px | 700 | 1.2 | 0 | Form labels |
| button | 14px | 700 | 1.0 | 0 | Button labels |
| badge | 12px | 700 | 1.0 | 0.1px | Badges |
| table-head | 12px | 700 | 1.3 | 0.2px | Table headers |
| nav-link | 14px | 400 | 1.4 | 0 | Nav items (700 when active) |
| eyebrow | 12px | 700 | 1.2 | 1.2px | Uppercase category labels |

### Pairing the extremes

The signature typographic move is a **Black headline over Regular body text**. The contrast in weight does the work, so no colour, box or decoration is needed. Bold sits between them, only for subheadings and functional labels.

### Numbers

Use `tabular-nums` in tables, metrics and anything that updates or aligns in columns. Right-align numeric table columns.

---

## Shape

Everything is square. A single radius of **0** applies to every button, input, card, menu, dialog, tab, badge, toast and tooltip. This keeps the family coherent: a square button never sits awkwardly inside a rounded card.

The only exceptions are **radio buttons** and **avatars**. They use `rounded.full` because the circle is part of their meaning. Neither may be accent-filled.

---

## Lines, separators and focus

**Never use outlines or perimeter borders.** No component is drawn by a stroke around its edge. Shape comes from fill, elevation and space.

There are two kinds of line, and both are standalone separators that never enclose anything.

| Line | Spec | Use |
|---|---|---|
| Interface separator | 1px, neutral-200 | Table rows, menu groups, beneath the top nav, between settings rows |
| Statement divider | 2px / 3px / 4px, black | Major editorial section breaks on statement pages and slides |

Do not use black statement dividers inside dense interface areas, and do not use faint 1px lines on statement pages.

**Focus ring:** every interactive element shows `0 0 0 2px #FFFFFF, 0 0 0 4px #000000` on `:focus-visible`. This is a temporary state indicator required for accessibility, not a border. Never remove it.

---

## Layout

- **Spacing:** 4px base unit. Use the spacing scale only.
- **Controls:** 32px (sm), 36px (default) and 40px (lg) heights. 48px is reserved for statement-layer CTAs.
- **App shell:**
  - 56px top nav with a 1px separator beneath and a page title at left. No logo.
  - Optional 256px neutral-50 sidebar.
  - Content area on white or neutral-50.
- **Cards on surfaces:**
  - On a white page, use `card-muted`, which has a neutral-100 fill and no shadow.
  - On a neutral-50 shell, use `card`, which has a white fill and xs shadow.
  - Never place a white card with no shadow on a white page.
- **Content width:**
  - 1200px maximum for app layouts.
  - 680px maximum for long-form reading.
- **Density:** interface screens are compact (16–24px gaps). Statement sections and slides are generous (64–96px vertical padding).
- **Grid:** 12 columns for app layouts. Editorial square-tile grids (3 / 2 / 1 columns) for presentations and statement pages.

---

## Elevation

Elevation separates floating layers from the page without outlines. Shadows are soft, neutral and always blurred.

| Token | Use |
|---|---|
| xs | Cards on neutral-50 shells, active tab, switch thumb |
| sm | Sticky headers, raised cards on hover |
| md | Dropdowns, popovers, comboboxes |
| lg | Dialogs, toasts, sheets |

Never use a zero-blur or spread-only shadow. That is an outline in disguise.

Statement components (quote panels, highlight panels, hero) are **flat**. Their contrast comes from solid black and white, not shadow.

---

## Components — Interface layer

These components should feel familiar to anyone who has used a modern app. They are neutral, predictable and quiet.

### Buttons

| Variant | Appearance | Use |
|---|---|---|
| **Default** | Black fill, white Bold label | The primary action in a view |
| **Secondary** | neutral-100 fill, black label | Alternative actions |
| **Ghost** | Transparent, neutral-100 on hover | Toolbars, tertiary actions, icon buttons |
| **Link** | Text only, 2px underline on hover | Inline navigation |
| **Destructive** | Coral fill, black label | Delete, remove, irreversible actions |

All buttons are square, 36px tall by default and have no outline. Use one Default button per view region. Icons are 16px with an 8px gap from the label.

### Form controls

- **Input, textarea, select:**
  - neutral-100 fill, square, no border, Regular text.
  - Hover deepens the fill to neutral-200.
  - Focus switches to a white fill with the black focus ring.
- **Label:** 14px Bold, 8px above the field.
- **Helper text:** 14px Regular in muted-foreground, 6px below the field.
- **Errors:**
  - Place a small square Coral marker beside the label.
  - Show the error message as black helper text.
  - Never use red or Coral text.
- **Checkbox:** 16px square. Unchecked is neutral-200. Checked is a black fill with a white check.
- **Radio:** 16px circle. Unchecked is neutral-200. Checked is a black fill with a white dot.
- **Switch:** square 36×20 track (neutral-200 off, black on) with a white square thumb.

### Surfaces

- **Card:** white, xs elevation, 24px padding. Bold H3 title with a Regular body-sm description beneath in muted-foreground.
- **Card (muted):** neutral-100 fill, no shadow. Use on white pages.
- **Dialog:**
  - White, lg elevation, 50% black overlay, 24px padding, 480px max width.
  - Bold H2 title.
  - Actions right-aligned: Secondary, then Default.
- **Dropdown menu / popover:**
  - White, md elevation, 4px inner padding.
  - Menu items are 32px tall with a neutral-100 hover.
  - Groups are divided by interface separators.

### Navigation

- **Top nav:** white, 56px, 1px separator beneath. Page title at left (no logo), nav links in Regular (Bold when active), actions at right.
- **Sidebar:**
  - neutral-50 background.
  - Items are 36px tall, with a neutral-100 hover.
  - The active item has a neutral-200 fill and Bold text.
  - Group labels use the eyebrow style in muted-foreground.
- **Tabs:**
  - The tab list sits on a neutral-100 fill.
  - The active trigger is white with xs elevation and Bold text.
  - Inactive triggers use Regular muted-foreground text.

### Feedback

- **Badge:** neutral-100 fill or an accent fill, black 12px Bold, square, 4px × 8px padding.
- **Alert:**
  - neutral-100 fill.
  - An 8px square accent marker sits beside a Bold title, indicating the semantic type.
  - Regular body text.
- **Toast:** black surface, white Regular text, lg elevation.
- **Tooltip:** black, white 14px Regular text.
- **Skeleton:** neutral-100 with a gentle pulse.
- **Progress:** neutral-100 track with a black indicator.

### Data

- **Table:**
  - Header row in 12px Bold muted-foreground.
  - Cells in 14px Regular black.
  - 1px neutral-200 row separators.
  - neutral-50 row hover and neutral-100 selected rows.
  - Tabular, right-aligned numbers.
  - No outer border or frame.
- **Charts:**
  - Black for the primary series. All four accents for comparisons and highlights; do not lead with Coral.
  - neutral-200 for gridlines.
  - Square bar ends.
  - Labels in caption style. Label series directly where possible so meaning doesn't depend on colour alone.

---

## Components — Statement layer

Use these components to make a point. Limit them to one per screen or slide inside an app. They may appear more freely in presentations, onboarding and report pages.

- **Hero statement:**
  - statement-xl headline in Black, with a lead-lg paragraph in Regular beneath it.
  - Optionally followed by a single accent button, with the accent chosen by rotation.
  - White background with generous space.
- **Stat:**
  - number-stat (48px Black) with a Regular body-sm label beneath in muted-foreground.
  - May use a square accent block as a highlight. When showing several stats in a row, either use one shared accent or none. Never default to Coral.
  - Use for headline metrics, ideally 1–4 in a row.
- **Stat display:** number-display (96px Black) with a Regular lead label, for reports and milestone moments.
- **Quote panel:**
  - Either a black fill with white statement-quote text, or white with black.
  - Attribution in Regular body-sm.
  - Never accent-coloured and never bordered.
- **Highlight panel:**
  - Black fill with a white statement-md heading and white Regular body text.
  - For a key message, milestone or call to commitment.
- **Numbered steps:**
  - 32px Black numerals with a Bold H3 title and Regular body text.
  - One marker per item, all the same size.
- **Accent button:**
  - Any one accent fill (by rotation), black Bold label, square, 48px tall.
  - One per screen or slide, for the most important action.
- **Statement divider:** 3px black rule for major editorial breaks.
- **Photo tile:** full-bleed collage imagery, square, unframed.

### Bringing the layers together

A typical dashboard combines both layers:

- **Statement:** one row of stats in 48px Black numerals.
- **Interface:** filters, a table, a sidebar and buttons, all quiet and neutral.

A typical presentation inverts the ratio:

- **Statement:** Black headlines, big numbers, quote panels and numbered steps, with the accent rotating from slide to slide.
- **Body:** Regular supporting text at body-lg or larger, with Bold subheadings, calm and readable.
- **No branding:** no logo, no brand name, no branded title or closing slides.

---

## Lists

- Use numbers for primary list levels and letters (a, b, c) for nested subsections.
- Show exactly one visible marker per item. When using a custom marker, set `list-style: none` on the native list.
- Keep all markers in one list at the same size, weight and alignment.
- **Interface lists** (settings, menus, simple bullets) use body-sized Regular text and markers.
- **Statement lists** use list-marker (32px Black) numerals.
- Use semantic `<ol>` and `<ul>` markup with nested lists for subsections.

---

## Imagery

Imagery follows a **heterogeneous architectural collage** methodology.

- **Visual registers:** combine illustrated or painted figures, flat single-colour background buildings, architecturally sourced material textures and clean digital cut-outs.
- **Figures:** gouache-adjacent, with flat tonal modelling and clean masked silhouettes. Figures in one image should feel like one family.
- **Background buildings:** flat graphic masses, one colour per building, with simplified flat windows.
- **Principal architecture:** keeps selective material character, restrained tonal modelling and lightly painted texture.
- **Depth:** created through overlap, scale, vertical position and tonal hierarchy. Never use blur or haze.
- **Overall feel:** the result should read as an authored architectural competition board.
- **Negative space:** pure white. No paper, beige or cream effects.
- **Accents:** restrained highlights only, following the same rotation as the page.
- **Text in imagery:** always black or white, and never placed over busy areas of an image. No logos, brand names or signage branding.
- **No frames:** no outlines or frames around tiles, figures or collage elements.
- **In the app:** keep imagery to empty states, onboarding and presentation surfaces. Never place it behind data or forms.

---

## Do's and don'ts

### Do

- Use only three weights: Regular for body, Bold for subheadings and labels, Black for main headings and statements.
- Default to Regular for all running and UI text.
- Use Black whenever you want to make a big statement on screen.
- Make everything readable in all situations: at least 4.5:1 contrast, Regular text at 14px or larger, slide body text at body-lg or larger.
- Split a crowded slide rather than shrinking the text.
- Rotate accents across sections and slides so all four appear.
- Let the interface recede. Neutral fills, soft elevation and space should define components.
- Limit app screens to one statement moment.
- Use black as the primary button colour inside the app.
- Keep all components square, except radios and avatars.
- Use 1px neutral separators between rows and groups in the interface.
- Use 2–4px black dividers only on statement pages and slides.
- Show the black focus ring on every interactive element.
- Pair every accent fill with black text.
- Use tabular numerals in tables and metrics.
- Use muted grey text only for genuinely secondary information.

### Don't

- Don't include a logo, wordmark, corner marks or any brand device.
- Don't write the brand name anywhere in the output.
- Don't add branded title slides, closing slides, footers or taglines.
- Don't use Thin, Light, Medium, Semibold or Extra Bold weights.
- Don't set Regular text below 14px or Bold labels below 12px.
- Don't put grey text on black or accent surfaces, or use neutral-500 for meaningful text.
- Don't rely on colour alone to carry meaning.
- Don't default to Coral, and don't use the same accent on three or more consecutive sections or slides.
- Don't use more than one accent in a single slide or local area (charts excepted).
- Don't draw outlines, borders or perimeter strokes around any component.
- Don't use more than one statement moment per app screen.
- Don't use accent colours for text, quotes, page backgrounds or card backgrounds.
- Don't use Coral for non-destructive actions inside functional app interfaces.
- Don't round buttons, badges, inputs, cards or accent elements.
- Don't use pill-shaped tags or buttons.
- Don't use warm greys, beige, cream or ivory anywhere.
- Don't use zero-blur shadows that imitate an outline.
- Don't combine browser list markers with custom markers.
- Don't skip heading levels for visual effect.
- Don't remove focus indicators.
