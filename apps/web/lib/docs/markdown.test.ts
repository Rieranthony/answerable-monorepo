import { expect, test } from "bun:test"

import { errorRows } from "./error-codes"
import {
  codeFence,
  markdownTable,
  numberSteps,
  typeTableHeaders,
  typeTableRows,
} from "./markdown"

const field = {
  name: "risk",
  description: "How much harm it can do.\nSets the default policy class.",
  type: '"low" | "normal" | "high" | undefined',
  simplifiedType: "union",
  required: false,
}

test("a type table escapes pipes, joins lines and marks optional fields", () => {
  expect(markdownTable(typeTableHeaders, typeTableRows([field]))).toBe(
    [
      "| Field | Type | Description |",
      "| --- | --- | --- |",
      '| `risk?` | `"low" \\| "normal" \\| "high"` | How much harm it can do. Sets the default policy class. |',
    ].join("\n"),
  )
})

test("a long type falls back to its simplified form", () => {
  const long = {
    ...field,
    required: true,
    type: `{ ${"a: string; ".repeat(8)}}`,
  }

  expect(markdownTable(typeTableHeaders, typeTableRows([long]))).toContain(
    "| `risk` | `union` |",
  )
})

test("a code fence carries its title and outgrows a fence inside the code", () => {
  expect(codeFence("a\n", "ts", "src/a.ts")).toBe(
    '```ts title="src/a.ts"\na\n```',
  )
  expect(codeFence("```sh\nx\n```", "md")).toBe("````md\n```sh\nx\n```\n````")
})

test("steps are numbered in order, as the page numbers them", () => {
  expect(numberSteps("### Scaffold\n\nRun it.\n\n### Test\n\nCheck it.")).toBe(
    "### 1. Scaffold\n\nRun it.\n\n### 2. Test\n\nCheck it.",
  )
})

test("a table has one row per entry", () => {
  expect(markdownTable(["A"], [["1"], ["2"]]).split("\n")).toHaveLength(4)
})

test("every standard error code has a meaning, an action and the SDK's retry policy", () => {
  expect(errorRows.length).toBeGreaterThan(20)
  for (const row of errorRows) {
    expect(row.meaning.length, row.code).toBeGreaterThan(10)
    expect(row.action.length, row.code).toBeGreaterThan(5)
    expect(row.retry, row.code).toMatch(/^(never|after_[a-z_]+)$/)
  }
  expect(errorRows.find((row) => row.code === "INTENT_STALE")?.retry).toBe(
    "after_reprepare",
  )
})
