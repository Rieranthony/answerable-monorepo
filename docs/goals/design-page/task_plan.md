# Design page goal

Started 2026-10-22. Owner's ask, in their words: a `/design` page on the landing site that injects a `DESIGN.md` and displays "a NICELY DONE, TOP OF THE RANGE showcase" of it; our own spec on top of design.md; every CSS variable of `@answerable/ui` gets our default but can be overwritten by another CSS variable (colours, radius, spacing ratios, font sizes, font); a simple, beautiful page that shows the components in action; a floating top-right settings pane that changes the defaults (colours in any format, auto-detected and converted); variables injected at the root through a small util and a component, state shared, no prop drilling; our `DESIGN.md` first, later other people's and AI-generated ones; Google Fonts only; extend Tailwind and shadcn; report before coding; Opus 5.5 may implement.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Read the repo, the DESIGN.md, the design.md spec, the UI package | complete |
| 1 | Probe the facts the design depends on (findings.md) | complete |
| 2 | Write the design: our spec on top of design.md, the token pipeline, the page, the pane | complete (design.md) |
| 3 | Publish the report with decisions for the owner | complete (report.html) |
| 4 | Owner approves decisions D1 to D14 | complete (decisions.md) |
| 5 | Briefs for Opus 5.5 (B1 tokens + UI lib, B2 parser + spec, B3 page + pane), run them | complete (B1 fb32b381, B2 ca2e1be4, B3 31551495) |
| 6 | Review, gates, land on main, Vercel check | complete (main 2d310d80, Vercel success) |

## Decisions

Recorded in `decisions.md` (D1 to D14, approved 2026-10-22, with the coordinator's adjustments).

## Left for later

From the sessions' reports: a share link with the overrides in the URL; Escape closing the pane; the type levels' own weights are not clamped when a picked font lacks a weight (only the three roles are); `/design` is 906 KB of HTML (96 KB gzipped) because the server-rendered tables repeat in the page payload; the upstream issue on references into unknown groups (D2) is not filed; the later phases of the design (other people's files through a server action, AI generation, a dark group in the profile).

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
