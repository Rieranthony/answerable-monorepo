import { describe, expect, test } from "bun:test"
import {
  GROUP_TOKENS,
  ROLES,
  isColourRole,
  isRole,
  matchKey,
  roleGroup,
} from "./contract"

describe("the contract", () => {
  test("has 43 colour roles, the font roles, shape and spacing", () => {
    expect(ROLES).toHaveLength(50)
    expect(ROLES.filter(isColourRole)).toHaveLength(43)
    expect(GROUP_TOKENS.map((token) => token.name)).toHaveLength(24)
  })

  test("isRole and roleGroup", () => {
    expect(isRole("primary")).toBe(true)
    expect(isRole("control-md")).toBe(false)
    expect(roleGroup("primary")).toBe("Colour roles")
    expect(roleGroup("weight-body")).toBe("Fonts and weights")
    expect(roleGroup("radius-full")).toBe("Shape")
    expect(roleGroup("spacing-unit")).toBe("Spacing")
  })

  test("matchKey takes the first accepted key, * matching a suffix", () => {
    expect(
      matchKey(["separator", "*-separator"], ["interface-separator"]),
    ).toBe("interface-separator")
    expect(
      matchKey(["separator", "*-separator"], ["separator", "x-separator"]),
    ).toBe("separator")
    expect(matchKey(["ease", "easing"], ["easing"])).toBe("easing")
    expect(matchKey(["*-separator"], ["other"])).toBeUndefined()
  })
})
