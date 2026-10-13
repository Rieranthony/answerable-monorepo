import { describe, expect, test } from "bun:test"
import { allowedApiCidrs, parseEnvironment, pathsFor, shown, zoneFor } from "./environments"

describe("environments", () => {
  test("reads --environment", () => {
    expect(parseEnvironment("staging")).toBe("staging")
    expect(parseEnvironment("production")).toBe("production")
    expect(() => parseEnvironment("prod")).toThrow("--environment must be one of staging, production")
    expect(() => parseEnvironment(undefined)).toThrow("--environment must be one of")
  })

  test("knows each environment's zone", () => {
    expect(zoneFor("staging")).toBe("answerable-staging.uk")
    expect(zoneFor("production")).toBe("answerable.org")
  })

  test("places every file under the repository, the key under the home directory, unless told otherwise", () => {
    expect(pathsFor("production", { root: "/repo", home: "/home/me" })).toEqual({
      root: "/repo",
      envDir: "/repo/infra/civo/envs/production",
      secretsFile: "/repo/infra/civo/envs/production/secrets.enc.yaml",
      edgeCa: "/repo/infra/civo/envs/production/edge-ca/ca.pem",
      databaseCa: "/repo/infra/civo/envs/production/database-ca.pem",
      valuesFile: "/repo/charts/answerable/values-civo-production.yaml",
      sopsConfig: "/repo/.sops.yaml",
      keyFile: "/home/me/.config/sops/age/answerable-production.txt",
    })
    const moved = pathsFor("staging", { root: "/repo", home: "/home/me", sopsConfig: "/tmp/s.yaml", keyDir: "/tmp/keys" })
    expect(moved.sopsConfig).toBe("/tmp/s.yaml")
    expect(moved.keyFile).toBe("/tmp/keys/answerable-staging.txt")
  })

  test("reads the operators' addresses, which production cannot do without", () => {
    expect(allowedApiCidrs({}, "staging")).toBeUndefined()
    expect(allowedApiCidrs({ ALLOWED_API_CIDRS: "[]" }, "staging")).toBe("[]")
    expect(allowedApiCidrs({ ALLOWED_API_CIDRS: ' [ "198.51.100.7/32", "2001:db8::/48" ] ' }, "production")).toBe(
      '["198.51.100.7/32","2001:db8::/48"]',
    )
    expect(allowedApiCidrs({ TF_VAR_allowed_api_cidrs: '["198.51.100.7/32"]' }, "production")).toBe('["198.51.100.7/32"]')
    expect(() => allowedApiCidrs({}, "production")).toThrow("ALLOWED_API_CIDRS is not set")
    expect(() => allowedApiCidrs({ ALLOWED_API_CIDRS: "[]" }, "production")).toThrow("ALLOWED_API_CIDRS is empty")
    expect(() => allowedApiCidrs({ ALLOWED_API_CIDRS: "198.51.100.7/32" }, "staging")).toThrow("must be a JSON list of CIDRs")
    expect(() => allowedApiCidrs({ ALLOWED_API_CIDRS: '["me"]' }, "staging")).toThrow("must be a JSON list of CIDRs")
  })

  test("shows paths inside the repository relative to it", () => {
    expect(shown({ root: "/repo" }, "/repo/infra/x")).toBe("infra/x")
    expect(shown({ root: "/repo" }, "/elsewhere/x")).toBe("/elsewhere/x")
    expect(shown({ root: "/repo" }, "/repo")).toBe("/repo")
  })
})
