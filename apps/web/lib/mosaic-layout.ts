/**
 * Layout engine for the hero mosaic: one photo cut into a 12×18 grid of
 * 48-unit cells (the logo's own module — a frame square is one cell, the
 * comma is 1×1.5 cells). The grid is solid at the right edge and dissolves
 * leftward into scattered logo punctuation.
 *
 * Everything is driven by one seeded PRNG so the output is identical on every
 * render — the page is statically prerendered and must stay deterministic.
 * The PRNG call order defines the layout; treat any reordering as a reseed.
 */

export const MOSAIC = {
  seed: 20260829,
  cols: 17,
  rows: 18,
  cell: 48, // viewBox 816×864
  gap: 4, // gutter between tiles, carved out of each cell's clip window
  photoCols: 12, // the 2:3 photo is anchored to the rightmost 12 columns
  // Dissolve boundary: a per-row random walk of the column where the solid
  // mass begins, pushed right near the top/bottom edges. minStart keeps the
  // dense mass (boundary + band) inside the photo region.
  baseStart: 4,
  minStart: 3,
  maxStart: 5,
  cornerPush: 1,
  boundaryBand: 2, // ragged band width, in columns
  boundaryKeep: 0.65,
  boundaryComma: 0.18,
  // Scatter zone left of the band: p = scatterMax * scatterFalloff^(dist-1)
  scatterMax: 0.4,
  scatterFalloff: 0.75,
  commaWeight: 0.6, // comma vs square among scattered marks
  imageReach: 1, // cols past the band where marks still show photo fragments
  semicolons: 3,
  // Solid scattered marks fade with distance from the boundary (fill-opacity
  // from fadeNear at dist 1 to fadeFar at the far edge of the scatter zone).
  fadeNear: 0.85,
  fadeFar: 0.45,
  grayRate: 0, // grayscale retired — knob kept in case it returns
  // Entrance: a quick fade-in with a small random stagger per tile;
  // everything has settled within staggerMs + the CSS duration.
  staggerMs: 240,
} as const

/** Bounding box of COMMA_PATH in the logo's own coordinates. */
export const COMMA_BOX = { x: 1103.79, y: 215.998, w: 48.21, h: 72.002 } as const
/** Normalizes the comma to a 48-unit-wide, cell-local shape (undistorted). */
export const COMMA_SCALE = 48 / COMMA_BOX.w

export const MOSAIC_PHOTOS = [
  "/mosaic/p1.webp", // jonathan-borba
  "/mosaic/p2.webp", // magnus-andersson
  "/mosaic/p3.webp", // wesley-eland
  "/mosaic/p4.webp", // good-faces
  "/mosaic/p5.webp", // teah-rushing (baroque ceiling fresco)
  "/mosaic/p6.webp", // annie-spratt (team around a table)
] as const

/** The mosaic shows one photo at a time; switch it here. */
export const ACTIVE_PHOTO: (typeof MOSAIC_PHOTOS)[number] = MOSAIC_PHOTOS[5]

export type Rot = 0 | 90 | 180 | 270

export interface Mark {
  shape: "square" | "comma" | "semicolon"
  col: number
  row: number
  rot: Rot // squares and semicolons are always 0
  fill: "image" | "solid"
  fade: number // fill-opacity; 1 for the mass, graded down in the scatter
  gray: boolean
  delayMs: number
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Comma footprints on the half-cell occupancy grid, per rotation (pivot is
 * the owning cell's center): [dRow, dCol, hRows, wCols] relative to (2r, 2c).
 * rot 0 tail → top half of the cell below; 90 → right half of the left
 * neighbor; 180 → bottom half of the cell above; 270 → left half of the
 * right neighbor.
 */
const COMMA_FOOT: Record<Rot, [number, number, number, number]> = {
  0: [0, 0, 3, 2],
  90: [0, -1, 2, 3],
  180: [-1, 0, 3, 2],
  270: [0, 0, 2, 3],
}

export function computeMosaicLayout(): Mark[] {
  const { cols, rows } = MOSAIC
  const photoStart = cols - MOSAIC.photoCols // first column with photo under it
  const rand = mulberry32(MOSAIC.seed)
  const marks: Mark[] = []

  // Occupancy at half-cell resolution: a square claims 2×2, a comma 2×3 or
  // 3×2 (rotation-dependent), so a comma tail forces its half-cell neighbor
  // out automatically.
  const occ = Array.from({ length: rows * 2 }, () =>
    new Array<boolean>(cols * 2).fill(false),
  )
  const free = (r0: number, c0: number, h: number, w: number) => {
    if (r0 < 0 || c0 < 0 || r0 + h > rows * 2 || c0 + w > cols * 2) return false
    for (let r = r0; r < r0 + h; r++)
      for (let c = c0; c < c0 + w; c++) if (occ[r][c]) return false
    return true
  }
  const claim = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++)
      for (let c = c0; c < c0 + w; c++) occ[r][c] = true
  }

  const anim = () => ({ delayMs: Math.round(rand() * MOSAIC.staggerMs) })

  // fill-opacity for a solid mark `dist` columns left of the boundary.
  const fadeAt = (dist: number) => {
    const t = Math.min(1, Math.max(0, dist - 1) / (MOSAIC.maxStart - 1))
    return Math.round((MOSAIC.fadeNear + (MOSAIC.fadeFar - MOSAIC.fadeNear) * t) * 100) / 100
  }

  function placeComma(
    r: number,
    c: number,
    fill: "image" | "solid",
    fade = 1,
  ) {
    const rots = ([0, 90, 180, 270] as Rot[])
      .map((rot) => ({ rot, sort: rand() }))
      .sort((a, b) => a.sort - b.sort)
    for (const { rot } of rots) {
      const [dr, dc, h, w] = COMMA_FOOT[rot]
      if (!free(2 * r + dr, 2 * c + dc, h, w)) continue
      // An image comma's tail must not sample left of the photo's edge.
      if (fill === "image" && 2 * c + dc < 2 * photoStart) continue
      claim(2 * r + dr, 2 * c + dc, h, w)
      marks.push({
        shape: "comma",
        col: c,
        row: r,
        rot,
        fill,
        fade,
        gray: fill === "image" && rand() < MOSAIC.grayRate,
        ...anim(),
      })
      return
    }
  }

  // 1. Dissolve boundary: a smooth random walk down the rows (coastline
  // continuity — independent per-cell holes read as broken rendering).
  const start: number[] = []
  let s = Math.round(MOSAIC.baseStart + (rand() * 2 - 1) * 1.5)
  for (let r = 0; r < rows; r++) {
    const step = [-1, 0, 0, 1][Math.floor(rand() * 4)]
    s = Math.min(MOSAIC.maxStart, Math.max(MOSAIC.minStart, s + step))
    const edge = Math.min(r, rows - 1 - r)
    const push = edge === 0 ? MOSAIC.cornerPush : edge === 1 ? 1 : 0
    start[r] = Math.min(cols - 4, s + push)
  }

  // 2. Dense mass, placed first so comma tails collide with it correctly.
  for (let r = 0; r < rows; r++)
    for (let c = start[r] + MOSAIC.boundaryBand; c < cols; c++) {
      claim(2 * r, 2 * c, 2, 2)
      marks.push({
        shape: "square",
        col: c,
        row: r,
        rot: 0,
        fill: "image",
        fade: 1,
        gray: rand() < MOSAIC.grayRate,
        ...anim(),
      })
    }

  // 3. Ragged band at the boundary: squares, comma-clipped tiles, holes.
  // Band cells left of the photo's edge fall back to solid marks.
  for (let r = 0; r < rows; r++)
    for (let c = start[r]; c < Math.min(start[r] + MOSAIC.boundaryBand, cols); c++) {
      const fill = c >= photoStart ? "image" : "solid"
      const u = rand()
      if (u < MOSAIC.boundaryKeep && free(2 * r, 2 * c, 2, 2)) {
        claim(2 * r, 2 * c, 2, 2)
        marks.push({
          shape: "square",
          col: c,
          row: r,
          rot: 0,
          fill,
          fade: 1,
          gray: fill === "image" && rand() < MOSAIC.grayRate,
          ...anim(),
        })
      } else if (u < MOSAIC.boundaryKeep + MOSAIC.boundaryComma) {
        placeComma(r, c, fill)
      }
    }

  // 4. Semicolon delighters: square + half-cell gap + comma (3 cells tall),
  // solid and never rotated, claimed with a half-cell margin all around.
  let placed = 0
  for (let tries = 0; tries < 40 && placed < MOSAIC.semicolons; tries++) {
    const r = 2 + Math.floor(rand() * (rows - 6))
    const c = Math.max(0, start[r] - 2 - Math.floor(rand() * 2))
    if (!free(2 * r - 1, 2 * c - 1, 9, 4)) continue
    claim(2 * r - 1, 2 * c - 1, 9, 4)
    marks.push({
      shape: "semicolon",
      col: c,
      row: r,
      rot: 0,
      fill: "solid",
      fade: fadeAt(start[r] - c),
      gray: false,
      ...anim(),
    })
    placed++
  }

  // 5. Scatter zone: punctuation decaying leftward. Near the mass it still
  // shows photo fragments; further out it turns solid brand grey.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < start[r]; c++) {
      const dist = start[r] - c
      const p = MOSAIC.scatterMax * Math.pow(MOSAIC.scatterFalloff, dist - 1)
      if (rand() >= p) continue
      const fill =
        dist <= MOSAIC.imageReach && c >= photoStart ? "image" : "solid"
      const fade = fill === "solid" ? fadeAt(dist) : 1
      if (rand() < MOSAIC.commaWeight) {
        placeComma(r, c, fill, fade)
      } else if (free(2 * r, 2 * c, 2, 2)) {
        claim(2 * r, 2 * c, 2, 2)
        marks.push({
          shape: "square",
          col: c,
          row: r,
          rot: 0,
          fill,
          fade,
          gray: fill === "image" && rand() < MOSAIC.grayRate,
          ...anim(),
        })
      }
    }

  return marks
}
