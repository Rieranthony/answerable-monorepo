/**
 * Cuts the mosaic "sprites": center-crops each source photo to exact 2:3 and
 * emits one optimized color webp per photo. The mosaic component then shows
 * square fragments of these four files via SVG clip windows — no per-tile
 * image files, four requests total.
 *
 * Run from apps/web: `bun run mosaic`. Output is committed.
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SRC = join(ROOT, "mosaic-source")
const OUT = join(ROOT, "public", "mosaic")

// One photo fills the whole 12×18 mosaic (ACTIVE_PHOTO in lib/mosaic-layout),
// so sprites are sized for ~2x of the full mosaic width; only the active one
// is ever fetched.
const WIDTH = 1280
const HEIGHT = 1920
const QUALITY = 70
const BUDGET_KB = 150 // per file — only one ships per page view
const PHOTOS = [
  { src: "jonathan-borba-EJMJc1zNuLc-unsplash.jpg", out: "p1.webp" },
  { src: "magnus-andersson-KAzgxInZXMo-unsplash.jpg", out: "p2.webp" },
  { src: "wesley-eland-j9K2_EWlArI-unsplash.jpg", out: "p3.webp" },
  { src: "good-faces-p1E9zC5eSTE-unsplash.jpg", out: "p4.webp" },
  // Painterly texture compresses poorly; the lower quality is invisible at
  // tile scale and keeps the default photo inside the budget.
  { src: "teah-rushing-hCQljvkt9Ek-unsplash.jpg", out: "p5.webp", quality: 55 },
  { src: "annie-spratt-MChSQHxGZrQ-unsplash.jpg", out: "p6.webp" },
]

await mkdir(OUT, { recursive: true })

for (const { src, out, quality = QUALITY } of PHOTOS) {
  const info = await sharp(join(SRC, src))
    .rotate() // honor EXIF orientation
    .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
    .webp({ quality, effort: 6 })
    .toFile(join(OUT, out))
  const kb = info.size / 1024
  console.log(
    `${out}  ${kb.toFixed(0)} KB  (${src})${kb > BUDGET_KB ? ` — over the ${BUDGET_KB} KB budget, lower QUALITY` : ""}`,
  )
}
