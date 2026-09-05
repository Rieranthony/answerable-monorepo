"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { ImageDithering } from "@paper-design/shaders-react"
import { useTheme } from "next-themes"

import { startMosaicCapture } from "@/lib/mosaic-capture"
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
 * If capture is unavailable, the caller falls back to the original photo.
 */

/** 2x the photo's 576x864 slot in the viewBox, so dots land 1:1 on retina. */
const CAPTURE_W = MOSAIC.photoCols * MOSAIC.cell * 2 // 1152
const CAPTURE_H = MOSAIC.rows * MOSAIC.cell * 2 // 1728

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

interface MosaicDitherProps {
  /** Photo to screen, e.g. "/mosaic/p8.webp". */
  photo: string
  settings: DitherSettings
  /** Receives an object URL for the screened bitmap. */
  onCapture: (url: string) => void
  /** Called when no frame can be produced, so the caller can stop waiting. */
  onUnavailable: () => void
}

export function MosaicDither({
  photo,
  settings,
  onCapture,
  onUnavailable,
}: MosaicDitherProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const previousFrame = useRef<string | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!scratchRef.current) {
      scratchRef.current = document.createElement("canvas")
      scratchRef.current.width = 32
      scratchRef.current.height = 48
    }
    const scratch = scratchRef.current.getContext("2d", {
      willReadFrequently: true,
    })
    if (!scratch) {
      onUnavailable()
      return
    }

    return startMosaicCapture({
      getCanvas: () => hostRef.current?.querySelector("canvas") ?? null,
      scratch,
      previousFrame,
      onCapture: (blob) => onCapture(URL.createObjectURL(blob)),
      onUnavailable,
    })
  }, [photo, settings, onCapture, onUnavailable])

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
