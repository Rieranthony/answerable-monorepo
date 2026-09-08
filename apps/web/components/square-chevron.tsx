import type { CSSProperties } from "react"

const SIZE = 1.5
const PITCH = 2.5
const BOX = 16
// Squares and offsets stay on half-pixel steps, so at 2x every edge lands on
// a device pixel.
const STEP = 0.5

type GridPosition = readonly [column: number, row: number]

// The chevron sits at the end of the heading, so it points down when the
// panel is closed and up when it is open, as an accordion control does.
const CLOSED_POSITIONS = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 1],
  [4, 0],
] as const satisfies readonly GridPosition[]

const OPEN_POSITIONS = [
  [0, 2],
  [1, 1],
  [2, 0],
  [3, 1],
  [4, 2],
] as const satisfies readonly GridPosition[]

function centerPositions(positions: readonly GridPosition[]) {
  const columns = Math.max(...positions.map(([column]) => column)) + 1
  const rows = Math.max(...positions.map(([, row]) => row)) + 1
  const width = (columns - 1) * PITCH + SIZE
  const height = (rows - 1) * PITCH + SIZE
  const offsetX = Math.round((BOX - width) / 2 / STEP) * STEP
  const offsetY = Math.round((BOX - height) / 2 / STEP) * STEP

  return positions.map(
    ([column, row]) =>
      [offsetX + column * PITCH, offsetY + row * PITCH] as const,
  )
}

const CLOSED_PIXELS = centerPositions(CLOSED_POSITIONS)
const OPEN_PIXELS = centerPositions(OPEN_POSITIONS)

export function SquareChevron() {
  return (
    <span
      aria-hidden="true"
      className="text-muted-foreground group-hover:text-foreground group-data-panel-open:text-foreground flex h-6 w-4 shrink-0 items-center transition-colors"
    >
      <span className="relative block size-4">
        {CLOSED_PIXELS.map(([closedX, closedY], index) => {
          const [openX, openY] = OPEN_PIXELS[index]

          return (
            <span
              key={`${closedX}-${closedY}`}
              className="absolute top-0 left-0 [translate:var(--closed)] bg-current transition-[translate] duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)] group-data-panel-open:[translate:var(--open)] motion-reduce:transition-none"
              style={
                {
                  width: SIZE,
                  height: SIZE,
                  "--closed": `${closedX}px ${closedY}px`,
                  "--open": `${openX}px ${openY}px`,
                  transitionDelay: `${index * 15}ms`,
                } as CSSProperties
              }
            />
          )
        })}
      </span>
    </span>
  )
}
