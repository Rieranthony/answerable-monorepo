import { describe, expect, test } from "bun:test"
import { activeSectionIndex } from "./scroll-panel"

// Measured on /new: the top on the page of each section with a panel.
const PAGE_TOPS = [598, 1046, 1454]
const CONTENT_HEIGHT = 2555

function walk(viewportHeight: number) {
  const maxScroll = CONTENT_HEIGHT - viewportHeight
  const scrollPerSection = new Map<number, number>()
  for (let scrollY = 0; scrollY <= maxScroll; scrollY++) {
    const index = activeSectionIndex({
      tops: PAGE_TOPS.map((top) => top - scrollY),
      scrollY,
      maxScroll,
      viewportHeight,
    })
    scrollPerSection.set(index, (scrollPerSection.get(index) ?? 0) + 1)
  }
  return scrollPerSection
}

describe("unit: scroll panel", () => {
  test("is before the first section at the top of the page", () => {
    expect(
      activeSectionIndex({
        tops: PAGE_TOPS,
        scrollY: 0,
        maxScroll: 1000,
        viewportHeight: 900,
      }),
    ).toBe(-1)
  })
  test("reaches the last section at the bottom of a tall window", () => {
    expect(
      activeSectionIndex({
        tops: PAGE_TOPS.map((top) => top - 1115),
        scrollY: 1115,
        maxScroll: 1115,
        viewportHeight: 1440,
      }),
    ).toBe(2)
  })
  for (const viewportHeight of [720, 900, 1080, 1440]) {
    test(`gives every panel room at a ${viewportHeight}px window`, () => {
      const scroll = walk(viewportHeight)
      expect(scroll.get(-1) ?? 0).toBeGreaterThanOrEqual(30)
      for (const index of [0, 1, 2]) {
        expect(scroll.get(index) ?? 0).toBeGreaterThanOrEqual(150)
      }
    })
  }
  test("treats a page that cannot scroll as at its start", () => {
    expect(
      activeSectionIndex({
        tops: [100, 300],
        scrollY: 0,
        maxScroll: 0,
        viewportHeight: 900,
      }),
    ).toBe(0)
  })
  test("holds still when Safari overscrolls past either end", () => {
    const at = (scrollY: number) =>
      activeSectionIndex({
        tops: [250],
        scrollY,
        maxScroll: 1000,
        viewportHeight: 900,
      })
    expect(at(-50)).toBe(-1)
    expect(at(1050)).toBe(0)
  })
})
