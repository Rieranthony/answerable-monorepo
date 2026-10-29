# Design

The design of `/new`. Decisions D1–D7 are at the end.

## Route and layout

- New route group `apps/web/app/(new)/` with its own root layout: light only (`colorScheme: "light"`, no `dark` class), Public Sans from `lib/fonts.ts`, white body.
- `app/(new)/new/page.tsx`, `noindex` while it lives beside `/` (D7). Same structured data and metadata helpers as `/`.
- Leaving `/new` for `/docs` crosses root layouts, so Next does a full load. That is already the case for `/design`.

## Splash

One client component, `components/new/splash.tsx`, drawn as a fixed full-screen SVG above the page. The page is fully rendered under it from the first byte, so the splash costs no content paint and search engines see the page.

Sequence (about 2.2 s in all; DESIGN.md easing `cubic-bezier(0.2, 0, 0, 1)`):

1. **0–200 ms.** The accent field is already painted (server HTML), nothing else.
2. **200–900 ms. Dot, dot, dot.** Three small white squares appear one after another, 200 ms apart, centred, spaced like an ellipsis. They are the same square as the comma's head.
3. **900–1300 ms. The comma.** The third dot grows its tail and becomes the comma (the comma path is that square plus a tail, so it is one shape morphing, not a swap); the first two dots fade.
4. **1300–1500 ms. The window.** The white comma turns into a hole in the accent field: the page's hero image shows inside the comma, exactly like the comma crops in the brand banners.
5. **1500–2200 ms. The reveal.** The hole scales up from the comma's centre until the field is gone and the page is revealed. The overlay is then removed from the DOM.

How:

- The overlay is an SVG with a `<mask>`: a white rect (the field) minus the comma path. Stage 4 swaps the comma's fill for the mask cut; stage 5 animates the mask's transform (`scale`) in CSS. Transform and opacity only, so it stays on the compositor.
- **Random colour without making the page dynamic.** A tiny inline script in the layout's `<head>` picks the colour before first paint and sets `--splash` on `<html>`; the server HTML has a default. The page stays static. Palette and mark colour (D3): a white comma on one of the four accents at random; switch to a black comma if white reads too faint on yellow and sky.
- **Never stuck.** The animation is pure CSS from the first paint; JS only removes the node on `animationend`, with a timeout fallback. Without JS the overlay still fades out.
- **Reduced motion.** `prefers-reduced-motion: reduce` gets no splash at all.
- **Frequency (D2).** Once per page load: a first visit and every reload play it; moving around inside the page (anchors, the accordion) never replays it. The splash lives in the `(new)` layout, so it mounts once per document. No storage.
- **Focus.** The waitlist form focuses the email field on mount today. On `/new` it does not autofocus; focus is left to the reader.
- Skippable: a click or key press during the splash jumps to the reveal.

## Columns

Desktop (from `lg`, 1024 px):

- Two columns, 50/50. **The image column is sticky** (`position: sticky; top: 0; height: 100svh`), full bleed, no frame. **The content column scrolls.** Image on the right, content on the left (D5).
- **The image follows the reading.** The accordion stays (D6). Each section names its image; opening a section crossfades the sticky image (400 ms) to that section's crop, closing every section brings back the hero image. No scroll listeners. Calm, not parallax.
- The content column is a 560 px measure (DESIGN.md `prose-max` is 680; the owner prefers compact), with 64–96 px between sections.

Mobile (below `lg`):

- The image sits at the top as a band (4:3, full width) under the header; an open section shows its own crop inline at the top of its panel, full width, 3:2. No sticky behaviour.
- One column, 24 px gutter, the form near the end and a "Register your interest" link in the header that scrolls to it.

## Brand details from the old logo

- **The comma** opens the header lockup (D4: the comma from `COMMA_PATH` as inline SVG, then the word "Answerable" as live text in Public Sans Bold, built in code, no image), closes the hero headline (an oversized comma after "For everything you put your name to"), and is the shape of the splash window.
- **The three squares**: the "dot, dot, dot" of the splash; small square bullets (`BulletSquare` already exists); square markers before section eyebrows; a quiet three-square loading state on the submit button instead of "Registering…".
- **Corner marks**: the old logotype framed the word with squares at three corners and the comma at the fourth. The image column gets the same four marks at its inner corners, 8 px, white over the image. One detail, used once.
- Accent rotation per section (Sky, Yellow, Green, Coral), used only for the small square markers, never for backgrounds.

## Content

Today's copy, word for word, and today's accordion: one section open at a time, all closed on load, `keepMounted` for search engines (D6). The founding-cohort section with the form stays outside the accordion, always visible.

Only images 6 and 7 are used (owner, 2026-10-29: the banners show the brand in action, not assets). Each section gets its own crop of one of the two, so the sticky column still changes as you read.

| Section | Copy (from `/`) | Image |
|---------|-----------------|-------|
| Header | Lockup (comma + Answerable), "Register your interest" link | — |
| Hero | "For everything you put your name to." + intro paragraph | 7, the stage and speaker |
| The AI Lead role | three paragraphs | 7, the audience at left under the tree |
| Six core values | numbered list, 32 px Black numerals (statement list) | 6, the sun and the standing pair |
| The people behind the programme | Keir, Sadie, together | 6, the seated group at left |
| Become an Accredited Professional | four benefits | 7, the group talking at right |
| Join the founding cohort | the form, the small print | 6, the seated group at right |
| Footer | © line, links to docs | — |

Type follows DESIGN.md and the owner's compact taste: the hero headline in Black 900 at 40 px desktop / 32 px mobile (statement-md), section headings Bold 700 at 18 px, body 16/24 Regular, muted text in neutral-600. One statement moment: the hero.

## Images

- The two images are committed as supplied in `apps/web/assets/new/`: `forum-stage.webp` (image 7, 1536×1024) and `terrace-conversations.webp` (image 6, 2000×667).
- The page imports them statically through `next/image`, which makes the AVIF and WebP widths, the `srcset`, the blur placeholder and the intrinsic size. `next.config.mjs` adds `images.formats: ["image/avif", "image/webp"]`.
- **Crops are framings, not files.** Each section shows one of the two images with `object-fit: cover` and its own `object-position`, so every frame fits whatever shape the column has, and the browser downloads two images for the whole page. Every use of an image passes the same `sizes="100vw"`, so the URLs match and the cache serves the crossfades.
- Framings (checked on a contact sheet, 4:5 portrait): hero = image 7 at 53 % (stage and speaker); AI Lead role = image 7 at 0 % (audience under the tree); Accredited Professional = image 7 at 100 % (group talking at right); values = image 6 at 65 % (standing pair under the sun); people = image 6 at 26 % (seated group at left); founding cohort = image 6 at 100 % (seated group at right).
- The hero image loads eagerly with `fetchPriority="high"`; the others lazily.
- Alt text describes each scene (DESIGN.md forbids the brand name in alt text).

## Work split for Sonnet 5.5

- **B0 (coordinator):** images in place, framings checked.
- **B1 (Sonnet 5.5):** route group, layout, page, accordion driving the sticky image, mobile, form, lockup, and the splash. Brief: `briefs/B1.md`.
- **Review (me):** gates, browser at 375 × 812 and 1440 × 900, reduced motion, no-JS, Lighthouse on the built page; land on main.

## Decisions

Answered by the owner on 2026-10-29.

| # | Decision |
|---|----------|
| D1 | Images 6 and 7 only, copied to `apps/web/brand-source/`; the banners are references for the logo and the comma device. |
| D2 | The splash plays on the first load of the page and on every reload, never again while the page stays open. |
| D3 | White comma on the four accents at random; revisit if white is too faint on yellow and sky. |
| D4 | Header lockup in code: the comma, then the word "Answerable" as text. |
| D5 | Image column on the right. |
| D6 | Keep today's copy and the accordion. |
| D7 | `/new` is `noindex` until it replaces `/`. |
