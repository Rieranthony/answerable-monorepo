import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { openRuntimeRole } from "../__tests__/runtime-role.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import type { DatabaseConnection, Executor } from "./client.ts";
import { assertRuntimeRole } from "./runtime-role.ts";
import { withDatabaseScope } from "./isolation.ts";
import {
  magicLinkRequests,
  organizations,
  ssoProviders,
} from "./schema/index.ts";

let roles: Awaited<ReturnType<typeof openRuntimeRole>>;
let owner: DatabaseConnection;
let runtime: DatabaseConnection;
let one: { id: string; providerId: string };
let two: { id: string; providerId: string };
let row: typeof magicLinkRequests.$inferInsert;

async function firm(slug: string) {
  const id = createId();
  await owner.db.insert(organizations).values({ id, slug, name: slug });
  const [provider] = await owner.db
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.organizationId, id),
        eq(ssoProviders.kind, "magic_link"),
      ),
    );
  return { id, providerId: provider!.id };
}

const request = (
  of: { id: string; providerId: string },
  fields: Partial<typeof magicLinkRequests.$inferInsert> = {},
): typeof magicLinkRequests.$inferInsert => ({
  id: createId(),
  organizationId: of.id,
  providerId: of.providerId,
  providerRevision: 1,
  purpose: "access_removed",
  email: "person@firm.example.com",
  clientHash: "client",
  expiresAt: new Date(Date.now() + 600_000),
  ...fields,
});

const link = {
  purpose: "link",
  tokenIdentifier: "magic-link:token",
  browserHash: "browser",
  codeHmac: "code",
} as const;

beforeAll(async () => {
  roles = await openRuntimeRole(testEnvironment());
  ({ owner, runtime } = roles);
  one = await firm("rls-one");
  two = await firm("rls-two");
  row = request(one);
  await owner.db
    .insert(magicLinkRequests)
    .values([row, request(two, { id: createId() })]);
});
afterAll(() => roles?.close());

const visible = (tx: Executor) =>
  tx
    .select({ organizationId: magicLinkRequests.organizationId })
    .from(magicLinkRequests);

describe("row-level security on the real runtime login", () => {
  test("startup's check requires it", async () => {
    await assertRuntimeRole(runtime.db);
    await owner.db.execute(
      sql`alter table magic_link_requests disable row level security`,
    );
    try {
      await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
        "Unsafe database runtime role",
      );
    } finally {
      await owner.db.execute(
        sql`alter table magic_link_requests enable row level security`,
      );
    }
  });

  test("with no scope it holds no rows, and writes nothing", async () => {
    expect(await visible(runtime.db)).toEqual([]);
    await expect(
      runtime.db.insert(magicLinkRequests).values(request(one)).execute(),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    const update = await runtime.db
      .update(magicLinkRequests)
      .set({ attempts: 1 });
    expect(update.rowCount).toBe(0);
    const removed = await runtime.db.delete(magicLinkRequests);
    expect(removed.rowCount).toBe(0);
  });

  test("protocol scope reads and writes every firm's rows", async () => {
    await withDatabaseScope(runtime.db, { kind: "protocol" }, async (tx) => {
      expect(await visible(tx)).toHaveLength(2);
      const added = request(two);
      await tx.insert(magicLinkRequests).values(added);
      const update = await tx
        .update(magicLinkRequests)
        .set({ attempts: 1 })
        .where(eq(magicLinkRequests.id, added.id));
      expect(update.rowCount).toBe(1);
      const removed = await tx
        .delete(magicLinkRequests)
        .where(eq(magicLinkRequests.id, added.id));
      expect(removed.rowCount).toBe(1);
    });
  });

  test.each([["read"], ["write"]] as const)(
    "the platform's %s scope reads for diagnosis and writes nothing",
    async (access) => {
      await withDatabaseScope(
        runtime.db,
        { kind: "platform", access },
        async (tx) => {
          expect(await visible(tx)).toHaveLength(2);
          const update = await tx
            .update(magicLinkRequests)
            .set({ attempts: 1 });
          expect(update.rowCount).toBe(0);
        },
      );
      await expect(
        withDatabaseScope(runtime.db, { kind: "platform", access }, (tx) =>
          tx.insert(magicLinkRequests).values(request(one)).execute(),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    },
  );

  test.each([["read"], ["write"]] as const)(
    "a tenant's %s scope reads its own firm's rows only, and writes nothing",
    async (access) => {
      await withDatabaseScope(
        runtime.db,
        { kind: "tenant", access, organizationId: one.id },
        async (tx) => {
          expect(await visible(tx)).toEqual([{ organizationId: one.id }]);
          const removed = await tx.delete(magicLinkRequests);
          expect(removed.rowCount).toBe(0);
        },
      );
    },
  );

  test("a person's and a client's scopes see nothing", async () => {
    for (const scope of [
      { kind: "policy-user", userId: createId() },
      { kind: "grant-client", clientId: "client" },
    ] as const)
      await withDatabaseScope(runtime.db, scope, async (tx) => {
        expect(await visible(tx)).toEqual([]);
      });
  });

  test("the grants: the runtime role deletes these rows, which the sweep needs, and cannot truncate them", async () => {
    const { rows } = await runtime.pool.query<{
      del: boolean;
      trunc: boolean;
    }>(
      `select has_table_privilege(current_user, 'magic_link_requests', 'DELETE') as del,
              has_table_privilege(current_user, 'magic_link_requests', 'TRUNCATE') as trunc`,
    );
    expect(rows).toEqual([{ del: true, trunc: false }]);
  });
});

describe("the constraints", () => {
  const refused = (
    fields: Partial<typeof magicLinkRequests.$inferInsert>,
    constraint: string,
  ) =>
    expect(
      owner.db.insert(magicLinkRequests).values(request(one, fields)).execute(),
    ).rejects.toMatchObject({ cause: { constraint } });

  test("a link has its token, its browser and its code", async () => {
    const check = "magic_link_requests_purpose_fields_check";
    await refused({ ...link, tokenIdentifier: null }, check);
    await refused({ ...link, browserHash: null }, check);
    await refused({ ...link, codeHmac: null }, check);
    await owner.db.insert(magicLinkRequests).values(request(one, link));
  });

  test("word that access was removed has no token, browser, code or query to resume", async () => {
    const check = "magic_link_requests_purpose_fields_check";
    await refused({ tokenIdentifier: "magic-link:x" }, check);
    await refused({ browserHash: "x" }, check);
    await refused({ codeHmac: "x" }, check);
    await refused({ pendingOauthQuery: "x" }, check);
  });

  test("two rows cannot name one token, and any number name none", async () => {
    const shared = { ...link, tokenIdentifier: "magic-link:shared" };
    await owner.db.insert(magicLinkRequests).values(request(one, shared));
    await refused(shared, "magic_link_requests_token_identifier_unique");
  });

  test("vocabularies, normalisation and counts", async () => {
    await refused(
      { purpose: "other" as "link" },
      "magic_link_requests_purpose_check",
    );
    await refused(
      { sendStatus: "other" as "sent" },
      "magic_link_requests_send_status_check",
    );
    await refused(
      { email: "Person@firm.example.com" },
      "magic_link_requests_email_normalized_check",
    );
    await refused(
      { email: " person@firm.example.com" },
      "magic_link_requests_email_normalized_check",
    );
    await refused({ attempts: -1 }, "magic_link_requests_attempts_check");
    await refused(
      { providerRevision: 0 },
      "magic_link_requests_provider_revision_check",
    );
  });

  test("only a failed send holds Postmark's answer", async () => {
    const check = "magic_link_requests_send_error_check";
    await refused({ sendStatus: "sent", postmarkErrorCode: 406 }, check);
    await refused({ sendStatus: "sending", postmarkHttpStatus: 422 }, check);
    await owner.db.insert(magicLinkRequests).values(
      request(one, {
        sendStatus: "failed",
        postmarkErrorCode: 406,
        postmarkHttpStatus: 422,
      }),
    );
    await owner.db
      .insert(magicLinkRequests)
      .values(request(one, { sendStatus: "failed" }));
  });

  test("a new row is `sending` with no attempts", async () => {
    const added = request(one);
    const [made] = await owner.db
      .insert(magicLinkRequests)
      .values(added)
      .returning();
    expect(made).toMatchObject({ sendStatus: "sending", attempts: 0 });
  });
});
