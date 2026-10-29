# New landing page goal

Started 2026-10-29. Owner's ask, in their words: a new version of the landing page in the new brand direction, shipped at `/new`; light mode only; calm and modern; built to impress the first customers and get them to sign up (the sign-up system already works, so the work is branding and design only); a splash screen first: a big overlay above everything, "dot, dot, dot", then the comma logo in the middle, growing from the inside out to reveal the site inside it, on a different colour of the palette at random each time, the logo in white (or cut out); big columns, the image on one side and the content and form scrolling on the other; the supplied images compressed, resized and cropped for the web; mobile and desktop; details of the previous logo (squares, comma) in the design; no shaders; simpler, modern, calmer. Sonnet 5.5 may implement. Questions and confirmation before any code.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Read the current page, the logo data, the form, DESIGN.md and the images | complete |
| 1 | Write the facts (`findings.md`) and the design (`design.md`) | complete |
| 2 | Owner answers the open questions (`design.md`, Decisions D1–D7) | complete |
| 3 | Images in `apps/web/assets/new`, framings checked (next/image makes the sizes) | complete |
| 4 | Brief Sonnet 5.5: B1 page and splash (`briefs/B1.md`) | complete |
| 5 | Review, gates (`typecheck`, `lint`, `build`, `web test`), check in the browser at 375 and 1440 | complete |
| 6 | Owner looks at /new, then land on main and check Vercel | complete |

## Scope

- In: `/new` only, its own light root layout, the splash, the two-column layout, the images, the existing waitlist form restyled through tokens.
- Out: `/` stays as it is (dark, mosaic, dither) until the owner says to swap; the docs, `/design`, ID pages; the waitlist server action and Google Sheets sink (unchanged).

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
