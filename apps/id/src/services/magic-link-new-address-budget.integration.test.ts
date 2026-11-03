import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql, type SQL } from "drizzle-orm";

import {
  capturingLogs,
  openMagicLinkFixture,
  type MagicLinkFixture,
} from "../__tests__/magic-link-requests.ts";
import { inPlatformUsers } from "../__tests__/platform-context.ts";
import { magicLinkKeys } from "../auth/magic-link.ts";
import {
  magicLinkRequests,
  organizationDomains,
  ssoProviders,
} from "../db/schema/index.ts";
import { importMembers } from "./member-import.ts";
import {
  magicLinkLimits,
  newAddressClientCount,
  newAddressOrganizationCount,
} from "./magic-link-requests.ts";

let fixture: MagicLinkFixture;
let keys: ReturnType<typeof magicLinkKeys>;
beforeAll(async () => {
  fixture = await openMagicLinkFixture();
  keys = magicLinkKeys(fixture.environment);
});
afterAll(() => fixture?.close());

// The rows of a client are counted at every firm, so each test has a client of its own.
let nextClient = 0;
const aClient = () => `198.51.100.${++nextClient}`;
const hashOf = (client: string) => keys.clientHash(client);

type Firm = Awaited<ReturnType<MagicLinkFixture["firm"]>>;

/** A firm in domain mode, its one domain proved. */
async function openFirm() {
  const firm = await fixture.firm();
  await fixture.owner.db
    .update(ssoProviders)
    .set({ admission: "domain" })
    .where(
      and(
        eq(ssoProviders.organizationId, firm.id),
        eq(ssoProviders.kind, "magic_link"),
      ),
    );
  await fixture.owner.db
    .update(organizationDomains)
    .set({ verifiedAt: sql`now()` })
    .where(eq(organizationDomains.id, firm.domainId));
  return firm;
}

let nextAddress = 0;
const newAddress = (firm: Pick<Firm, "domain">) =>
  `new-${++nextAddress}@${firm.domain}`;

/** `count` earlier requests for addresses nobody held, each from `client` or a client of its own. */
function earlier(
  firm: Firm,
  count: number,
  {
    client,
    age = "0 seconds",
    status = "sent",
    isNew = true,
  }: { client?: string; age?: string; status?: string; isNew?: boolean } = {},
) {
  return fixture.owner.pool.query(
    `insert into magic_link_requests (id, organization_id, provider_id, provider_revision, purpose, email, client_hash, expires_at, send_status, created_at, new_address)
     select uuid_v7(), $1, (select id from sso_providers where organization_id = $1 and kind = 'magic_link'), 1, 'access_removed',
       'filler-' || n || '-' || $6 || '@' || $2, coalesce($3, 'other-client-' || n), now(), $4, now() - $5::interval, $7
     from generate_series(1, $8::int) n`,
    [
      firm.id,
      firm.domain,
      client ? hashOf(client) : null,
      status,
      age,
      ++nextAddress,
      isNew,
      count,
    ],
  );
}

const cleanUp = (...firms: Firm[]) =>
  Promise.all(
    firms.map(({ id }) =>
      fixture.owner.db
        .delete(magicLinkRequests)
        .where(eq(magicLinkRequests.organizationId, id)),
    ),
  );

describe("a client's budget", () => {
  test("the hundredth in an hour passes, the next writes no row and sends nothing, and an hour later it passes", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 99, { client, age: "59 minutes" });
    const hundredth = newAddress(firm);
    expect((await fixture.ask(hundredth, { client })).outcome).toBe("sent");
    expect(fixture.mailsTo(hundredth)).toHaveLength(1);

    const next = newAddress(firm);
    const lines = await capturingLogs(async (written) => {
      expect(await fixture.ask(next, { client })).toEqual({
        outcome: "limited",
        limit: "new_address_client_hour",
      });
      return written;
    });
    expect(await fixture.rows(next)).toEqual([]);
    expect(fixture.mailsTo(next)).toEqual([]);
    const line = lines.find((written) => written.includes('"limited"'))!;
    expect(line).toContain('"limit":"new_address_client_hour"');
    expect(line).toContain(`"organizationId":"${firm.id}"`);
    expect(line).not.toContain(next);

    await fixture.owner.pool.query(
      `update magic_link_requests set created_at = now() - interval '61 minutes' where client_hash = $1`,
      [hashOf(client)],
    );
    expect((await fixture.ask(next, { client })).outcome).toBe("sent");
    await cleanUp(firm);
  });

  test("it counts at every firm: a client at its budget is held at another firm too", async () => {
    const [firm, other] = [await openFirm(), await openFirm()];
    const client = aClient();
    await earlier(firm, 100, { client });
    expect(await fixture.ask(newAddress(other), { client })).toEqual({
      outcome: "limited",
      limit: "new_address_client_hour",
    });
    await cleanUp(firm, other);
  });
});

describe("a firm's budget", () => {
  test("the five hundredth in a day passes, the next writes no row and sends nothing, and a day later it passes", async () => {
    const firm = await openFirm();
    await earlier(firm, 499, { age: "23 hours" });
    const last = newAddress(firm);
    expect((await fixture.ask(last, { client: aClient() })).outcome).toBe(
      "sent",
    );
    const next = newAddress(firm);
    expect(await fixture.ask(next, { client: aClient() })).toEqual({
      outcome: "limited",
      limit: "new_address_organization_day",
    });
    expect(await fixture.rows(next)).toEqual([]);
    expect(fixture.mailsTo(next)).toEqual([]);
    await fixture.owner.pool.query(
      `update magic_link_requests set created_at = now() - interval '25 hours' where organization_id = $1`,
      [firm.id],
    );
    expect((await fixture.ask(next, { client: aClient() })).outcome).toBe(
      "sent",
    );
    await cleanUp(firm);
  });

  test("two clients share the firm's budget, and neither the other's", async () => {
    const firm = await openFirm();
    const [first, second] = [aClient(), aClient()];
    await earlier(firm, 100, { client: first });
    // The first is at its own budget, and the second is not held by that.
    expect(await fixture.ask(newAddress(firm), { client: first })).toEqual({
      outcome: "limited",
      limit: "new_address_client_hour",
    });
    expect(
      (await fixture.ask(newAddress(firm), { client: second })).outcome,
    ).toBe("sent");
    // Others use the rest, and now the second, far below its own, is held by the firm's.
    await earlier(firm, 399);
    expect(await fixture.ask(newAddress(firm), { client: second })).toEqual({
      outcome: "limited",
      limit: "new_address_organization_day",
    });
    await cleanUp(firm);
  });

  test("another firm is unaffected", async () => {
    const [firm, other] = [await openFirm(), await openFirm()];
    await earlier(firm, 500);
    expect(
      (await fixture.ask(newAddress(firm), { client: aClient() })).outcome,
    ).toBe("limited");
    expect(
      (await fixture.ask(newAddress(other), { client: aClient() })).outcome,
    ).toBe("sent");
    await cleanUp(firm, other);
  });
});

describe("what they count", () => {
  test("a new person's row says so, and a member's, a user's and a removed person's do not", async () => {
    const firm = await openFirm();
    const address = newAddress(firm);
    await fixture.ask(address, { client: aClient() });
    expect(await fixture.rows(address)).toMatchObject([{ newAddress: true }]);
    const member = await fixture.member(firm, "member");
    await fixture.ask(member.email, { client: aClient() });
    expect(await fixture.rows(member.email)).toMatchObject([
      { newAddress: false },
    ]);
    const user = await fixture.person(firm, "user");
    await fixture.ask(user.email, { client: aClient() });
    expect(await fixture.rows(user.email)).toMatchObject([
      { newAddress: false },
    ]);
    const removed = await fixture.member(firm, "removed");
    await fixture.owner.pool.query(
      `update members set status = 'revoked', revoked_at = now() where id = $1`,
      [removed.memberId],
    );
    await fixture.ask(removed.email, { client: aClient() });
    expect(await fixture.rows(removed.email)).toMatchObject([
      { newAddress: false, purpose: "access_removed" },
    ]);
    await cleanUp(firm);
  });

  test("a failed send does not count, as a client's or a firm's, and one still sending does", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 100, { client, status: "failed" });
    await earlier(firm, 500, { status: "failed" });
    expect((await fixture.ask(newAddress(firm), { client })).outcome).toBe(
      "sent",
    );
    const sending = await openFirm();
    await earlier(sending, 500, { status: "sending" });
    expect(
      await fixture.ask(newAddress(sending), { client: aClient() }),
    ).toEqual({
      outcome: "limited",
      limit: "new_address_organization_day",
    });
    await cleanUp(firm, sending);
  });

  test("a real failed send leaves a row that says new and counts for nothing", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 99, { client });
    const down = fixture.instance({
      transport: {
        send: async () => ({
          status: "failed" as const,
          errorCode: null,
          httpStatus: 500,
          retried: false,
        }),
      },
    });
    const failed = newAddress(firm);
    const answer = await down.process({
      address: failed,
      browser: "b".repeat(43),
      client,
      pendingQuery: null,
    });
    expect(answer.outcome).toBe("failed");
    expect(await fixture.rows(failed)).toMatchObject([
      { newAddress: true, sendStatus: "failed" },
    ]);
    expect((await fixture.ask(newAddress(firm), { client })).outcome).toBe(
      "sent",
    );
    await cleanUp(firm);
  });

  test("requests for people ID knows do not count", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 100, { client, isNew: false });
    await earlier(firm, 500, { isNew: false });
    expect((await fixture.ask(newAddress(firm), { client })).outcome).toBe(
      "sent",
    );
    await cleanUp(firm);
  });

  test("the hour and the day are the windows: a row just outside either does not count", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 100, { client, age: "61 minutes" });
    expect((await fixture.ask(newAddress(firm), { client })).outcome).toBe(
      "sent",
    );
    const old = await openFirm();
    await earlier(old, 500, { age: "25 hours" });
    expect(
      (await fixture.ask(newAddress(old), { client: aClient() })).outcome,
    ).toBe("sent");
    await cleanUp(firm, old);
  });
});

describe("who they hold back", () => {
  test("at both budgets a member, a user with no membership here and a removed person still get their mail", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 100, { client });
    await earlier(firm, 400);
    expect((await fixture.ask(newAddress(firm), { client })).outcome).toBe(
      "limited",
    );
    const member = await fixture.member(firm, "still-member");
    expect((await fixture.ask(member.email, { client })).outcome).toBe("sent");
    expect(fixture.mailsTo(member.email)).toHaveLength(1);
    const user = await fixture.person(firm, "still-user");
    expect((await fixture.ask(user.email, { client })).outcome).toBe("sent");
    const removed = await fixture.member(firm, "still-removed");
    await fixture.owner.pool.query(
      `update members set status = 'revoked', revoked_at = now() where id = $1`,
      [removed.memberId],
    );
    expect((await fixture.ask(removed.email, { client })).outcome).toBe("sent");
    await cleanUp(firm);
  });

  test("members_import then a link does not count: the way to a firm-wide start", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 100, { client });
    await earlier(firm, 400);
    const address = newAddress(firm);
    expect((await fixture.ask(address, { client })).outcome).toBe("limited");
    await inPlatformUsers(fixture.owner.db, (context) =>
      importMembers(context, firm.id, [address]),
    );
    expect((await fixture.ask(address, { client })).outcome).toBe("sent");
    expect(await fixture.rows(address)).toMatchObject([{ newAddress: false }]);
    await cleanUp(firm);
  });

  test("a listed firm has no new addresses to count: nothing is sent and nothing written", async () => {
    const firm = await fixture.firm();
    const address = newAddress(firm);
    expect((await fixture.ask(address, { client: aClient() })).outcome).toBe(
      "stranger",
    );
    expect(await fixture.rows(address)).toEqual([]);
  });
});

describe("which limit a request names", () => {
  test("the limits there were before come first", async () => {
    const firm = await openFirm();
    const client = aClient();
    const address = newAddress(firm);
    expect((await fixture.ask(address, { client })).outcome).toBe("sent");
    await earlier(firm, 100, { client });
    expect(await fixture.ask(address, { client })).toEqual({
      outcome: "limited",
      limit: "address_client_minute",
    });
    await cleanUp(firm);
  });

  test("the firm's hourly cap comes before either budget", async () => {
    const firm = await openFirm();
    await earlier(firm, 5_000);
    expect(await fixture.ask(newAddress(firm), { client: aClient() })).toEqual({
      outcome: "limited",
      limit: "organization_hour",
    });
    await cleanUp(firm);
  }, 30_000);

  test("the client's comes before the firm's", async () => {
    const firm = await openFirm();
    const client = aClient();
    await earlier(firm, 100, { client });
    await earlier(firm, 400);
    expect(await fixture.ask(newAddress(firm), { client })).toEqual({
      outcome: "limited",
      limit: "new_address_client_hour",
    });
    await cleanUp(firm);
  });
});

describe("what they read", () => {
  type Node = {
    "Relation Name"?: string;
    "Index Name"?: string;
    "Actual Rows"?: number;
    "Shared Hit Blocks"?: number;
    Plan?: Node;
    Plans?: Node[];
  };
  const on = (from: Node): Node | undefined =>
    from["Relation Name"] === "magic_link_requests"
      ? from
      : [from.Plan, ...(from.Plans ?? [])]
          .filter((next) => next !== undefined)
          .map(on)
          .find(Boolean);

  /** The plan of this count, as `EXPLAIN (ANALYZE, BUFFERS)` shows it. */
  const explained = (statement: SQL) =>
    fixture.owner.db.transaction(async (tx) => {
      // A table this small may plan otherwise, and a large one chooses this by itself: measured
      // on 195,500 rows, 500 rows of this index in 3 buffers, and in 14 before any vacuum.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": Node[] }>(
        sql`explain (analyze, buffers, format json) ${statement}`,
      );
      return on(rows[0]!["QUERY PLAN"][0]!)!;
    });

  test("a firm at its budget, among far more rows, reads no more than the budget's rows of its own index", async () => {
    const [flooded, quiet] = [await openFirm(), await openFirm()];
    const cap = 500;
    await earlier(flooded, cap + 300);
    await earlier(flooded, 4_000, { isNew: false });
    await earlier(flooded, 2_000, { status: "failed" });
    await earlier(quiet, 10);
    await fixture.owner.pool.query("vacuum analyze magic_link_requests");
    const full = await explained(newAddressOrganizationCount(flooded.id));
    expect(full["Index Name"]).toBe(
      "magic_link_requests_new_address_organization_idx",
    );
    expect(full["Actual Rows"]).toBe(cap);
    const small = await explained(newAddressOrganizationCount(quiet.id));
    expect(small["Index Name"]).toBe(
      "magic_link_requests_new_address_organization_idx",
    );
    expect(small["Actual Rows"]).toBe(10);
    await cleanUp(flooded, quiet);
  }, 30_000);

  test("a client at its budget reads no more than the budget's rows of its own index", async () => {
    const [firm, other] = [await openFirm(), await openFirm()];
    const client = aClient();
    const cap = 100;
    await earlier(firm, cap, { client });
    await earlier(other, 300, { client });
    await earlier(firm, 3_000);
    await earlier(other, 3_000);
    await earlier(firm, 2_000, { client, isNew: false });
    await earlier(firm, 2_000, { client, status: "failed" });
    await fixture.owner.pool.query("vacuum analyze magic_link_requests");
    const full = await explained(newAddressClientCount(hashOf(client)));
    expect(full["Index Name"]).toBe(
      "magic_link_requests_new_address_client_idx",
    );
    expect(full["Actual Rows"]).toBe(cap);
    await cleanUp(firm, other);
  }, 30_000);
});

describe("the words", () => {
  test("what staff are told is what the limits are", async () => {
    const repository = new URL("../../../../", import.meta.url);
    const preview = await Bun.file(
      new URL("mcps/admin/src/magiclinks.ts", repository),
    ).text();
    expect(magicLinkLimits.newAddressClientPerHour).toBe(100);
    expect(magicLinkLimits.newAddressOrganizationPerDay).toBe(500);
    expect(preview).toContain(
      `at most ${magicLinkLimits.newAddressClientPerHour} an hour from one client and ${magicLinkLimits.newAddressOrganizationPerDay} a day for the organisation`,
    );
    const operations = await Bun.file(
      new URL("apps/id/OPERATIONS.md", repository),
    ).text();
    for (const name of [
      "new_address_client_hour",
      "new_address_organization_day",
    ])
      expect(operations).toContain(name);
  });
});
