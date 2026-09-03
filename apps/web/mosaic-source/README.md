# Mosaic source photos

Originals for the landing-page hero mosaic. `bun run mosaic` (from `apps/web`)
center-crops each to exact 2:3, resizes, and writes optimized webp sprites to
`public/mosaic/p1..p4.webp` — those generated files are what the site ships.

Most are from Unsplash, used under the
[Unsplash License](https://unsplash.com/license). The exception is noted in
the table — it is Answerable's own photograph, not stock.

| File | Photographer | Source |
| --- | --- | --- |
| `jonathan-borba-EJMJc1zNuLc-unsplash.jpg` | Jonathan Borba | <https://unsplash.com/photos/EJMJc1zNuLc> |
| `magnus-andersson-KAzgxInZXMo-unsplash.jpg` | Magnus Andersson | <https://unsplash.com/photos/KAzgxInZXMo> |
| `wesley-eland-j9K2_EWlArI-unsplash.jpg` | Wesley Eland | <https://unsplash.com/photos/j9K2_EWlArI> |
| `good-faces-p1E9zC5eSTE-unsplash.jpg` | Good Faces | <https://unsplash.com/photos/p1E9zC5eSTE> |
| `teah-rushing-hCQljvkt9Ek-unsplash.jpg` | Teah Rushing | <https://unsplash.com/photos/hCQljvkt9Ek> |
| `annie-spratt-MChSQHxGZrQ-unsplash.jpg` | Annie Spratt | <https://unsplash.com/photos/MChSQHxGZrQ> |
| `davide-valerio-EzFizzT3AfM-unsplash.jpg` | Davide Valerio | <https://unsplash.com/photos/EzFizzT3AfM> |
| `ai-leaders-discussion-2026.jpg` | Answerable (own photo) | AI Leaders Discussion 2026 — not Unsplash |
| `aerial-halftone.png` | Davide Valerio (halftone treatment) | derived from `davide-valerio-EzFizzT3AfM-unsplash.jpg` |

One photo fills the whole mosaic at a time; `ACTIVE_PHOTO` in
`lib/mosaic-layout.ts` selects it (p1..p7 map to the rows above, in order).

These are plain photographs. The halftone screening people see on the site is
applied at runtime by the dithering shader in `components/mosaic-dither.tsx`,
not baked into these files — which is what lets it differ between light and
dark mode.

`aerial-halftone.png` is supplied pre-screened: `build-mosaic.ts` marks it
`preScreened` and copies it through losslessly at its own resolution, since
resampling or lossy encoding would destroy the halftone dots.
