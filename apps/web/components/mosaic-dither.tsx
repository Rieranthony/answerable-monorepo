"use client"

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { ImageDithering } from "@paper-design/shaders-react"
import { useTheme } from "next-themes"

import { MOSAIC, MOSAIC_DITHER, type DitherSettings } from "@/lib/mosaic-layout"

/**
 * Screens the mosaic photo through the Paper Design dithering shader.
 *
 * The shader renders OFF-SCREEN and we capture a single frame, then hand the
 * bitmap to the existing <image> in the mosaic SVG. Keeping the result inside
 * the SVG is the whole point: the tile clip windows, the comma rotations, the
 * `xMaxYMid slice` crop and the staggered entrance all keep working untouched,
 * and no canvas has to be aligned against SVG user space by hand.
 *
 * Until the capture lands (and forever, without WebGL) the caller falls back
 * to the undithered photo, so the mosaic is never blank.
 */

/** 2x the photo's 576x864 slot in the viewBox, so dots land 1:1 on retina. */
const CAPTURE_W = MOSAIC.photoCols * MOSAIC.cell * 2 // 1152
const CAPTURE_H = MOSAIC.rows * MOSAIC.cell * 2 // 1728

/**
 * Poll interval and budget for spotting the shader's frame. A timer rather
 * than requestAnimationFrame on purpose: rAF is suspended while the document
 * is hidden (background tab, or a preview pane that is not on screen), which
 * would leave the capture permanently pending.
 */
const POLL_MS = 100
const POLL_ATTEMPTS = 60

const emptySubscribe = () => () => {}

/** next-themes resolves to `undefined` on the first client render. */
function useResolvedScheme(): "light" | "dark" {
  const { resolvedTheme } = useTheme()
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )
  return mounted && resolvedTheme === "dark" ? "dark" : "light"
}

/**
 * Resolves the active scheme and the settings that go with it. `override`
 * takes the whole record (not one scheme's settings) so the caller does not
 * need to know the scheme before calling — that is what this returns.
 */
export function useDitherSettings(
  override?: Record<"light" | "dark", DitherSettings>,
) {
  const scheme = useResolvedScheme()
  return { scheme, settings: (override ?? MOSAIC_DITHER)[scheme] }
}

/**
 * Cheap fingerprint of what the canvas is currently showing, or null while it
 * is still a flat buffer (i.e. nothing drawn yet).
 *
 * Polling this beats waiting a fixed number of frames: shader compilation and
 * texture upload finish on their own schedule, and after a photo or settings
 * change the canvas keeps showing the PREVIOUS frame for a while — comparing
 * fingerprints is what stops us capturing that stale image.
 */
function probe(canvas: HTMLCanvasElement): string | null {
  // The mount creates its canvas before sizing it; drawing from a zero-sized
  // source throws InvalidStateError.
  if (!canvas.width || !canvas.height) return null
  const scratch = document.createElement("canvas")
  scratch.width = 32
  scratch.height = 48
  const ctx = scratch.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height)
  const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height)

  let uniform = true
  let hash = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== data[0]) uniform = false
    hash = (hash * 31 + data[i]) | 0
  }
  return uniform ? null : String(hash)
}

interface MosaicDitherProps {
  /** Photo to screen, e.g. "/mosaic/p7.webp". */
  photo: string
  settings: DitherSettings
  /** Receives an object URL for the screened bitmap. */
  onCapture: (url: string) => void
}

export function MosaicDither({
  photo,
  settings,
  onCapture,
}: MosaicDitherProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const lastCaptured = useRef<string | null>(null)

  const capture = useCallback(
    (signature: string) => {
      const canvas = hostRef.current?.querySelector("canvas")
      if (!canvas) return
      canvas.toBlob((blob) => {
        // PNG, never lossy: lossy encoding smears dither dots back into grey.
        if (!blob) return
        lastCaptured.current = signature
        onCapture(URL.createObjectURL(blob))
      }, "image/png")
    },
    [onCapture],
  )

  // Poll until the canvas shows something new, then capture it once.
  // `preserveDrawingBuffer` (below) is what keeps those pixels readable.
  useEffect(() => {
    let timer = 0
    const stop = () => {
      if (timer) window.clearInterval(timer)
      timer = 0
    }
    const start = () => {
      stop()
      let attempts = 0
      timer = window.setInterval(() => {
        const canvas = hostRef.current?.querySelector("canvas")
        const signature = canvas ? probe(canvas) : null
        if (signature && signature !== lastCaptured.current) {
          stop()
          capture(signature)
          return
        }
        if (++attempts >= POLL_ATTEMPTS) stop()
      }, POLL_MS)
    }

    start()

    // A hidden document does not run the rendering steps that deliver the
    // shader's ResizeObserver callbacks, so its canvas stays 0x0 and never
    // draws — a page opened in a background tab would otherwise be stuck on
    // the fallback for good. Re-arm the poll when the page comes into view.
    const onVisibility = () => {
      if (!document.hidden) start()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [photo, settings, capture])

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      // Must stay INSIDE the viewport: the shader mount gates rendering on
      // intersection, so parking this off-screen (or display:none) means no
      // frame is ever drawn. Hidden by opacity, stacked behind the opaque
      // page instead.
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: CAPTURE_W,
        height: CAPTURE_H,
        opacity: 0,
        zIndex: -1,
        pointerEvents: "none",
      }}
    >
      <ImageDithering
        // A URL, deliberately NOT an HTMLImageElement: the library awaits
        // `image.decode()` for element uniforms, and that promise never
        // settles in some browsers, leaving the canvas uncreated. The string
        // path loads via `img.onload`, which is dependable. Same-origin, so
        // the canvas stays untainted and toBlob() works.
        image={photo}
        type={settings.type}
        size={settings.size}
        colorSteps={settings.colorSteps}
        inverted={settings.inverted}
        colorFront={settings.colorFront}
        colorBack={settings.colorBack}
        colorHighlight={settings.colorHighlight}
        fit="cover"
        speed={0}
        frame={0}
        width={CAPTURE_W}
        height={CAPTURE_H}
        minPixelRatio={1}
        maxPixelCount={CAPTURE_W * CAPTURE_H}
        webGlContextAttributes={{ preserveDrawingBuffer: true }}
      />
    </div>
  )
}
