# Design, round 3

Evidence in `findings.md`. Decisions E1–E4 at the end: all four answered by the owner on 2026-11-02, each with the recommendation.

## 1. Sections always on show

- The accordion and "Click to expand below:" go. Each section is an `h2` and its copy, all visible, in the left column.
- No-JS readers now get all the text.

## 2. The image follows the scroll (from lg)

- The sticky column keeps its stacked panels and 400 ms crossfade; reduced motion cuts instead.
- One passive scroll listener picks the active section: the last whose top has passed a line that travels from 200 px down to 60 % of the window as the page scrolls.
- Before the first section: the hero panel. From the AP section to the end of the page, the form included: the AP panel.
- Without JS: the hero panel stays.

## 3. Corner marks, with the words large and in the middle

- Every image panel: the four corner marks on the image's corners, as now. The framed label goes.
- Every panel's words use one style, today's headline: `clamp(24px, 5.7cqw, 48px)`, Bold. 41 px at 1440, 48 px at 1920, 24 px on a phone. Centred, both ways.
- A horizontal band of black behind them, peak 0.5, fading to nothing above and below: 4.5:1 on the brightest pixels of every panel. Goes per panel when Laura's images allow.
- The values panel: its title, large and in the middle, the big comma as now. The six values move to the left column at every width, so the section is long enough to read while its panel shows.
- The AP panel: black, comma window, badge top left, as at ff3018a3.

## 4. The badge

`<GridFrame>Answerable AP</GridFrame>`: top left on the AP panel; on the heading's line from lg and above it on phones, `text-sm font-bold`. `CredentialMark` is deleted.

## 5. Phones

The banners sit in the flow: hero under the header, and one above each section's copy, the title in the middle of it. The `h2` stays for screen readers, hidden visually below lg, so the title does not show twice. The AI Lead section gets a banner again, since it now carries the title.

## 6. The form

- **Fields:** Email, Country, Business name, Business headcount; 2×2 from `sm`, stacked on phones.
- **Headcount** is a select of bands: 1–10, 11–50, 51–200, 201+.
- **`/new` requires all four.** A second server action, `joinFoundingCohort`, requires them; `joinWaitlist` and `/` stay as they are, sharing `submitWaitlist`.
- **Copy:** "Leave your email and we'll send you…" becomes "Leave your details and we'll send you…".
- **Sheet:** columns `business_name`, `business_headcount`, appended after `contacted` on the live sheet. Stored as text on insert and update, never as a formula. A signup without them leaves the existing cells alone. Business name trimmed, at most 200 characters. Not logged.

## Work split

- **E1:** waitlist and sheet, with tests: required fields, bands, the formula test on the update path, a `/` resubmit keeping the cells.
- **E2:** page, scroll hook, panels, badge, form fields, deletes.
- **Review:** gates, the browser sizes in `task_plan.md`, a real submit against the fake sheet path in development, contrast on the built page.

## Decisions

| # | Question | Recommended | Answer |
|---|----------|-------------|--------|
| E1 | Phones: images in the flow above each section, or one sticky banner that changes? | In the flow | In the flow (owner) |
| E2 | Words in the middle on every panel, the hero's headline included? | Every panel | Every panel (owner) |
| E3 | Six values: list on the left with the title on the panel, or stay on the panel? | List on the left | List on the left (owner) |
| E4 | Business fields: required with headcount bands, optional, or free-text number? | Required, bands | Required, bands (owner) |
