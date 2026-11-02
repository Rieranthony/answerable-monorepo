# Findings, round 3

Measured 2 November 2026 on `www.answerable.org/new` with every section forced open in the browser; nothing submitted, nothing deployed. Throwaway scripts lived in the session's scratchpad.

## The page with every section open

| | 1440×900 | 390×844 |
|---|----------|---------|
| Sticky header | 86 px | 70 px |
| Image | 713×870 | 390×195 |
| Copy column | 560 px | 342 px |
| Section heights (AI Lead, values, people, AP) | 256, 80, 328, 472 | 376, 718, 707, 923 |
| Join section top | 1622 | 3485 |
| Page height | 2195 | 4210 |

- **The form leaves the first screen.** Its top moves to 2166 at 1440×900. The header's "Register your interest" link already covers this: it shows while the form is out of view and scrolls to it.
- **The values section is 80 px tall from lg**, because the list is screen-reader-only there and the panel shows it. In a scrolling page its panel would flash by. With the list visible, the section takes 408 px of scroll (tops 262, 558, 966, 1334).
- **On a phone with its browser bars, about 697 px shows** (owner's screenshot: 1286 of 1600 image px at 1.846 scale). A sticky header and banner take 265 px of it: 38 %.

## Scroll rule

A fixed trigger line fails on one size or another. Scroll available per panel, from the measured tops:

| Line | 1280×720 | 1440×900 | 1920×1080 | 2560×1440 |
|------|----------|----------|-----------|-----------|
| 25 % of the window, hero / AI Lead / AP | 82 / 296 / 609 | 37 / 296 / 450 | **0** / 288 / 315 | **0** / 198 / **45** |
| 40 % of the window, hero / AI Lead / AP | **0** / 270 / 717 | **0** / 198 / 585 | **0** / 126 / 477 | **0** / **0** / 261 |

A 2560×1440 window at 40 % never shows the AI Lead panel; at 25 % the AP panel gets 45 px. At many sizes the hero panel never shows at all.

**A line that travels with the scroll fixes it:** 200 px from the top at scroll 0, 60 % of the window at the end of the page.

| Scroll per panel | 1280×720 | 1440×900 | 1920×1080 | 2560×1440 |
|------------------|----------|----------|-----------|-----------|
| Hero | 55 | 51 | 47 | 37 |
| AI Lead | 261 | 243 | 223 | 179 |
| Values | 361 | 335 | 308 | 247 |
| People | 325 | 302 | 278 | 222 |
| AP | 761 | 628 | 523 | 333 |

Computed from measured tops and scroll lengths, not yet run as code. The form's two new fields add scroll, so re-measure on the build.

## White words in the middle of the images

White text, against the crop's middle box (76 % of the width; 24 % of a column's height, 50 % of a banner's), measured in the image's pixels.

| Panel | Shape | Median | Brightest 10 % | Scrim for 3:1 | Scrim for 4.5:1 |
|-------|-------|--------|----------------|---------------|-----------------|
| Hero | column | 4.22:1 | 1.26:1 | 0.36 | 0.49 |
| Hero | banner | 3.62:1 | 1.29:1 | 0.35 | 0.48 |
| AI Lead | column | 4.32:1 | 1.37:1 | 0.33 | 0.47 |
| AI Lead | banner | 3.62:1 | 1.29:1 | 0.35 | 0.48 |
| People | column | 6.26:1 | 2.85:1 | 0.03 | 0.23 |
| People | banner | 4.47:1 | 1.81:1 | 0.23 | 0.39 |

**The current scrim cannot help:** it is black at the top edge and gone by the middle. The words need a band of black behind the middle, peak 0.5, to reach 4.5:1 on the brightest pixels of every panel.

## The badge

- 583454a6 replaced `<GridFrame>Answerable AP</GridFrame>` with the square `CredentialMark`, on the panel and above the form.
- At ff3018a3 it was a rectangular word between the corner marks: top left on the AP panel, and on the heading's line from lg (above the heading on phones) in `text-sm font-bold`.
- So `GridFrame` stays, for this badge only, and `CredentialMark` goes. This is not the "frame within a frame": the AP panel is black with no corner marks, and the form sits on white.

## The form

- **`/` uses the same `WaitlistForm`, the same action and the same sheet.** It must keep working with two fields.
- **A `/` signup must not blank a `/new` signup's business details.** The upsert overwrites client-owned cells on a repeat address, so absent fields must be skipped.
- **Formula injection, confirmed in the installed library.** `google-spreadsheet` 5.3.0 treats a string starting with `=` as a formula when set through `cell.value`: run, `"=IMPORTXML(…)"` gave `formulaValue`. Today only validated country values take that path; a business name would not be validated. The insert path is safe (`raw: true` sends `valueInputOption: RAW`), so a repeat signup is the attack. `cell.stringValue = …`, run, gave `stringValue`. The fake worksheet in `lib/test-helpers.ts` must model the difference, or the test proves nothing.
- **`WRITTEN = COLUMNS.slice(0, 5)` is positional.** New columns go after `contacted`, which the reader owns, so the slice must become a filter. `ensureHeader` already appends missing columns to a live sheet (`setHeaderRow`, which throws above the sheet's column count; a new sheet has 26).
- `packages/ui` has `select.tsx`; a headcount select needs no new component.

## Deletes with the accordion

Only `/new` uses them: `keepFormInView`, `isPanelKey`, "Click to expand below:", `ExpandableSection`'s `size`, `ExpandableSections`' `onValueChange` (check `/` at build), `bare`, the `label` and `title` text styles, `CredentialMark`.
