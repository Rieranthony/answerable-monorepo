# Findings

Measured 2026-10-29 on main 62b6b1b3.

## The repository

- `/` is `apps/web/app/(site)/page.tsx` in the `(site)` root layout, which is dark only (`className="dark"`, `colorScheme: "dark"`). The docs share that layout. A light page needs its own root layout, as `(design)` already has; two root layouts already exist, and `app/global-not-found.tsx` covers unmatched URLs.
- The waitlist form is `components/waitlist-form.tsx` (email + country, server action `joinWaitlist` in `app/actions.ts`, Google Sheets). It uses `@answerable/ui` `Button`, `Input`, `CountrySelect`, `Field`, `Form`, so it restyles through the tokens and needs no change to work on a light page. It focuses the email field on mount; on a page that opens with a splash this must not fire under the overlay (see design.md).
- The comma is `COMMA_PATH` in `packages/ui/src/lib/logo.ts`: a 48×48 square (x 1104–1152, y 216–264) plus a tail to y 288. **The comma is a square with a tail**, so a square "dot" can become the comma by growing its tail. `COMMA_VIEW_BOX` puts it on its own canvas.
- The old logotype is three corner squares + the comma at the fourth corner, framing the letters (`LOGO_PATHS`, Formular Black). The new lockup in the banners is the comma before the word "Answerable" set in a grotesk; no SVG of it is in the repo.
- Shaders today: `@paper-design/shaders-react` (mosaic halftone) and the tripwire dither in the footer. `/new` uses neither; `/` keeps them.
- No animation library is installed (`motion` was removed). The splash can be CSS + SVG only.
- Fonts: `next/font/google` Public Sans in `lib/fonts.ts`; DESIGN.md allows 400, 700, 900.
- Processing images: `sharp` 0.34.5 is a devDependency of `apps/web`; `bun run mosaic` (`scripts/build-mosaic.ts`) is the precedent: committed source in `mosaic-source/`, generated output in `public/`.

## The supplied images

| # | Size | Content | Text baked in | Usable as |
|---|------|---------|---------------|-----------|
| 1 | 1600×500, 96 KB | Resources banner: hand at a bookshelf | logo + "Answerable Resources" | reference only; a text-free crop is about 470×500 |
| 2 | 1600×500, 158 KB | Events banner: terrace gathering | logo + title | reference; top band only |
| 3 | 1600×500, 153 KB | AI Leads Forum banner: stage talk | logo + title | reference; top band only |
| 4 | 1600×500, 155 KB | AI Leads Chat banner: seated groups | logo + title | reference; image 6 is the clean version |
| 5 | 1600×500, 155 KB | Agentic Workflows banner: workshop wall | logo + title | reference; top band only |
| 6 | 2000×667, 309 KB | Seated groups, terrace, sun (clean) | none | yes |
| 7 | 1536×1024, 433 KB | Forum stage, audience, trees (clean) | none | yes |

- **Only images 6 and 7 are free of text.** Banners 1–5 carry the logo and a title over the lower left; their right-hand comma crops are about 260×390.
- **Resolution is the limit.** A half-width column at 1440 CSS px wide and full height (about 720×900 CSS px) needs about 1440×1800 pixels at 2× density. Image 7 gives a portrait crop of at most 819×1024 and image 6 at most 533×667, so both would be upscaled about 1.8× and 2.7× on a retina laptop. They hold up at 1× or in a smaller frame.
- The illustrations are warm (terracotta, ochre, leaf green, cream walls). DESIGN.md forbids beige and cream in the interface and asks for white negative space; the images' own white backgrounds match that. The illustrations themselves are brand imagery, not interface, so they stay as they are.

## DESIGN.md versus this page

DESIGN.md's output rules forbid logos, the brand name and accent page backgrounds. Those rules govern generated slides and screens. The owner's brief for this page asks for the comma, a splash on an accent colour and the brand name, so this page is a deliberate exception on those three points only; type, weights, square corners, no borders, the accent rotation and focus rings still apply.

White on the accents (measured, WCAG contrast): coral 2.6:1, green 2.4:1, sky 1.5:1, yellow 1.4:1. Black on each is above 8:1. The mark is not text, but a white comma on yellow or sky will read faint.
