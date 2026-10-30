# Design, round 2

The design. Decisions R1–R6 at the end: all six answered by the owner on 2026-10-29.

## 1. The image panel does something: one panel per state

The panel (desktop column, phone banner) shows one **panel** per state of the page, built from Laura's devices. The headline and the section titles live on it, so the image has a reason to be there and the left column starts with "The people who change…".

| State | Panel (recommended) | Laura's device |
|-------|---------------------|----------------|
| Nothing open | Image, the headline "For everything you put your name to." in white, top left | tile 5 |
| The AI Lead role | Image, the title "The AI Lead role" as a label framed by small corner marks | tile 2 |
| Built upon six core values | **Black panel**, the six values in white Bold, numbered, big comma bottom right | tile 1 |
| The people behind the programme | Image, the title in white | tile 5 |
| Become an Answerable AP | **Black panel**, a large comma window onto an image, the "Answerable AP" grid lockup | tiles 6 and 4 |

- Two black panels mean two states need no new image, and the panel varies in kind, not only in photograph (feedback #4, "more varied imagery").
- Every image panel keeps the four corner marks; the black panels do not need them (the comma is already there).
- Panels crossfade as today (400 ms). The text on a panel is `aria-hidden` except the headline, which is the page's `h1`; the accordion already carries the section titles.

## 2. Text on images

- White, **Bold 700** like Laura's examples and the lockup (not Black 900): headline 40 px desktop, 24 px phone; section titles 28 px desktop, 20 px phone.
- Placed top left, inset by the marks' inset, max 12 words a line.
- **Legibility (R2):** a black gradient from the text's edge, 45 % at the edge fading to 0 % by 40 % of the panel's height, behind text only. Measured: the brightest 10 % of the current image under the headline reaches 4.3–5.7:1 at 40–50 %. When Laura's images are dark enough under the text, the gradient is set per panel to 0.

## 3. Corner marks (feedback #1)

Laura's proportion: squares 3.5 % of the panel's width, inset by the same amount. 24 px at 1440 wide, 33 px at 1920, 13 px on a phone banner. Sized with container units on the panel (`3.5cqw`), so one rule holds at every width.

## 4. Answerable AP grid lockup (feedback #1)

The grid logo frames a word with three squares and the comma at its corners (tiles 4 and 5). `components/new/grid-lockup.tsx`: "Answerable AP" as live text in Public Sans Bold, framed by the marks at Laura's tile-2 proportion (marks about 0.7 cap height). Used on the "Become an Answerable AP" panel, and above the form's heading as "Answerable AP" **(R4)**.

## 5. The call to action on first landing (feedback #2)

| Option | What changes | Button visible from a window this high |
|--------|--------------|----------------------------------------|
| **A (recommended)** | Headline moves to the panel; `main` margin 64→32 px, gaps 64→48 px | 900 px |
| B | As A, and the form comes before the four sections | 720 px |

A keeps the reading order (who it is for, what it is, then sign up). The header's "Register your interest" already reaches the form from any height.

## 6. Phone (feedback #5)

- The banner becomes **2:1** (188 px on a 375 px phone, was 281) with the headline on it. Measured: the sections start at 546 px (was 722) and the join section's heading is on the first screen (770 px).
- An open section's panel shows at the top of its accordion panel, also 2:1, with the same treatment as desktop (the values' black panel lists the values in the accordion as today, so on the phone it shows only the comma and the title).
- The corner marks scale down with the banner (13 px).

## 7. Swapping in Laura's images

`components/new/framings.ts` becomes `panels.ts`: one entry per state with its kind (`image`, `statement`, `window`), image, focal point, text, scrim strength. A new image is one file in `apps/web/assets/new/` and one line. Until Laura's images arrive the two current ones stay as placeholders.

## Work split

- **C1 (Sonnet 5.5):** panels data and component, overlay text and scrim, marks in `cqw`, the black statement panel, the comma window, the grid lockup, the headline's move, spacing A, phone banner.
- **Review (coordinator):** gates; browser at 375×812, 1280×720, 1440×900, 1920×1080; contrast re-measured on the built page; reduced motion.

## Decisions

| # | Question | Recommended | Answer |
|---|----------|-------------|--------|
| R1 | Panel per state as in the table above (two black panels), or images only with the section title on each? | Panel per state | Panel per state (owner) |
| R2 | White text on a gradient scrim, or wait for darker images (no scrim), or black text? | Gradient scrim, removable per panel | Gradient scrim (owner) |
| R3 | Call to action: A (spacing) or B (form before the sections)? | A | A (owner) |
| R4 | Answerable AP grid lockup: on the AP panel and above the form, on the AP panel only, or not yet? | AP panel and above the form | AP panel and above the form (owner) |
| R5 | Corner marks at Laura's 3.5 % (24 px at 1440), or smaller (2.5 %, 17 px)? | 3.5 % | 3.5 % (owner) |
| R6 | Phone banner 2:1 (188 px) or 5:2 (150 px)? | 2:1 | 2:1 (owner) |
