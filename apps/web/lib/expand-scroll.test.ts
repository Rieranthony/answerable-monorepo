import { describe, expect, test } from "bun:test"

import { scrollTargetForOpeningHeader } from "./expand-scroll"

describe("scrollTargetForOpeningHeader", () => {
  test("leaves the page alone when nothing above collapses", () => {
    expect(
      scrollTargetForOpeningHeader({
        headerTop: 300,
        collapsingHeightAbove: 0,
        scrollY: 1000,
        margin: 16,
      }),
    ).toBeNull()
  })

  test("leaves the page alone when the header stays on screen", () => {
    expect(
      scrollTargetForOpeningHeader({
        headerTop: 300,
        collapsingHeightAbove: 284,
        scrollY: 1000,
        margin: 16,
      }),
    ).toBeNull()
  })

  test("scrolls so the header lands at the margin when it would leave", () => {
    expect(
      scrollTargetForOpeningHeader({
        headerTop: 300,
        collapsingHeightAbove: 500,
        scrollY: 1000,
        margin: 16,
      }),
    ).toBe(784)
  })

  test("nudges a header already above the margin down to it", () => {
    expect(
      scrollTargetForOpeningHeader({
        headerTop: 4,
        collapsingHeightAbove: 0,
        scrollY: 1000,
        margin: 16,
      }),
    ).toBe(988)
  })

  test("never asks for a negative scroll position", () => {
    expect(
      scrollTargetForOpeningHeader({
        headerTop: 100,
        collapsingHeightAbove: 400,
        scrollY: 50,
        margin: 16,
      }),
    ).toBe(0)
  })
})
