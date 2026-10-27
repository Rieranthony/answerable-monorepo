import { expect, test } from "bun:test"
import { defineConfig } from "@answerable/config"
import { z } from "zod"
import { parseEnvironment } from "./index"

const config = defineConfig("Acme", {
  ACME_ID_ISSUER: { schema: z.url(), local: "http://localhost:47300", doc: "The ID issuer" },
  ACME_RESOURCE_URL: { schema: z.url(), local: "http://localhost:47510/acme/mcp", doc: "This server's URL" },
  ACME_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47510", doc: "The port" },
})
const names = { issuer: "ACME_ID_ISSUER", resource: "ACME_RESOURCE_URL" } as const

test("parses a server's own variables and gives createMcpServer's auth, with loopback HTTP allowed", () => {
  const env = { ACME_ID_ISSUER: "http://127.0.0.1:47300", ACME_RESOURCE_URL: "http://127.0.0.1:47510/acme/mcp", ACME_PORT: "65535" }
  expect(parseEnvironment(config, env, names)).toEqual({
    data: { NODE_ENV: "development", ...env, ACME_PORT: 65535 },
    auth: { issuer: env.ACME_ID_ISSUER, resource: env.ACME_RESOURCE_URL },
  })
  expect(parseEnvironment(config, { NODE_ENV: "test" }, names).auth).toEqual({ issuer: "http://localhost:47300", resource: "http://localhost:47510/acme/mcp" })
})

test("names each variable that is missing or invalid, the issuer and the resource as the verifier checks them", () => {
  expect(() => parseEnvironment(config, { NODE_ENV: "production" }, names)).toThrow("Invalid Acme configuration: ACME_ID_ISSUER:")
  expect(() => parseEnvironment(config, { NODE_ENV: "production" }, names)).toThrow("ACME_RESOURCE_URL")
  expect(() => parseEnvironment(config, { ACME_ID_ISSUER: "http://evil.test" }, names)).toThrow("Invalid Acme configuration: ACME_ID_ISSUER:")
  expect(() => parseEnvironment(config, { ACME_RESOURCE_URL: "https://mcp.test#fragment" }, names)).toThrow("Invalid Acme configuration: ACME_RESOURCE_URL:")
})
