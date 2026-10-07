const POLL_MS = 100
const CONCEDE_MS = 6_000
const HARD_CAP_MS = 20_000

/**
 * Ignore flat buffers and canvases narrower than `minWidth` while the shader
 * catches up. A canvas that has not been sized yet
 * (in a hidden tab, never) holds the browser's 300×150 default, and a frame
 * that small would stay on the hero for the life of the page.
 */
function probe(
  canvas: HTMLCanvasElement,
  scratch: CanvasRenderingContext2D,
  minWidth: number,
) {
  if (canvas.width < minWidth || !canvas.height) return null
  const { width, height } = scratch.canvas
  scratch.drawImage(canvas, 0, 0, width, height)
  const { data } = scratch.getImageData(0, 0, width, height)
  let uniform = true
  let hash = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== data[0]) uniform = false
    hash = (hash * 31 + data[i]) | 0
  }
  return uniform ? null : String(hash)
}

/** Capture one frame; cancellation also invalidates pending blob callbacks. */
export function startMosaicCapture({
  getCanvas,
  minWidth,
  scratch,
  onCapture,
  onUnavailable,
}: {
  getCanvas: () => HTMLCanvasElement | null
  /** The narrowest canvas worth committing, in pixels. */
  minWidth: number
  scratch: CanvasRenderingContext2D
  onCapture: (blob: Blob, signature: string) => void
  onUnavailable: () => void
}) {
  let active = true
  let timer = 0
  let startedAt = Date.now()
  const onVisibility = () => {
    if (!document.hidden) startedAt = Date.now()
  }
  const stop = () => {
    window.clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisibility)
  }
  const fail = () => {
    stop()
    onUnavailable()
  }

  // Timers keep working in hidden tabs where animation frames are suspended.
  // Give a newly visible shader time to receive its ResizeObserver callback.
  document.addEventListener("visibilitychange", onVisibility)
  timer = window.setInterval(() => {
    try {
      const canvas = getCanvas()
      const signature = canvas ? probe(canvas, scratch, minWidth) : null
      if (canvas && signature) {
        stop()
        canvas.toBlob((blob) => {
          if (!active) return
          if (!blob) {
            onUnavailable()
            return
          }
          onCapture(blob, signature)
        }, "image/png")
        return
      }
      const waited = Date.now() - startedAt
      if (waited >= HARD_CAP_MS || (waited >= CONCEDE_MS && !document.hidden)) {
        fail()
      }
    } catch {
      fail()
    }
  }, POLL_MS)

  return () => {
    active = false
    stop()
  }
}
