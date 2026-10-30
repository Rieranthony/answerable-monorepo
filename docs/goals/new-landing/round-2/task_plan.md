# New landing page, round 2

Started 2026-10-29, after `/new` shipped (80adc027). The team's feedback on it, in their words (numbered as sent; there is no #3):

1. "Loading animation and colour is warm and welcoming, like that. I also support the adjusted 'app' style logo. We can use the grid logo for Answerable AP as a sub-brand I think. I like having the squares and comma over the image as you have them, but I think they need to be bit larger. Like these examples by Laura."
2. "I wonder if 'For everything you put your name to.' should be in white over the image, almost to give the image a 'reason' to be there. Then we could simply start the copy with 'The people who change…' which would shift things up a bit and make the call to action visible on first landing. I feel the image is nice and good vibes, but the pane needs to 'do' more."
4. "The landing placeholder image isn't right yet for a few reasons, so I think we need Laura to run more tests and ideas for that. I like that the image changes with each dropdown click. I would support the idea of more varied imagery with each click. Or that we replace the words on the large image to match the dropdown 'AI Lead Role', 'Six Core Values', 'The People Behind the Programme', 'Become an Answerable AP'. These tests Laura did were nice as examples of how we can play with the image panel."
5. "The mobile view supports the idea that the landing image would be good to have a purpose. I think it needs to be more banner shaped on mobile (if that's possible) because it takes a lot of the screen."

Laura's examples: `laura-examples.webp` (six tiles). The owner asked for planning files and a report before any code.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Read the feedback, measure Laura's examples and the live page | complete |
| 1 | Write the facts (`findings.md`) and the design (`design.md`) | complete |
| 2 | Publish the report (https://claude.ai/artifact/J77ySnQK2QoYB4GYTcqRbb), owner answers the decisions | complete |
| 3 | Brief Sonnet 5.5: C1 (`briefs/C1.md`) | complete |
| 4 | Review, gates, browser at 375, 1280×720, 1440×900, 1920×1080 | complete |
| 5 | Land on main, Vercel check | complete |

## Scope

- In: `/new` only. The image panel (desktop) and banner (phone), the headline's move, the corner marks, the spacing above the form, the Answerable AP lockup.
- Out: the splash (approved as is), the copy (unchanged but for the headline's place), `/`, the form's behaviour. New imagery is Laura's; this round builds the panel so her images drop in.

Worktree `.claude/worktrees/new-landing-r2`, branch `claude/new-landing-r2`, from main 80adc027.
