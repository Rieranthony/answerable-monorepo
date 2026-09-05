import { afterEach, beforeEach, expect, test } from "bun:test"

import { startMosaicCapture } from "./mosaic-capture"

let tick: (() => void) | undefined
let visibility: (() => void) | undefined
let complete: BlobCallback | undefined
let hidden = false
let now = 0
let tone = 1
let captures: string[]
let unavailable: number
let previousFrame: { current: string | null }
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const originalNow = Date.now

beforeEach(() => {
  tick = visibility = complete = undefined
  hidden = false
  now = 0
  tone = 1
  captures = []
  unavailable = 0
  previousFrame = { current: null }
  Date.now = () => now
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: (callback: () => void) => {
        tick = callback
        return 1
      },
      clearInterval: () => {
        tick = undefined
      },
    },
  })
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get hidden() {
        return hidden
      },
      addEventListener: (_event: string, callback: () => void) => {
        visibility = callback
      },
      removeEventListener: (_event: string, callback: () => void) => {
        if (visibility === callback) visibility = undefined
      },
    },
  })
})

afterEach(() => {
  Date.now = originalNow
  for (const [key, descriptor] of [
    ["window", originalWindow],
    ["document", originalDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

function start(hasCanvas = true) {
  const canvas = {
    width: 1152,
    height: 1728,
    toBlob: (callback: BlobCallback) => {
      complete = callback
    },
  } as HTMLCanvasElement
  const scratch = {
    canvas: { width: 32, height: 48 },
    drawImage() {},
    getImageData: () => ({
      data: new Uint8ClampedArray([0, 0, 0, 255, tone, 0, 0, 255]),
    }),
  } as unknown as CanvasRenderingContext2D
  return startMosaicCapture({
    getCanvas: () => (hasCanvas ? canvas : null),
    scratch,
    previousFrame,
    onCapture: (_blob, signature) => captures.push(signature),
    onUnavailable: () => {
      unavailable++
    },
  })
}

test("capture stops polling and visibility work, including after the tab returns", () => {
  const cleanup = start()
  tick!()
  expect(tick).toBeUndefined()
  expect(visibility).toBeUndefined()
  complete!(new Blob(["frame"]))
  expect(captures).toHaveLength(1)
  cleanup()
})

test("a replaced capture ignores its late blob and accepts the newer frame", () => {
  const cleanup = start()
  tick!()
  const stale = complete!
  cleanup()
  tone = 2
  const cleanupNext = start()
  tick!()
  complete!(new Blob(["new"]))
  stale(new Blob(["old"]))
  expect(captures).toEqual(["2"])
  cleanupNext()
})

test("unmount during blob encoding does not deliver an object URL", () => {
  const cleanup = start()
  tick!()
  cleanup()
  complete!(new Blob(["frame"]))
  expect(captures).toEqual([])
})

test("a null blob falls back instead of leaving the mosaic pending", () => {
  start()
  tick!()
  complete!(null)
  expect(unavailable).toBe(1)
  expect(tick).toBeUndefined()
  expect(visibility).toBeUndefined()
})

test("unavailable WebGL falls back after the visible budget and cleans up", () => {
  start(false)
  now = 6000
  tick!()
  expect(unavailable).toBe(1)
  expect(visibility).toBeUndefined()
  expect(tick).toBeUndefined()
})

test("a hidden page gets a fresh visible budget, with a hard cap while hidden", () => {
  hidden = true
  const cleanup = start(false)
  now = 6000
  tick!()
  expect(unavailable).toBe(0)
  hidden = false
  visibility!()
  now = 6100
  tick!()
  expect(unavailable).toBe(0)
  cleanup()
  hidden = true
  start(false)
  now += 20000
  tick!()
  expect(unavailable).toBe(1)
})

test("settings changes wait for a frame different from the previous capture", () => {
  const cleanup = start()
  tick!()
  complete!(new Blob(["frame"]))
  cleanup()
  const cleanupNext = start()
  tick!()
  expect(tick).toBeDefined()
  tone = 2
  tick!()
  complete!(new Blob(["frame"]))
  expect(captures).toEqual(["1", "2"])
  cleanupNext()
})
