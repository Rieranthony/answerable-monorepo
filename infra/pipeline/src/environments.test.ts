import { describe, expect, test } from "bun:test"
import { UsageError } from "./errors"
import { ENVIRONMENTS, defaultSecretsFile, defaultValuesFile, hostsFor, parseEnvironment } from "./environments"

describe("environments", () => {
  test("accepts exactly the two GitHub environments", () => {
    expect(ENVIRONMENTS).toEqual(["staging", "production"])
    expect(parseEnvironment("staging")).toBe("staging")
    expect(parseEnvironment("production")).toBe("production")
  })

  test("rejects anything else, naming the choices", () => {
    expect(() => parseEnvironment("prod")).toThrow(UsageError)
    expect(() => parseEnvironment(undefined)).toThrow("--environment must be one of staging, production")
  })

  test("derives the three hostnames from the environment's zone", () => {
    expect(hostsFor("staging")).toEqual({
      id: "id.answerable-staging.uk",
      toolbox: "toolbox.answerable-staging.uk",
      admin: "admin-mcp.answerable-staging.uk",
    })
    expect(hostsFor("production")).toEqual({
      id: "id.answerable.org",
      toolbox: "toolbox.answerable.org",
      admin: "admin-mcp.answerable.org",
    })
  })

  test("names the values overlay and the encrypted secrets by convention", () => {
    expect(defaultValuesFile("staging")).toBe("charts/answerable/values-civo-staging.yaml")
    expect(defaultSecretsFile("production")).toBe("infra/civo/envs/production/secrets.enc.yaml")
  })
})
