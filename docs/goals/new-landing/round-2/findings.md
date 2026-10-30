# Findings, round 2

Measured 2026-10-29 on production (`https://www.answerable.org/new`, commit 80adc027) in the Browser pane, and on the committed images with sharp.

## Laura's examples (`laura-examples.webp`, 1426×1172, tiles about 456 px wide)

| Tile | Device | Measured |
|------|--------|----------|
| 1 | Black panel, white Bold text top-left, big white comma bottom-right | comma 119×180 px = 26 % of the tile's width |
| 2 | Photo; a label in white framed by corner marks (three squares and the comma) | marks 10 px; comma 8×13 px |
| 3 | Photo; corner marks at the image's corners | squares 16 px = 3.5 % of the tile's width, about one square in from the edges |
| 4, 5 | Image; "Answerable" framed by corner marks (the grid logo); tile 5 adds white Bold body text at the bottom | — |
| 6 | Black panel; a large comma-shaped window onto a photo | — |

Overlay text in the examples is Bold, not Black. Every white overlay sits on a dark or mid-tone image.

**Our marks today are 8 px on a 697 px panel (1.1 %).** At Laura's 3.5 % they would be 24 px at 1440 wide (panel 697 px), 33 px at 1920 (953 px), 13 px on a 375 px phone banner.

## Where the form sits (desktop, every width from 1280: the content column is fixed at 560 px)

Bottom edges in px from the top of the window. Probed by editing the live page in the browser, not estimated.

| Layout | Email field | Submit button | Button visible on first screen at |
|--------|-------------|---------------|-----------------------------------|
| Today | 895 | 1024 | 1080 high only |
| Headline moved to the image | 795 | 924 | 1080 |
| A: headline moved, `main` margin 64→32, gaps 64→48 | 731 | 860 | 900 and up |
| B: as A, and the form before the sections | 507 | 636 | 720 and up |

The heights are the browser window's inner height (the page area), which is the screen's height less the browser's own bars.

## Phone (375×812)

| Layout | Banner height | Sections start | Join section starts |
|--------|---------------|----------------|---------------------|
| Today (4:3 band, headline below) | 281 (35 % of the screen) | 722 | 946 |
| 2:1 banner, headline on it | 188 | 546 | 770 |
| 5:2 banner, headline on it | 150 | 508 | 732 |

## White text over the current images

WCAG contrast of white against the image under the headline's area (hero framing at 1440×900, top left; source x 417–908, y 38–259 of `forum-stage.webp`). Large text (Bold 24 px and up) needs 3:1; body text 4.5:1.

| Treatment | Median | Brightest 10 % |
|-----------|--------|----------------|
| White, no scrim | 2.3 | 1.6 |
| White on a 30 % black scrim | — | 3.2 |
| White on a 40 % black scrim | — | 4.3 |
| White on a 50 % black scrim | — | 5.7 |
| Black text, no scrim (darkest 10 %) | — | 5.9 |

The bottom left (2.1 median) and the phone banner's lower half (2.4 median) are no better. **The current illustrations are too light for white text on their own.** Laura's examples work because her images are darker. Either the panel carries a scrim behind the text, or the images are chosen or commissioned dark enough under the text.

## DESIGN.md

It asks for text in imagery "always black or white, and never placed over busy areas", and for "no blur or haze" in imagery. A dark gradient behind overlay text is a legibility layer, not depth in the image, but it is a judgement call to record. Headings are sentence case (AGENTS.md), so the team's "AI Lead Role" becomes "The AI Lead role" as on the page.
