import { expect, test } from "bun:test"
import { z } from "zod"
import { ConfigError, defineConfig } from "./index"

const config = defineConfig("Acme", {
  ACME_URL: { schema: z.url(), local: "http://localhost:47600", doc: "Where Acme is", source: "chart" },
  ACME_SECRET: { schema: z.string().min(8), secret: true, local: "development-secret", doc: "Acme's secret", source: "deploy" },
  ACME_PORT: { schema: z.coerce.number().int().min(1), fallback: "47600", doc: "The port", source: "image" },
  ACME_NOTE: { schema: z.string().optional(), doc: "A note" },
  ACME_TOKEN: { schema: z.string().optional(), secret: true, doc: "An optional credential, without a local value" },
})

test("development and test fill unset variables with their local values, then the fallback; an empty or blank variable is unset", () => {
  const local = { ACME_URL: "http://localhost:47600", ACME_SECRET: "development-secret", ACME_PORT: 47600, ACME_NOTE: undefined, ACME_TOKEN: undefined }
  expect(config.read({})).toEqual({ NODE_ENV: "development", ...local })
  expect(config.read({ NODE_ENV: "test", ACME_URL: "", ACME_SECRET: " ", ACME_PORT: "", ACME_NOTE: "\t", ACME_TOKEN: "" })).toEqual({ NODE_ENV: "test", ...local })
  expect(config.read({ ACME_URL: "https://acme.example", ACME_SECRET: "a-secret-of-mine", ACME_PORT: "1", ACME_NOTE: "a note" })).toEqual({
    NODE_ENV: "development", ACME_URL: "https://acme.example", ACME_SECRET: "a-secret-of-mine", ACME_PORT: 1, ACME_NOTE: "a note", ACME_TOKEN: undefined,
  })
})

test("production applies no local value, keeps the fallback, counts an empty or blank variable as unset and names every variable it refuses", () => {
  const production = { NODE_ENV: "production", ACME_URL: "https://acme.example", ACME_SECRET: "a-secret-of-mine" }
  expect(config.read(production)).toMatchObject({ NODE_ENV: "production", ACME_PORT: 47600, ACME_TOKEN: undefined })
  expect(config.read({ ...production, ACME_PORT: "", ACME_TOKEN: "  " })).toMatchObject({ ACME_PORT: 47600, ACME_TOKEN: undefined })
  expect(() => config.read({ NODE_ENV: "production" })).toThrow(/^Invalid Acme configuration: ACME_URL: .+; ACME_SECRET: .+$/)
  expect(() => config.read({ ...production, ACME_URL: "" })).toThrow("ACME_URL")
})

test("production refuses a secret whose value is its local one, and only a secret", () => {
  expect(() => config.read({ NODE_ENV: "production", ACME_URL: "https://acme.example", ACME_SECRET: "development-secret" })).toThrow("Invalid Acme configuration: ACME_SECRET: a development default")
  expect(config.read({ NODE_ENV: "production", ACME_URL: "http://localhost:47600", ACME_SECRET: "a-secret-of-mine" }).ACME_URL).toBe("http://localhost:47600")
})

test("an unknown NODE_ENV is refused and fills nothing", () => {
  for (const NODE_ENV of ["staging", ""]) {
    const error = (() => {
      try {
        config.read({ NODE_ENV })
      } catch (error) {
        return error as ConfigError
      }
    })()
    expect(error).toBeInstanceOf(ConfigError)
    expect(error?.issues.map(issue => issue.name)).toEqual(["NODE_ENV", "ACME_URL", "ACME_SECRET"])
    expect(error?.message).toStartWith('Invalid Acme configuration: NODE_ENV: Invalid option: expected one of "development"|"test"|"production"; ACME_URL: ')
  }
})

test("refine runs once every variable parses, and names the variables it refuses", () => {
  const paired = defineConfig("Pair", { A: { schema: z.string().optional(), doc: "A" }, B: { schema: z.string().min(2).optional(), doc: "B" } }, {
    refine(data, issue) {
      if (!data.A !== !data.B) issue(data.A ? "B" : "A", "Required together")
    },
  })
  expect(paired.read({ A: "a", B: "bb" })).toEqual({ NODE_ENV: "development", A: "a", B: "bb" })
  expect(() => paired.read({ A: "a" })).toThrow("Invalid Pair configuration: B: Required together")
  expect(() => paired.read({ B: "bb" })).toThrow("Invalid Pair configuration: A: Required together")
  expect(() => paired.read({ B: "b" })).toThrow(/^Invalid Pair configuration: B: [^;]+$/)
})

test("fields describe every variable, NODE_ENV first, with whether production may leave it unset", () => {
  expect(config.label).toBe("Acme")
  expect(config.fields).toEqual([
    { name: "NODE_ENV", secret: false, fallback: "development", doc: expect.any(String), source: "image", optional: true },
    { name: "ACME_URL", secret: false, local: "http://localhost:47600", doc: "Where Acme is", source: "chart", optional: false },
    { name: "ACME_SECRET", secret: true, local: "development-secret", doc: "Acme's secret", source: "deploy", optional: false },
    { name: "ACME_PORT", secret: false, fallback: "47600", doc: "The port", source: "image", optional: true },
    { name: "ACME_NOTE", secret: false, doc: "A note", optional: true },
    { name: "ACME_TOKEN", secret: true, doc: "An optional credential, without a local value", optional: true },
  ])
})
