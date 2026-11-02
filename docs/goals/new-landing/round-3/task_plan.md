# Round 3: scroll-led /new

The root `task_plan.md`, `findings.md` and `progress.md` belong to the customer-app sign-in audit. This round's files live here; the session log stays in `../progress.md`.

**Goal.** Replace click-to-expand on `/new` with sections always on show, the image following the scroll; put words large and in the middle of the images; bring back the rectangular Answerable AP badge; add business name and headcount to the form.

**E1–E4 answered (`design.md`); built, approved and landed on 2 November 2026.** Report: https://claude.ai/artifact/3yjMeYyeEv9uyom5tpA2YV

## The feedback, as given

- Owner: no click to expand. Sections on the left while scrolling; the linked illustration shows automatically from the scroll position.
- Owner: the "Answerable AP" badge goes back to how it was: rectangular, not square.
- Cofounder: "I think the frame within a frame isn't working. I prefer the squares in the corners of whatever image we have and the words appear larger and in the middle". Their screenshot circles the framed "The AI Lead role" label inside the image's corner marks.
- Cofounder: "If we could add "Business Name" and "Business Headcount" to the form that might be good too. I prefer very simple CTA because it makes it more likely people will respond but I agree with Stephen that this info would really help when we're deciding who gets into the cohort"

The message says "some images"; one arrived (the phone screenshot). Ask whether there are more.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Read the page, panels, form, sheet client, rounds 1 and 2 | complete |
| 2 | Measure the live page; probe scroll rule, contrast, sheet writes | complete |
| 3 | Design and decisions (`design.md`), report | complete |
| 4 | Owner answers | complete |
| 5 | Build in a worktree: E1 waitlist and sheet, E2 page and panels | complete |
| 6 | Review: gates, browser at 375×812, 1280×720, 1440×900, 1920×1080, 2560×1440. Not run on the build: contrast, no-JS, reduced motion | complete |
| 7 | Land on main after the owner approves; check Vercel | complete |

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| `javascript_tool` timed out | `requestAnimationFrame` in a hidden pane never fires | Measure synchronously |
| `localhost:47100/new` returns 500 | The owner's dev server dates from 30 October, on Next 16.2.6; main is on 16.4.3 | Left it running; measured `www.answerable.org/new`, whose `/new` code is unchanged since 583454a6 |
