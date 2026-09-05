# Mosaic source photograph

`ai-leaders-discussion-2026.jpg` is Answerable's own photograph from AI Leaders
Discussion 2026.

Run `bun run mosaic` from `apps/web` to centre-crop it to 2:3, resize it to
1280×1920 and write `public/mosaic/p8.webp`. The generated file is committed
and is the only photograph loaded by the mosaic.

The browser shader applies the halftone using separate light and dark settings
in `lib/mosaic-layout.ts`. The development tuner previews adjustments and copies
settings to paste into `MOSAIC_DITHER`.
