// bun run env:inventory writes default.env, .env.example and packages/config/inventory.json from every service's definition
// (packages/config/README.md), so that none of the three is written by hand. env-inventory.test.ts fails when a committed copy differs.
import type { FieldMeta } from "@answerable/config"
import { idConfig } from "../apps/id/src/config"
import { idMigrationConfig } from "../apps/id/scripts/env"
import { idTestDatabaseConfig } from "../apps/id/src/__tests__/test-database"
import { opsConfig } from "../infra/ops/src/commands"
import { adminConfig } from "../mcps/admin/src/environment"
import { adminMigrationConfig } from "../mcps/admin/scripts/env"
import { adminTestDatabaseConfig } from "../mcps/admin/src/test/database"
import { toolboxConfig } from "../mcps/toolbox/src/environment"
import { toolboxMigrationConfig } from "../mcps/toolbox/scripts/env"
import { toolboxTestDatabaseConfig } from "../mcps/toolbox/src/test/database"
import { mcpConfig } from "../packages/mcp/src/environment"
import { mcpPostgresTestConfig } from "../packages/mcp-postgres/src/testing"
import { mcpCliConfig } from "./mcp/config"

type Group = { name: string; reader: string; fields: FieldMeta[] }

const defined = ({ label, fields }: { label: string; fields: FieldMeta[] }, reader: string): Group => ({ name: label, reader, fields })
// A variable no definition reads: the web app's, the workflows' and the infrastructure tooling's.
const variable = (name: string, doc: string, { secret = false, optional = true } = {}): FieldMeta => ({ name, secret, doc, optional })

const groups: Group[] = [
  defined(idConfig, "apps/id/src/config.ts, read from the root .env by bun dev"),
  defined(idMigrationConfig, "apps/id/scripts/env.ts, read by scripts/migrate.ts"),
  defined(idTestDatabaseConfig, "apps/id/src/__tests__/test-database.ts, for ID's tests"),
  defined(toolboxConfig, "mcps/toolbox/src/environment.ts, read from the root .env by bun run toolbox:dev"),
  defined(toolboxMigrationConfig, "mcps/toolbox/scripts/env.ts, read by scripts/migrate.ts"),
  defined(toolboxTestDatabaseConfig, "mcps/toolbox/src/test/database.ts, for the Toolbox's tests"),
  defined(adminConfig, "mcps/admin/src/environment.ts, read from the root .env by bun run admin:dev"),
  defined(adminMigrationConfig, "mcps/admin/scripts/env.ts, read by scripts/migrate.ts"),
  defined(adminTestDatabaseConfig, "mcps/admin/src/test/database.ts, for the admin MCP's tests"),
  defined(mcpConfig, "packages/mcp/src/environment.ts, read by readMcpEnvironment for the e2e server (bun run mcp:dev)"),
  defined(opsConfig, "infra/ops/src/commands.ts, set by charts/answerable for the bootstrap, register and make-admin Jobs (infra/ops/README.md)"),
  defined(mcpPostgresTestConfig, "packages/mcp-postgres/src/testing.ts, for the package's own tests and every MCP's (testMcpDatabase)"),
  defined(mcpCliConfig, "scripts/mcp/config.ts, read by bun mcp db migrate and bun mcp new"),
  {
    name: "web",
    reader: "apps/web, read from apps/web/.env.local by Next.js (apps/web/.env.example)",
    fields: [
      variable("GOOGLE_SHEETS_ID", "The waitlist's spreadsheet ID; locally, without it and the two below, a sign-up is logged instead; production needs all three"),
      variable("GOOGLE_SERVICE_ACCOUNT_EMAIL", "The service account that writes the waitlist's sheet"),
      variable("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "The service account's private key, on one line with \\n kept", { secret: true }),
      variable("OAUTH_TEST_ISSUER", "The /oauth-test consumer's Answerable ID, in development only"),
      variable("OAUTH_TEST_CLIENT_ID", "The /oauth-test consumer's client in ID"),
      variable("OAUTH_TEST_CLIENT_SECRET", "The /oauth-test consumer's client secret", { secret: true }),
      variable("OAUTH_TEST_REDIRECT_URI", "The /oauth-test consumer's callback, http://localhost:47100/api/oauth-test/callback"),
    ],
  },
  {
    name: "GitHub environment",
    reader: "read by the workflows, never from a .env file (infra/README.md)",
    fields: [
      variable("CIVO_TOKEN", "The environment's Civo account API key; the owner pastes it", { secret: true, optional: false }),
      variable("CLOUDFLARE_API_TOKEN", "A Cloudflare token scoped to the environment's zone only; the owner pastes it", { secret: true, optional: false }),
      variable("GH_SECRETS_TOKEN", "A token that writes this environment's secrets, for the bootstrap workflow and Terraform; the owner pastes it", { secret: true, optional: false }),
      variable("STATE_ACCESS_KEY_ID", "The Terraform state's object store key ID; the bootstrap workflow writes it", { optional: false }),
      variable("STATE_SECRET_ACCESS_KEY", "The Terraform state's object store secret; the bootstrap workflow writes it", { secret: true, optional: false }),
      variable("KUBE_SERVER", "The cluster's API server, for the deploy step; Terraform writes it", { optional: false }),
      variable("KUBE_CA", "The cluster's certificate authority, for the deploy step; Terraform writes it", { optional: false }),
      variable("KUBE_TOKEN", "The deployer's token, for the deploy step; Terraform writes it", { secret: true, optional: false }),
    ],
  },
  {
    name: "infra tooling",
    reader: "read by bun run infra:test and bun run infra:check",
    fields: [
      variable("INFRA_STACK_KEEP", "1 keeps the kind stack's cluster after bun run infra:test"),
      variable("TF_PLUGIN_CACHE_DIR", "Moves infra:check's Terraform provider cache"),
    ],
  },
]

// What a developer supplies because another system issues it: the platform applications and the machine clients the local ID registers.
const issuedElsewhere = [
  "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOOLBOX_ID_CLIENT_ID", "TOOLBOX_ID_CLIENT_SECRET",
  "ADMIN_ID_CLIENT_ID", "ADMIN_ID_CLIENT_SECRET", "MCP_ID_CLIENT_ID", "MCP_ID_CLIENT_SECRET",
]

const lines = (fields: FieldMeta[]) => fields.flatMap(({ name, doc }) => [`# ${doc}`, `${name}=`])

/** The three files, by path from the repository root, as this script writes them. */
export function inventory(): Record<string, string> {
  const written = new Set<string>()
  const sections = groups.map(group => {
    // A variable two groups read, NODE_ENV for one, is written once, under the first.
    const fields = group.fields.filter(({ name }) => !written.has(name))
    for (const { name } of fields) written.add(name)
    return [`# ${group.name}: ${group.reader}`, ...lines(fields)].join("\n")
  })
  const credentials = groups.flatMap(group => {
    const fields = group.fields.filter(({ name }) => issuedElsewhere.includes(name))
    return fields.length ? [[`# ${group.name}`, ...lines(fields)].join("\n")] : []
  })
  return {
    "default.env": `${[
      [
        "# Every environment variable in the monorepo, with empty values. Tracked in git: never write real values here.",
        "# Generated by bun run env:inventory from each service's definition (packages/config/README.md): change the definition, then run it.",
        "# Locally, only the credentials in .env.example have no default: copy it to .env, and apps/web/.env.example to apps/web/.env.local.",
        "# A line in .env overrides a default. Most variables refuse an empty value, so copy only the lines you fill in.",
        "# What ID's mean in production: docs/06-deploying-answerable-id.md.",
      ].join("\n"),
      ...sections,
    ].join("\n\n")}\n`,
    ".env.example": `${[
      [
        "# Credentials another system issues, for local use: copy this file to .env (git-ignored) and fill in the ones you need.",
        "# Every other variable has a development default in code; default.env lists them all, and a line in .env overrides any.",
        "# Generated by bun run env:inventory.",
        "# Real Microsoft or Google sign-in also needs their origins in BETTER_AUTH_TRUSTED_ORIGINS, and outbound HTTPS to them:",
        "# Microsoft: https://login.microsoftonline.com,https://graph.microsoft.com",
        "# Google: https://accounts.google.com,https://oauth2.googleapis.com,https://www.googleapis.com,https://openidconnect.googleapis.com",
        "# Their callback for local sign-in is http://localhost:47300/auth/sso/callback.",
      ].join("\n"),
      ...credentials,
    ].join("\n\n")}\n`,
    "packages/config/inventory.json": `${JSON.stringify(groups, null, 2)}\n`,
  }
}

// Run as a script, it writes them; each line is one statement, so the suite's coverage gate holds without running it.
if (import.meta.main) for (const [path, text] of Object.entries(inventory())) await Bun.write(new URL(`../${path}`, import.meta.url), text)
if (import.meta.main) console.log("Wrote default.env, .env.example and packages/config/inventory.json")
