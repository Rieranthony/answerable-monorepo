// Test-only lifecycle operation against the isolated MCP database.
import assert from "node:assert/strict";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client.ts";
import { organizations } from "../src/db/schema/index.ts";
import { testEnvironment } from "../src/__tests__/support.ts";
import { inPlatformWrite } from "../src/__tests__/platform-context.ts";
import { disableOrganization } from "../src/services/organizations.ts";

const [manifestPath, rawId] = process.argv.slice(2);
if (!manifestPath || !rawId) throw new Error("Use the isolated MCP e2e runner");
const organizationId = z.uuid().parse(rawId);
const manifest = z.object({ tenants: z.array(z.object({ organizationId: z.uuid(), slug: z.enum(["mcp-alpha", "mcp-beta"]) })) }).parse(await Bun.file(manifestPath).json());
const tenant = manifest.tenants.find(tenant => tenant.organizationId === organizationId);
assert.ok(tenant, "Only this run's fixture tenants can be disabled");
const connection = createDatabase(testEnvironment({ databaseUrl: "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test" }));
try {
  const [row] = await connection.db.select().from(organizations).where(eq(organizations.id, organizationId));
  assert.equal(row?.slug, tenant.slug);
  const result = await inPlatformWrite(connection.db, context => disableOrganization(context, organizationId));
  assert.equal(result.organization.status, "disabled");
  console.log(`[e2e] Disabled ${tenant.slug} using the ID lifecycle service`);
} finally {
  await connection.close();
}
