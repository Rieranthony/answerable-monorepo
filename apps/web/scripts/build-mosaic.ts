/** Generate the hero photograph. Dithering stays in the browser shader. */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const OUT = join(ROOT, "public", "mosaic")
const BUDGET_KB = 150

await mkdir(OUT, { recursive: true })

// Keep the current crop and encoding; the shader supplies the halftone.
const info = await sharp(
  join(ROOT, "mosaic-source", "ai-leaders-discussion-2026.jpg"),
)
  .rotate()
  .resize(1280, 1920, { fit: "cover", position: "centre" })
  .webp({ quality: 46, effort: 6 })
  .toFile(join(OUT, "p8.webp"))
const kb = info.size / 1024
console.log(
  `p8.webp  ${kb.toFixed(0)} KB${kb > BUDGET_KB ? ` — over the ${BUDGET_KB} KB budget` : ""}`,
)
