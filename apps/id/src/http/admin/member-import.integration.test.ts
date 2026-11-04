import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { magicLinkFlow } from "../../__tests__/magic-link-flow.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase } from "../../db/client.ts";
import {
  accounts,
  adminOperations,
  auditEventUsers,
  auditEvents,
  members,
  organizationDomains,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { maxImportAddresses } from "../../services/member-import.ts";

const answerSchema = responseSchema("importMembers", 200);

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
const side = createDatabase(testEnvironment({ databasePoolMax: 3 }));
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
});
afterAll(async () => {
  await fixture?.close();
  await side.close();
});

type Kind = Parameters<AdminFixture["headers"]>[0] | "root";
function importing(
  organizationId: string,
  addresses: string[],
  init: { kind?: Kind; key?: string } = {},
) {
  const headers = fixture.headers(init.kind ?? "platformAdmin");
  if (init.key) headers.set("Idempotency-Key", init.key);
  headers.set("content-type", "application/json");
  return fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}/members/import`,
    { method: "POST", headers, body: JSON.stringify({ addresses }) },
  );
}

type Answer = {
  counts: Record<"created" | "added" | "alreadyMember" | "refused", number>;
  items: { address: string; outcome: string; reason?: string }[];
};
async function answered(response: Response) {
  expect(response.status).toBe(200);
  return answerSchema.parse(await response.json()) as Answer;
}

let nextFirm = 0;
const firm = (directory = false) =>
  flow.seedOrganization(`import-${++nextFirm}`, directory);
const address = (of: { domain: string }, local = `p-${createId()}`) =>
  `${local}@${of.domain}`;

const holder = async (email: string) =>
  (await fixture.db.select().from(users).where(eq(users.email, email)))[0];
const membership = async (organizationId: string, userId: string) =>
  (
    await fixture.db
      .select()
      .from(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          eq(members.userId, userId),
        ),
      )
  )[0];
const importEvents = (organizationId: string) =>
  fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.action, "member.imported"),
      ),
    );

/** Each state an address can be in, and what importing it answers. */
const states: Record<
  string,
  {
    make: (of: Awaited<ReturnType<typeof firm>>) => Promise<string>;
    outcome: "created" | "added" | "alreadyMember" | "refused";
    reason?: string;
  }
> = {
  "no user yet": {
    make: async (of) => address(of),
    outcome: "created",
  },
  "an existing user with no membership here": {
    make: async (of) => {
      const elsewhere = await firm();
      return (await flow.listed({ id: elsewhere.id, domain: of.domain })).email;
    },
    outcome: "added",
  },
  "this firm's own directory account, with no membership": {
    make: async (of) => {
      const elsewhere = await firm();
      const person = await flow.listed({ id: elsewhere.id, domain: of.domain });
      // The account names a provider row of this firm's.
      const row = of.magicLink;
      await fixture.db.insert(accounts).values({
        id: createId(),
        userId: person.userId,
        providerId: row.providerId,
        issuer: row.issuer,
        accountId: person.email,
      });
      return person.email;
    },
    outcome: "added",
  },
  "an effective member": {
    make: async (of) => (await flow.listed(of)).email,
    outcome: "alreadyMember",
  },
  "a member outside their window": {
    make: async (of) => {
      const person = await flow.listed(of);
      await fixture.db.execute(
        sql`update members set valid_until = now() - interval '1 second' where id = ${person.memberId}`,
      );
      return person.email;
    },
    outcome: "alreadyMember",
  },
  "a revoked member": {
    make: async (of) => {
      const person = await flow.listed(of);
      await fixture.app.request(
        `/api/admin/v1/organizations/${of.id}/members/${person.memberId}`,
        { method: "DELETE", headers: fixture.headers("platformAdmin") },
      );
      return person.email;
    },
    outcome: "refused",
    reason: "removed",
  },
  "an existing disabled user": {
    make: async (of) => {
      const person = await flow.listed(of);
      await fixture.db.execute(
        sql`update users set status = 'disabled', disabled_at = now() where id = ${person.userId}`,
      );
      return person.email;
    },
    outcome: "refused",
    reason: "disabled",
  },
  "an account from another firm's directory": {
    make: async (of) => {
      const other = await flow.seedOrganization(`import-other-${++nextFirm}`);
      const person = await flow.listed({ id: other.id, domain: of.domain });
      await fixture.db.insert(accounts).values({
        id: createId(),
        userId: person.userId,
        providerId: other.row!.providerId,
        issuer: other.row!.issuer,
        accountId: `subject-${createId()}`,
      });
      return person.email;
    },
    outcome: "refused",
    reason: "other_firm",
  },
  "an account from another firm's magic-link row": {
    make: async (of) => {
      const other = await firm();
      const person = await flow.listed({ id: other.id, domain: of.domain });
      await fixture.db.insert(accounts).values({
        id: createId(),
        userId: person.userId,
        providerId: other.magicLink.providerId,
        issuer: other.magicLink.issuer,
        accountId: person.email,
      });
      return person.email;
    },
    outcome: "refused",
    reason: "other_firm",
  },
  "an address outside the firm's domains": {
    make: async () => `someone@elsewhere-${createId()}.example.com`,
    outcome: "refused",
    reason: "outside_domains",
  },
  "an address at a domain the firm has turned off": {
    make: async (of) => {
      const domain = `off-${createId()}.example.com`;
      await fixture.db.insert(organizationDomains).values({
        id: createId(),
        organizationId: of.id,
        domain,
        status: "disabled",
      });
      return `someone@${domain}`;
    },
    outcome: "refused",
    reason: "outside_domains",
  },
  "an address at a domain the firm has removed": {
    make: async (of) => {
      const domain = `gone-${createId()}.example.com`;
      await fixture.db.insert(organizationDomains).values({
        id: createId(),
        organizationId: of.id,
        domain,
        status: "disabled",
        deletedAt: new Date(),
      });
      return `someone@${domain}`;
    },
    outcome: "refused",
    reason: "outside_domains",
  },
  "another firm's domain": {
    make: async () => `someone@${(await firm()).domain}`,
    outcome: "refused",
    reason: "outside_domains",
  },
  "not an address": {
    make: async () => "not an address",
    outcome: "refused",
    reason: "invalid",
  },
  "too long to be an address": {
    make: async (of) => `${"a".repeat(255)}@${of.domain}`,
    outcome: "refused",
    reason: "invalid",
  },
};

describe("each address has its own answer", () => {
  for (const [name, { make, outcome, reason }] of Object.entries(states))
    test(`${name}: ${outcome}${reason ? `, ${reason}` : ""}`, async () => {
      const of = await firm();
      const email = await make(of);
      const expected = {
        address: email,
        outcome,
        ...(reason ? { reason } : {}),
      };
      const body = await answered(await importing(of.id, [email]));
      expect(body.items).toEqual([expected]);
      expect(body.counts).toEqual({
        created: 0,
        added: 0,
        alreadyMember: 0,
        refused: 0,
        [outcome]: 1,
      });
    });

  test("one bad address changes nothing about the rest, and the answers stay in order", async () => {
    const of = await firm();
    const member = await flow.listed(of);
    const [a, b] = [address(of), address(of)];
    const body = await answered(
      await importing(of.id, [
        a,
        "nonsense",
        member.email,
        "someone@gmail.com",
        b,
      ]),
    );
    expect(
      body.items.map(({ address, outcome }) => [address, outcome]),
    ).toEqual([
      [a, "created"],
      ["nonsense", "refused"],
      [member.email, "alreadyMember"],
      ["someone@gmail.com", "refused"],
      [b, "created"],
    ]);
    expect(body.counts).toEqual({
      created: 2,
      added: 0,
      alreadyMember: 1,
      refused: 2,
    });
    expect(await holder(a)).toBeDefined();
    expect(await holder(b)).toBeDefined();
  });
});

describe("what it makes", () => {
  test("created: a user and an active membership at once, the fields of a first sign-in, and no account", async () => {
    const of = await firm();
    const email = address(of);
    await answered(await importing(of.id, [email]));
    const user = (await holder(email))!;
    expect(user).toMatchObject({
      name: email,
      emailVerified: true,
      status: "active",
    });
    expect(user.id[14]).toBe("7");
    expect(await membership(of.id, user.id)).toMatchObject({
      status: "active",
      revokedAt: null,
      validFrom: null,
      validUntil: null,
    });
    expect(
      await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.userId, user.id)),
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id)),
    ).toEqual([]);
  });

  test("added: an existing user keeps their id and gains a membership", async () => {
    const of = await firm();
    const elsewhere = await firm();
    const person = await flow.listed({ id: elsewhere.id, domain: of.domain });
    await answered(await importing(of.id, [person.email]));
    expect((await holder(person.email))!.id).toBe(person.userId);
    expect(await membership(of.id, person.userId)).toMatchObject({
      status: "active",
    });
    expect(await membership(elsewhere.id, person.userId)).toBeDefined();
  });

  test("a removed person stays removed: no membership comes back, and reinstating is what does it", async () => {
    const of = await firm();
    const person = await flow.listed(of);
    const headers = fixture.headers("platformAdmin");
    await fixture.app.request(
      `/api/admin/v1/organizations/${of.id}/members/${person.memberId}`,
      { method: "DELETE", headers },
    );
    await answered(await importing(of.id, [person.email]));
    expect(await membership(of.id, person.userId)).toMatchObject({
      status: "revoked",
    });
  });

  test("addresses are normalised and de-duplicated, a repeat once and in first place", async () => {
    const of = await firm();
    const local = `Mixed-${createId()}`;
    const email = address(of, local).toLowerCase();
    const body = await answered(
      await importing(of.id, [
        `  ${local.toUpperCase()}@${of.domain.toUpperCase()}  `,
        email,
        "nonsense",
        "nonsense",
      ]),
    );
    expect(body.items).toEqual([
      { address: email, outcome: "created" },
      { address: "nonsense", outcome: "refused", reason: "invalid" },
    ]);
    expect(body.counts.created).toBe(1);
    expect(await holder(email)).toBeDefined();
    expect(await importEvents(of.id)).toHaveLength(1);
  });

  test("the person it made signs in by link as themselves, keeping the id", async () => {
    const of = await firm();
    const email = address(of);
    await answered(await importing(of.id, [email]));
    const user = (await holder(email))!;
    const request = await flow.ask(email);
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    expect(await flow.sessionsOf(user.id)).toHaveLength(1);
    expect(await flow.accountsOf(user.id)).toMatchObject([
      { accountId: email, providerId: of.magicLink.providerId },
    ]);
    // Their first sign-in made the one account, and no second person.
    expect((await holder(email))!.id).toBe(user.id);
    expect((await membership(of.id, user.id))!.status).toBe("active");
  });

  test("allowed with links off and with a directory connected", async () => {
    const off = await firm();
    const headers = fixture.headers("platformAdmin");
    await fixture.app.request(
      `/api/admin/v1/organizations/${off.id}/magic-link/disable`,
      { method: "POST", headers },
    );
    expect(
      (await answered(await importing(off.id, [address(off)]))).counts.created,
    ).toBe(1);
    const connected = await firm(true);
    expect(
      (await answered(await importing(connected.id, [address(connected)])))
        .counts.created,
    ).toBe(1);
  });

  test("a person it made with a directory connected is asked for a code from their mailbox, once, and no account exists until then", async () => {
    const of = await firm(true);
    const email = address(of, "imported-person");
    await answered(await importing(of.id, [email]));
    fixture.issuer.enqueue({
      sub: `${of.slug}-imported`,
      email,
      email_verified: true,
      name: "Imported",
      auth_time: Math.floor(Date.now() / 1000),
    });
    const callbackURL = `${fixture.trustedOrigin}/callback`;
    const signedIn = await signInThroughIdp(fixture.app, {
      providerId: of.slug,
      callbackURL,
      errorCallbackURL: `${fixture.trustedOrigin}/error`,
    });
    expect(signedIn.location).toBe("/connect-directory");
    const user = (await holder(email))!;
    expect(
      await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.userId, user.id)),
    ).toEqual([]);
  });
});

describe("what it records", () => {
  test("one member.imported per membership made, naming the person; none for the rest", async () => {
    const of = await firm();
    const elsewhere = await firm();
    const existing = await flow.listed({ id: elsewhere.id, domain: of.domain });
    const member = await flow.listed(of);
    const created = address(of);
    const response = await importing(of.id, [
      created,
      existing.email,
      member.email,
      "nonsense",
    ]);
    await answered(response);
    const user = (await holder(created))!;
    const events = await importEvents(of.id);
    expect(events).toHaveLength(2);
    const operationId = response.headers.get("Operation-Id");
    for (const [userId, userCreated] of [
      [user.id, true],
      [existing.userId, false],
    ] as const) {
      const memberRow = (await membership(of.id, userId))!;
      expect(
        events.find(({ targetId }) => targetId === memberRow.id),
      ).toMatchObject({
        targetType: "member",
        outcome: "success",
        operationId,
        actorType: "user",
        actorId: fixture.principals.platformAdmin.userId,
        data: {
          userId,
          userCreated,
          before: null,
          after: { membershipStatus: "active" },
        },
      });
    }
    const subjects = await fixture.db
      .select()
      .from(auditEventUsers)
      .where(
        inArray(
          auditEventUsers.eventId,
          events.map(({ id }) => id),
        ),
      );
    // Each row concerns the person it made, and the actor, as every member command's does.
    const actor = fixture.principals.platformAdmin.userId;
    expect(subjects.map(({ userId }) => userId).sort()).toEqual(
      [user.id, existing.userId, actor, actor].sort(),
    );
  });

  test("nothing changed: a noop receipt, and no event", async () => {
    const of = await firm();
    const member = await flow.listed(of);
    const response = await importing(of.id, [member.email, "nonsense"]);
    await answered(response);
    const [operation] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, response.headers.get("Operation-Id")!));
    expect(operation).toMatchObject({
      outcome: "noop",
      resultReference: { type: "organization", id: of.id },
    });
    expect(await importEvents(of.id)).toEqual([]);
  });

  test("the same key replays the receipt, and makes nothing twice; another key finds them there", async () => {
    const of = await firm();
    const email = address(of);
    const key = createId();
    const first = await importing(of.id, [email], { key });
    await answered(first);
    const replay = await importing(of.id, [email], { key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(
      first.headers.get("Operation-Id"),
    );
    expect(await replay.json()).toMatchObject({
      outcome: "applied",
      resultReference: { type: "organization", id: of.id },
    });
    expect(await importEvents(of.id)).toHaveLength(1);
    const again = await answered(await importing(of.id, [email]));
    expect(again.items).toEqual([{ address: email, outcome: "alreadyMember" }]);
    const reused = await importing(of.id, [address(of)], { key });
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe("idempotency_key_reused");
  });
});

describe("who may import, and how many", () => {
  test("platform:users only, on both the command and its write; tenants are refused", async () => {
    const of = await firm();
    const email = address(of);
    for (const scopes of [["platform:read"], ["platform:write"]]) {
      const bearer = await fixture.mintMachineToken(scopes);
      expect(
        (await importing(of.id, [email], { kind: { bearer } })).status,
        scopes[0],
      ).toBe(403);
    }
    for (const kind of [
      "platformReader",
      "tenantAdmin",
      "tenantUsersOnly",
      "noGrant",
    ] as const)
      expect(
        (await importing(fixture.tenant.organizationId, [email], { kind }))
          .status,
        kind,
      ).toBeOneOf([403, 404]);
    expect(await holder(email)).toBeUndefined();
    const bearer = await fixture.mintMachineToken([
      "platform:read",
      "platform:users",
    ]);
    await answered(await importing(of.id, [email], { kind: { bearer } }));
    expect(await holder(email)).toBeDefined();
    expect((await importEvents(of.id))[0]).toMatchObject({
      actorType: "client",
      actorId: fixture.platform.client.clientId,
    });
  });

  test("a person whose directory sign-in is stale is refused", async () => {
    const of = await firm();
    const email = address(of);
    fixture.issuer.enqueue({
      sub: "platformAdmin-subject",
      email: "platformadmin@answerable.example.com",
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000) - 301,
    });
    const signedIn = await signInThroughIdp(fixture.app, {
      providerId: fixture.platform.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
    });
    const refused = await fixture.app.request(
      `/api/admin/v1/organizations/${of.id}/members/import`,
      {
        method: "POST",
        headers: {
          Cookie: signedIn.cookies
            .map((value) => value.split(";", 1)[0])
            .join("; "),
          Origin: fixture.trustedOrigin,
          "Content-Type": "application/json",
          "Idempotency-Key": createId(),
        },
        body: JSON.stringify({ addresses: [email] }),
      },
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("reauthentication_required");
    expect(await holder(email)).toBeUndefined();
  });

  test("1,000 is the limit, an empty list is refused, and a missing organisation is not_found", async () => {
    const of = await firm();
    expect(maxImportAddresses).toBe(1_000);
    const tooMany = Array.from(
      { length: maxImportAddresses + 1 },
      (_, index) => `p${index}@${of.domain}`,
    );
    expect((await importing(of.id, tooMany)).status).toBe(400);
    expect((await importing(of.id, [])).status).toBe(400);
    expect((await importing(createId(), ["a@b.example"])).status).toBe(404);
    expect(
      await fixture.db
        .select()
        .from(users)
        .where(like(users.email, `%@${of.domain}`)),
    ).toEqual([]);
  });

  test("the longest list the limit allows fits the request body limit", async () => {
    const longest = Array.from(
      { length: maxImportAddresses },
      () => `${"a".repeat(64)}@${"b".repeat(185)}.com`,
    );
    expect(JSON.stringify({ addresses: longest }).length).toBeLessThan(
      256 * 1024,
    );
    expect(longest[0]!.length).toBe(254);
  });
});

describe("racing what else makes these rows", () => {
  /** Wait until something is blocked on a lock in this database. */
  async function untilBlocked() {
    for (;;) {
      const { rows } = await side.pool.query(
        "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
      );
      if (rows[0].count > 0) return;
      await Bun.sleep(5);
    }
  }

  test("a user committed while the import waits on the address is an existing user, never a second", async () => {
    const of = await firm();
    const email = address(of);
    const client = await side.pool.connect();
    let running: Promise<Response> | undefined;
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`answerable:magic-link:${email}`],
      );
      running = Promise.resolve(importing(of.id, [email]));
      await untilBlocked();
      const userId = createId();
      await client.query(
        "insert into users (id, name, email, email_verified, status) values ($1, $2, $3, true, 'active')",
        [userId, email, email],
      );
      await client.query("commit");
      const body = await answered((await running)!);
      expect(body.items).toEqual([{ address: email, outcome: "added" }]);
      expect((await holder(email))!.id).toBe(userId);
    } finally {
      await running?.catch(() => {});
      client.release();
    }
  });

  test("a directory's first sign-in in the middle, with no address lock: its user stands, and the import adds to it", async () => {
    const of = await firm();
    const email = address(of);
    const client = await side.pool.connect();
    const userId = createId();
    let running: Promise<Response> | undefined;
    try {
      await client.query("begin");
      await client.query(
        "insert into users (id, name, email, email_verified, status) values ($1, $2, $3, true, 'active')",
        [userId, email, email],
      );
      running = Promise.resolve(importing(of.id, [email]));
      await untilBlocked();
      await client.query("commit");
      const body = await answered((await running)!);
      expect(body.items).toEqual([{ address: email, outcome: "added" }]);
      expect((await holder(email))!.id).toBe(userId);
      expect(await membership(of.id, userId)).toBeDefined();
    } finally {
      await running?.catch(() => {});
      client.release();
    }
  });

  test("its membership made in the middle: already a member, and no event", async () => {
    const of = await firm();
    const elsewhere = await firm();
    const person = await flow.listed({ id: elsewhere.id, domain: of.domain });
    const client = await side.pool.connect();
    let running: Promise<Response> | undefined;
    try {
      await client.query("begin");
      await client.query(
        "insert into members (id, organization_id, user_id) values ($1, $2, $3)",
        [createId(), of.id, person.userId],
      );
      running = Promise.resolve(importing(of.id, [person.email]));
      await untilBlocked();
      await client.query("commit");
      const body = await answered((await running)!);
      expect(body.items).toEqual([
        { address: person.email, outcome: "alreadyMember" },
      ]);
      expect(await importEvents(of.id)).toEqual([]);
    } finally {
      await running?.catch(() => {});
      client.release();
    }
  });

  test("two imports of the same addresses: one makes them, the other finds them, and nothing is doubled", async () => {
    const of = await firm();
    const addresses = Array.from({ length: 50 }, () => address(of));
    const [a, b] = await Promise.all([
      importing(of.id, addresses),
      importing(of.id, addresses),
    ]);
    const answers = [await answered(a), await answered(b)];
    expect(answers.map(({ counts }) => counts.created).sort()).toEqual([0, 50]);
    expect(answers.map(({ counts }) => counts.alreadyMember).sort()).toEqual([
      0, 50,
    ]);
    expect(await importEvents(of.id)).toHaveLength(50);
    expect(
      await fixture.db
        .select({ id: users.id })
        .from(users)
        .where(like(users.email, `%@${of.domain}`)),
    ).toHaveLength(50);
  });

  test("the domain removed while the import waits: its addresses are refused, and the rest of the firm's made", async () => {
    const of = await firm();
    const second = `second-${createId()}.example.com`;
    const domainId = createId();
    await fixture.db.insert(organizationDomains).values({
      id: domainId,
      organizationId: of.id,
      domain: second,
    });
    const client = await side.pool.connect();
    const [kept, gone] = [address(of), `someone@${second}`];
    let running: Promise<Response> | undefined;
    try {
      await client.query("begin");
      await client.query(
        "select 1 from organizations where id = $1 for update",
        [of.id],
      );
      running = Promise.resolve(importing(of.id, [kept, gone]));
      await untilBlocked();
      await client.query(
        "update organization_domains set deleted_at = now(), status = 'disabled' where id = $1",
        [domainId],
      );
      await client.query("commit");
      const body = await answered((await running)!);
      expect(body.items).toEqual([
        { address: kept, outcome: "created" },
        { address: gone, outcome: "refused", reason: "outside_domains" },
      ]);
    } finally {
      await running?.catch(() => {});
      client.release();
    }
  });
});
