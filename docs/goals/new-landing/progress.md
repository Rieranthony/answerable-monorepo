# Progress

## 2026-10-29

- Read `/` (`app/(site)/page.tsx`), its dark root layout, the waitlist form, the logo data in `@answerable/ui`, DESIGN.md and the seven supplied images; measured the images and the accent contrasts (findings.md).
- Wrote the design (design.md) with seven open questions. Waiting for the owner's answers before any code.
- Owner: the banners are references only; images 6 and 7 are the site's images. Copied them to `apps/web/brand-source/` and gave each section its own crop of one of them.
- Owner answered (D1–D7 in design.md): splash once per page load, white comma on random accents, keep the accordion, lockup in code, image right, noindex.
- Worktree `.claude/worktrees/new-landing`, branch `claude/new-landing`, from origin/main f5ac3da7. Images moved to `apps/web/assets/new/`; framings checked on a contact sheet; one `next/image` per file with `object-position`, no baked crops.
- B1 (Sonnet 5.5) built the route group `(new)`, the page, `components/new/*`, the splash (CSS keyframes in `globals.css`), `autoFocus` on the waitlist form and `onValueChange`/`size` on the accordion (`/` unchanged).
- Review in the Browser pane (dev server from the worktree, port 47110): splash scrubbed by pausing a clone's animations — dots at 200/400/600 ms, comma at 1.3 s, the hole concentric with the white comma (CTMs match the overlay centre), the page revealed through the growing comma by 1.75 s; random colour set before paint; opening a section crossfades the image column; phone 375 has no sideways scroll; lockup comma sits on the cap line with its tail below the baseline; no console errors.
- Gates: typecheck 0, lint 0, web test 117 pass, Prettier clean, build lists `/new` as static.
- Browser-pane gotchas: `preview_start` reads the main checkout's `.claude/launch.json`, so a temporary entry with `bun run --cwd <worktree>/apps/web dev` was added and reverted; the hidden pane shows stale frames when animations are scrubbed, so wait a second before each capture and trust `getScreenCTM` over a small screenshot.
- Owner feedback round 1: comma too big; content shifts when a section opens; "Register your interest" did nothing; remove the docs link.
  - Lockup: measured the banner lockup at 4× (comma 1.26 cap tall, top 0.09 cap above the capitals, tail 0.17 cap below the baseline, gap 0.45 cap; Public Sans cap height 0.723 em); the comma is now sized and placed in CSS `cap` units (18.2 px on 20 px text, was 22 px).
  - Shift: with every section closed the page fits a tall window, so opening one adds a scrollbar and both columns lose 15 px (text moved 3.75 px, image rescaled). `scrollbar-gutter: stable` on `<html>` in the `(new)` layout; the heading stays at x 76.25 open or closed.
  - Register link: it worked, but the form is usually on screen already and the page cannot scroll further, so it looked dead. `components/new/register-link.tsx` scrolls the form into view and focuses the email field; `#join` stays as the no-JS fallback; `scroll-mt-8` on the section.
  - Footer: docs link removed.
  - Gates: typecheck 0, lint 0, 117 tests pass, Prettier clean.
- Owner: frame the image with the gutter's width. The image column now has a white frame top, bottom and right as wide as the scrollbar's gutter (15 px here), the gutter itself being the right side; where scrollbars overlay the page the frame is 16 px. This Chrome leaves a `scrollbar-gutter: stable` gutter out of `100vw` (both 1425 px), so CSS cannot measure it: `FRAME_SCRIPT` (in `image-column.tsx`, inlined in the layout) sets `--gutter` and `--frame` before paint, again on DOMContentLoaded and load (the first run read 0) and on resize. Measured: 15 / 15 / 15.
- Owner: the frame was wider on the right on large screens. When the whole page fits the window, `clientWidth` reports no gutter although `scrollbar-gutter: stable` keeps one, so the right side was 16 + 15 px. `FRAME_SCRIPT` now reads `innerWidth - body width`. Measured top / bottom / right = 15 / 15 / 15 at 1440×800, 1440×1300, 1920×1080 and 2560×1440.
- Owner: the same frame around the splash. The colour field now sits inside a white frame as wide as the gutter (15 px top, left and bottom; on the right the gutter, which is outside the fixed overlay). The frame is a border on a transparent box, not a white backdrop, so the comma's hole still shows the page; it fades over 2000–2200 ms as the comma finishes opening, when it lines up with the image column's own frame. Measured 15 / 15 / 15 / 15 at 1440×900.
- Owner approved. Build 0 (`/new` static); landed on main.

## 2026-10-29, round 2

- Team feedback on the live `/new` (four points, quoted in `round-2/task_plan.md`) and Laura's six examples (`round-2/laura-examples.webp`). Worktree `.claude/worktrees/new-landing-r2`, branch `claude/new-landing-r2`, from 80adc027.
- Measured Laura's marks (3.5 % of a tile), the live page's form position at four window sizes, three probed layouts (edited live in the browser), the phone banner at 4:3, 2:1 and 5:2, and white-text contrast over the current image with and without a scrim (`round-2/findings.md`).
- Wrote the design with decisions R1–R6 (`round-2/design.md`). Report next; no code before the owner's answers.
- Report published: https://claude.ai/artifact/J77ySnQK2QoYB4GYTcqRbb (mock-ups of the five panels, contrast and form-position tables, R1–R6). Waiting for the owner's answers.
- Owner answered R1–R4 with the recommendations (panel per state, gradient scrim, option A, AP lockup on the panel and above the form). R5 (3.5 % marks) and R6 (2:1 phone banner) on the recommendation, to confirm with the go-ahead.
- Owner: go ahead, R5 3.5 % marks, R6 2:1 phone banner.
- C1 (Sonnet 5.5) built the panel system: `panels.ts`, `panel.tsx` (image, statement, window; `column`, `banner`, `responsive` shapes), `grid-frame.tsx`, `frame-script.ts`; deleted `framings.ts`, `panel-image.tsx`, `image-column.tsx`. One `<h1>` in the built HTML.
- Coordinator fixes after review: the Answerable AP lockup above the form cost 45 px and pushed the button to 904 px, so from lg it sits on the heading's line (button back to 860 px); on phones it stays above the heading. Phone section panels drop their title (`bare`), which the accordion shows right above.
- Measured in the Browser pane: button bottom 860 px at 1280, 1440 and 1920 wide; marks 22 / 25 / 33 px (3.5 % of 633 / 713 / 953 px panels); headline 40.6 px at 1440, 48 px at 1920, 24 px on a phone; phone banner 188 px, sections at 530 px, join at 754 px; one `h1`; no sideways scroll at 375; all five panels render. The pane sometimes captured the hero image unpainted on first load below lg and at 1920; a plain reload painted it, and hiding the other panels showed it was a missed repaint in the pane, not layout. Gates: typecheck 0, lint 0, 117 tests, Prettier clean, knip no new findings.
- Owner approved round two. Build 0 (`/new` static, one `h1`); landed on main.
