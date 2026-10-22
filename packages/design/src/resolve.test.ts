import { describe, expect, test } from "bun:test"
import { isTree, locate, referenceOf, resolveTree, valueOf } from "./resolve"

describe("trees", () => {
  test("isTree is true for mappings only", () => {
    expect(isTree({})).toBe(true)
    expect(isTree([])).toBe(false)
    expect(isTree(null)).toBe(false)
    expect(isTree("a")).toBe(false)
  })

  test("referenceOf reads whole references only", () => {
    expect(referenceOf("{colors.primary}")).toBe("colors.primary")
    expect(referenceOf(" {spacing.0.5} ")).toBe("spacing.0.5")
    expect(referenceOf("a {colors.primary}")).toBeUndefined()
    expect(referenceOf(5)).toBeUndefined()
  })

  test("locate walks keys that hold dots", () => {
    const tree = { spacing: { "0.5": "2px", a: { b: 1 } } }
    expect(locate(tree, "spacing.0.5")).toEqual(["spacing", "0.5"])
    expect(locate(tree, "spacing.a.b")).toEqual(["spacing", "a", "b"])
    expect(locate(tree, "spacing.a.c")).toBeUndefined()
    expect(locate(tree, "spacing.0.5.x")).toBeUndefined()
    expect(valueOf(tree, "spacing.0.5")).toBe("2px")
    expect(valueOf(tree, "nope")).toBeUndefined()
  })
})

describe("resolveTree", () => {
  test("resolves whole references through chains and into any group", () => {
    const { resolved, refs, findings } = resolveTree({
      colors: { a: "#000", b: "{colors.a}", c: "{colors.b}" },
      fonts: { sans: { family: "Inter" } },
      roles: { "font-sans": "{fonts.sans}", primary: "{colors.c}" },
      list: ["{colors.a}", 1],
    })
    expect(resolved).toEqual({
      colors: { a: "#000", b: "#000", c: "#000" },
      fonts: { sans: { family: "Inter" } },
      roles: { "font-sans": { family: "Inter" }, primary: "#000" },
      list: ["#000", 1],
    })
    expect(refs).toEqual({
      "colors.b": "colors.a",
      "colors.c": "colors.b",
      "roles.font-sans": "fonts.sans",
      "roles.primary": "colors.c",
      "list.0": "colors.a",
    })
    expect(findings).toEqual([])
  })

  test("resolves references inside longer text to primitives, keeping groups as written", () => {
    const { resolved } = resolveTree({
      colors: { a: "#000" },
      typography: { body: { fontSize: "16px" } },
      components: { input: { focus: "{colors.a} + {typography.body}" } },
    })
    expect(
      (resolved.components as never as { input: { focus: string } }).input
        .focus,
    ).toBe("#000 + {typography.body}")
  })

  test("reports missing and circular references once, keeping the text", () => {
    const { resolved, findings } = resolveTree({
      a: "{b}",
      b: "{a}",
      self: "{self}",
      missing: "{nope.value}",
      text: "x {nope.value} y",
      again: "{missing}",
    })
    expect(resolved.missing).toBe("{nope.value}")
    expect(resolved.text).toBe("x {nope.value} y")
    expect(resolved.again).toBe("{nope.value}")
    expect(findings).toEqual([
      {
        severity: "error",
        path: "a",
        rule: "profile-reference",
        message: "Reference {b} is circular.",
      },
      {
        severity: "error",
        path: "b",
        rule: "profile-reference",
        message: "Reference {a} is circular.",
      },
      {
        severity: "error",
        path: "self",
        rule: "profile-reference",
        message: "Reference {self} is circular.",
      },
      {
        severity: "error",
        path: "missing",
        rule: "profile-reference",
        message:
          "Reference {nope.value} does not resolve to any value in the file.",
      },
      {
        severity: "warning",
        path: "text",
        rule: "profile-reference",
        message:
          "Reference {nope.value} in this text does not resolve to any value in the file.",
      },
    ])
  })
})
