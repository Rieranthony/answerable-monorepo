import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { Resolver } from "node:dns/promises";

import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
import { magicLinkFirms } from "../../__tests__/magic-link.ts";
import { inPlatformWrite } from "../../__tests__/platform-context.ts";
import { createApp } from "../../app.ts";
import {
  adminOperations,
  auditEvents,
  organizationDomains,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { endDomainProof } from "../../services/domains.ts";

const domainSchema = responseSchema("createOrganizationDomain", 201);

let fixture: AdminFixture;
let firms: ReturnType<typeof magicLinkFirms>;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { restrictedRole: true },
  );
  firms = magicLinkFirms(fixture);
});
afterAll(() => fixture?.close());

type Kind = Parameters<AdminFixture["headers"]>[0] | "root";
function admin(
  path: string,
  init: { method?: string; kind?: Kind; key?: string; body?: unknown } = {},
) {
  const headers = fixture.headers(init.kind ?? "platformAdmin");
  if (init.key) headers.set("Idempotency-Key", init.key);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(`/api/admin/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

let nextFirm = 0;
async function domainOf() {
  const firm = await firms.seedOrganization(`proof-${++nextFirm}`, false);
  const [row] = await fixture.db
    .select()
    .from(organizationDomains)
    .where(eq(organizationDomains.domain, firm.domain));
  const record = {
    type: "TXT",
    name: `_answerable-challenge.${firm.domain}`,
    value: `answerable-domain-verification=${row!.verificationToken}`,
  };
  return {
    firm,
    row: row!,
    record,
    path: `/organizations/${firm.id}/domains/${row!.id}/verify`,
  };
}
type Domain = Awaited<ReturnType<typeof domainOf>>;

const verify = (
  { path }: Pick<Domain, "path">,
  init: { kind?: Kind; key?: string } = {},
) => admin(path, { method: "POST", ...init });

const stored = async ({ row }: Pick<Domain, "row">) =>
  (
    await fixture.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.id, row.id))
  )[0]!;

const eventsOf = (organizationId: string) =>
  fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        like(auditEvents.action, "domain.verif%"),
      ),
    )
    .orderBy(auditEvents.id);

async function prove(domain: Domain) {
  fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
  const answer = await verify(domain);
  expect(answer.status).toBe(200);
  fixture.dns.records.delete(domain.record.name);
  return answer;
}

describe("a match proves the domain", () => {
  test("one record: verifiedAt is set, audited, and the answer shows it", async () => {
    const domain = await domainOf();
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    const answer = await verify(domain);
    expect(answer.status).toBe(200);
    const body = domainSchema.parse(await answer.json());
    expect(body).toMatchObject({
      id: domain.row.id,
      verifiedAt: expect.any(String),
      verificationRecord: domain.record,
    });
    expect(body).not.toHaveProperty("verificationToken");
    expect((await stored(domain)).verifiedAt).toBeInstanceOf(Date);
    const events = await eventsOf(domain.firm.id);
    expect(events.map(({ action }) => action)).toEqual(["domain.verified"]);
    expect(events[0]).toMatchObject({
      targetType: "domain",
      targetId: domain.row.id,
      outcome: "success",
      operationId: answer.headers.get("Operation-Id"),
      data: {
        domain: domain.firm.domain,
        before: expect.objectContaining({ verifiedAt: null }),
        after: expect.objectContaining({ verifiedAt: expect.any(String) }),
      },
    });
  });

  test("any one record among others is enough", async () => {
    const domain = await domainOf();
    fixture.dns.records.set(domain.record.name, [
      ["v=spf1 -all"],
      [domain.record.value],
    ]);
    expect((await verify(domain)).status).toBe(200);
    expect((await stored(domain)).verifiedAt).not.toBeNull();
  });

  test("a value split into strings counts, in either shape a resolver hands them over", async () => {
    const { value, name } = (await domainOf()).record;
    expect(name).toBeString();
    for (const shape of [
      (a: string, b: string) => [[a, b]],
      (a: string, b: string) => [[a], [b]],
    ]) {
      const domain = await domainOf();
      const whole = domain.record.value;
      fixture.dns.records.set(
        domain.record.name,
        shape(whole.slice(0, 20), whole.slice(20)),
      );
      expect((await verify(domain)).status, value).toBe(200);
    }
  });

  test("the lookup asks exactly the challenge name", async () => {
    const domain = await domainOf();
    fixture.dns.lookups.length = 0;
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    await verify(domain);
    expect(fixture.dns.lookups).toEqual([domain.record.name]);
  });

  test("proved again, with the record still there: a noop, no event, and the time it was proved stays", async () => {
    const domain = await domainOf();
    await prove(domain);
    const proved = (await stored(domain)).verifiedAt;
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    const again = await verify(domain);
    expect(again.status).toBe(200);
    expect((await stored(domain)).verifiedAt).toEqual(proved);
    expect(await eventsOf(domain.firm.id)).toHaveLength(1);
    const [operation] = await fixture.db
      .select({ outcome: adminOperations.outcome })
      .from(adminOperations)
      .where(eq(adminOperations.id, again.headers.get("Operation-Id")!));
    expect(operation).toEqual({ outcome: "noop" });
  });

  test("a replay answers its receipt and does not re-check, even when DNS has changed since", async () => {
    const domain = await domainOf();
    const key = createId();
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    const first = await verify(domain, { key });
    expect(first.status).toBe(200);
    fixture.dns.records.delete(domain.record.name);
    const replay = await verify(domain, { key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(
      first.headers.get("Operation-Id"),
    );
    expect((await stored(domain)).verifiedAt).not.toBeNull();
    expect(await eventsOf(domain.firm.id)).toHaveLength(1);
  });
});

describe("a failed lookup proves nothing", () => {
  const failures: Record<string, (domain: Domain) => void> = {
    "no record": (domain) => fixture.dns.records.delete(domain.record.name),
    "another token": (domain) =>
      fixture.dns.records.set(domain.record.name, [
        ["answerable-domain-verification=somebody-elses"],
      ]),
    "the token alone": (domain) =>
      fixture.dns.records.set(domain.record.name, [
        [domain.row.verificationToken],
      ]),
    "the value at the bare domain, and not the challenge name": (domain) => {
      fixture.dns.records.delete(domain.record.name);
      fixture.dns.records.set(domain.firm.domain, [[domain.record.value]]);
    },
  };
  for (const [name, set] of Object.entries(failures))
    test(`${name}: domain_verification_failed, naming what was expected, and no state or event`, async () => {
      const domain = await domainOf();
      set(domain);
      const answer = await verify(domain);
      expect(answer.status).toBe(409);
      const problem = await answer.json();
      expect(problem).toMatchObject({
        code: "domain_verification_failed",
        expected: domain.record,
      });
      expect(problem.detail).toContain(domain.record.name);
      expect(problem.detail).toContain(domain.record.value);
      expect((await stored(domain)).verifiedAt).toBeNull();
      expect(await eventsOf(domain.firm.id)).toEqual([]);
      // Nothing changed, so nothing is journalled, under the caller's key or the server's.
      expect(answer.headers.get("Operation-Id")).toBeNull();
    });

  test("a resolver failure answers the same, with nothing of its own in the answer", async () => {
    const domain = await domainOf();
    fixture.dns.answer = async () => {
      throw Object.assign(new Error("connect 10.0.0.2:53 refused"), {
        code: "ECONNREFUSED",
      });
    };
    const { error } = console;
    console.error = () => {};
    try {
      const answer = await verify(domain);
      expect(answer.status).toBe(409);
      const text = await answer.text();
      expect(JSON.parse(text).code).toBe("domain_verification_failed");
      expect(text).not.toContain("10.0.0.2");
      expect(text).not.toContain("ECONNREFUSED");
    } finally {
      console.error = error;
      fixture.dns.answer = undefined;
    }
  });

  test("a resolver that never answers is bounded at five seconds", async () => {
    const domain = await domainOf();
    fixture.dns.answer = () => new Promise(() => {});
    const { error } = console;
    console.error = () => {};
    const started = performance.now();
    try {
      const answer = await verify(domain);
      expect(answer.status).toBe(409);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(7_000);
    } finally {
      console.error = error;
      fixture.dns.answer = undefined;
    }
  }, 10_000);

  test("the caller's key stays free: once the record is published, the same key proves the domain", async () => {
    const domain = await domainOf();
    const key = createId();
    expect((await verify(domain, { key })).status).toBe(409);
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    const second = await verify(domain, { key });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("false");
    expect((await stored(domain)).verifiedAt).not.toBeNull();
  });
});

describe("a re-check that fails takes the proof away", () => {
  test("verifiedAt is cleared, audited, and the answer names the change's operation", async () => {
    const domain = await domainOf();
    await prove(domain);
    const answer = await verify(domain);
    expect(answer.status).toBe(409);
    expect((await answer.json()).code).toBe("domain_verification_failed");
    expect((await stored(domain)).verifiedAt).toBeNull();
    const events = await eventsOf(domain.firm.id);
    expect(events.map(({ action }) => action)).toEqual([
      "domain.verified",
      "domain.verification_lost",
    ]);
    expect(events[1]).toMatchObject({
      outcome: "success",
      targetId: domain.row.id,
      operationId: answer.headers.get("Operation-Id"),
      data: {
        before: expect.objectContaining({ verifiedAt: expect.any(String) }),
        after: expect.objectContaining({ verifiedAt: null }),
      },
    });
    // Asked again it is an ordinary refusal: nothing left to clear, and no second event.
    expect((await verify(domain)).status).toBe(409);
    expect(await eventsOf(domain.firm.id)).toHaveLength(2);
  });

  test("the caller's key is not spent by the change: once the record is back, it proves again", async () => {
    const domain = await domainOf();
    await prove(domain);
    const key = createId();
    expect((await verify(domain, { key })).status).toBe(409);
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    expect((await verify(domain, { key })).status).toBe(200);
    expect((await stored(domain)).verifiedAt).not.toBeNull();
  });

  test("a resolver failure on a proved domain also fails closed", async () => {
    const domain = await domainOf();
    await prove(domain);
    fixture.dns.answer = async () => {
      throw Object.assign(new Error("timed out"), { code: "ETIMEOUT" });
    };
    const { error } = console;
    console.error = () => {};
    try {
      expect((await verify(domain)).status).toBe(409);
    } finally {
      console.error = error;
      fixture.dns.answer = undefined;
    }
    expect((await stored(domain)).verifiedAt).toBeNull();
  });
});

describe("losing a proof", () => {
  test("a domain with no proof left to lose: unchanged, with no event", async () => {
    const domain = await domainOf();
    const result = await inPlatformWrite(fixture.db, (context) =>
      endDomainProof(context, domain.firm.id, domain.row.id),
    );
    expect(result).toEqual({ changed: false });
    expect(await eventsOf(domain.firm.id)).toEqual([]);
  });

  test("a domain removed before it could be cleared is not_found", async () => {
    await expect(
      inPlatformWrite(fixture.db, (context) =>
        endDomainProof(context, createId(), createId()),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("the resolver a deployment uses", () => {
  test("with none given, the app asks node:dns, for the challenge name", async () => {
    const domain = await domainOf();
    const app = createApp({
      auth: fixture.auth,
      db: fixture.appDb,
      environment: fixture.environment,
    });
    const asked = spyOn(Resolver.prototype, "resolveTxt").mockImplementation(
      (async (name: string) => {
        expect(name).toBe(domain.record.name);
        return [[domain.record.value]];
      }) as Resolver["resolveTxt"],
    );
    try {
      const answer = await app.request(`/api/admin/v1${domain.path}`, {
        method: "POST",
        headers: fixture.headers("platformAdmin"),
      });
      expect(answer.status).toBe(200);
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      asked.mockRestore();
    }
    expect((await stored(domain)).verifiedAt).not.toBeNull();
  });
});

describe("who may ask, and of what", () => {
  test("no connection is held through the lookup: a pool of one still reads during it", async () => {
    const domain = await domainOf();
    let read = false;
    fixture.dns.answer = async () => {
      await fixture.appDb.execute("select 1");
      read = true;
      return [[domain.record.value]];
    };
    try {
      expect((await verify(domain)).status).toBe(200);
      expect(read).toBe(true);
    } finally {
      fixture.dns.answer = undefined;
    }
  });

  test("a caller without platform:write gets no lookup and changes nothing", async () => {
    const domain = await domainOf();
    fixture.dns.lookups.length = 0;
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    for (const scopes of [["platform:read"], ["platform:users"]]) {
      const bearer = await fixture.mintMachineToken(scopes);
      const refused = await verify(domain, { kind: { bearer } });
      expect(refused.status, scopes[0]).toBe(403);
    }
    for (const kind of ["platformReader", "tenantAdmin", "noGrant"] as const)
      expect((await verify(domain, { kind })).status, kind).toBeOneOf([
        403, 404,
      ]);
    expect(fixture.dns.lookups).toEqual([]);
    expect((await stored(domain)).verifiedAt).toBeNull();
  });

  test("a machine holding platform:write proves it, and the audit names the machine", async () => {
    const domain = await domainOf();
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    const bearer = await fixture.mintMachineToken(["platform:write"]);
    expect((await verify(domain, { kind: { bearer } })).status).toBe(200);
    expect((await eventsOf(domain.firm.id))[0]).toMatchObject({
      actorType: "client",
      actorId: fixture.platform.client.clientId,
    });
  });

  test("a missing domain, or another firm's, is not_found with no lookup", async () => {
    const domain = await domainOf();
    const other = await domainOf();
    fixture.dns.lookups.length = 0;
    for (const path of [
      `/organizations/${createId()}/domains/${domain.row.id}/verify`,
      `/organizations/${domain.firm.id}/domains/${createId()}/verify`,
      `/organizations/${other.firm.id}/domains/${domain.row.id}/verify`,
    ]) {
      const answer = await admin(path, { method: "POST" });
      expect(answer.status, path).toBe(404);
    }
    expect(fixture.dns.lookups).toEqual([]);
  });

  test("a disabled domain may be proved, and a removed one answers not_found", async () => {
    const domain = await domainOf();
    const path = `/organizations/${domain.firm.id}/domains/${domain.row.id}`;
    expect((await admin(`${path}/disable`, { method: "POST" })).status).toBe(
      200,
    );
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    expect((await verify(domain)).status).toBe(200);
    expect((await admin(path, { method: "DELETE" })).status).toBe(204);
    expect((await verify(domain)).status).toBe(404);
  });

  test("a stale directory sign-in is refused, and nothing changes", async () => {
    const domain = await domainOf();
    fixture.issuer.enqueue({
      sub: "platformAdmin-subject",
      email: "platformadmin@answerable.example.com",
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000) - 301,
    });
    const { signInThroughIdp } = await import("../../__tests__/federation.ts");
    const signedIn = await signInThroughIdp(fixture.app, {
      providerId: fixture.platform.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
    });
    const cookie = signedIn.cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    fixture.dns.records.set(domain.record.name, [[domain.record.value]]);
    const refused = await fixture.app.request(`/api/admin/v1${domain.path}`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: fixture.trustedOrigin,
        "Idempotency-Key": createId(),
      },
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("reauthentication_required");
    expect((await stored(domain)).verifiedAt).toBeNull();
  });
});

describe("a domain's answers show what to publish", () => {
  test("add, list, disable and enable show the record and the proof, and no bare token", async () => {
    const firm = await firms.seedOrganization(`proof-${++nextFirm}`, false);
    const domain = `shown-${createId()}.example.com`;
    const created = await admin(`/organizations/${firm.id}/domains`, {
      method: "POST",
      body: { domain },
    });
    expect(created.status).toBe(201);
    const body = domainSchema.parse(await created.json());
    const [row] = await fixture.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.id, body.id as string));
    const expected = {
      verifiedAt: null,
      verificationRecord: {
        type: "TXT",
        name: `_answerable-challenge.${domain}`,
        value: `answerable-domain-verification=${row!.verificationToken}`,
      },
    };
    expect(body).toMatchObject(expected);
    const path = `/organizations/${firm.id}/domains`;
    const page = await (await admin(path)).json();
    expect(
      page.items.find((item: { id: string }) => item.id === body.id),
    ).toMatchObject(expected);
    for (const item of page.items)
      expect(item).not.toHaveProperty("verificationToken");
    for (const action of ["disable", "enable"]) {
      const answer = await admin(`${path}/${body.id}/${action}`, {
        method: "POST",
      });
      expect(await answer.json(), action).toMatchObject(expected);
    }
  });

  test("a tenant's own read shows it too", async () => {
    const path = `/organizations/${fixture.tenant.organizationId}/domains`;
    const page = await (await admin(path, { kind: "tenantReader" })).json();
    expect(page.items[0].verificationRecord.name).toBe(
      "_answerable-challenge.tenant.example.com",
    );
  });

  test("a re-added domain and a moved domain are new rows, so a new token and no proof", async () => {
    const domain = await domainOf();
    await prove(domain);
    const base = `/organizations/${domain.firm.id}/domains`;
    expect(
      (await admin(`${base}/${domain.row.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    const again = await (
      await admin(base, {
        method: "POST",
        body: { domain: domain.firm.domain },
      })
    ).json();
    expect(again.id).not.toBe(domain.row.id);
    expect(again.verifiedAt).toBeNull();
    expect(again.verificationRecord.value).not.toBe(domain.record.value);
    // Moved: removed from this firm and added to another, with its own proof to make.
    const other = await firms.seedOrganization(`proof-${++nextFirm}`, false);
    expect(
      (await admin(`${base}/${again.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    const moved = await (
      await admin(`/organizations/${other.id}/domains`, {
        method: "POST",
        body: { domain: domain.firm.domain },
      })
    ).json();
    expect(moved.verifiedAt).toBeNull();
    expect(moved.verificationRecord.value).not.toBe(
      again.verificationRecord.value,
    );
  });
});

describe("the public mail list", () => {
  test("adding a public mail domain is refused, in any case, and nothing is written", async () => {
    const firm = await firms.seedOrganization(`proof-${++nextFirm}`, false);
    for (const domain of ["gmail.com", "GMAIL.com", "mailinator.com"]) {
      const refused = await admin(`/organizations/${firm.id}/domains`, {
        method: "POST",
        body: { domain },
      });
      expect(refused.status, domain).toBe(409);
      expect((await refused.json()).code).toBe("public_mail_domain");
    }
    expect(
      await fixture.db
        .select()
        .from(organizationDomains)
        .where(
          and(
            eq(organizationDomains.organizationId, firm.id),
            eq(organizationDomains.domain, "gmail.com"),
          ),
        ),
    ).toEqual([]);
  });

  test("a firm's own subdomain of a public domain is its own business", async () => {
    const firm = await firms.seedOrganization(`proof-${++nextFirm}`, false);
    const created = await admin(`/organizations/${firm.id}/domains`, {
      method: "POST",
      body: { domain: `acme-${createId()}.gmail.com` },
    });
    expect(created.status).toBe(201);
  });

  test("enabling an old row that joined the list is refused; it stays disabled, and disabling one is not", async () => {
    const firm = await firms.seedOrganization(`proof-${++nextFirm}`, false);
    const id = createId();
    await fixture.db.insert(organizationDomains).values({
      id,
      organizationId: firm.id,
      domain: "proton.me",
      status: "active",
    });
    const path = `/organizations/${firm.id}/domains/${id}`;
    // Already active: nothing changes, so nothing is refused, and it can be turned off.
    expect((await admin(`${path}/enable`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await admin(`${path}/disable`, { method: "POST" })).status).toBe(
      200,
    );
    const refused = await admin(`${path}/enable`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("public_mail_domain");
    const [row] = await fixture.db
      .select({ status: organizationDomains.status })
      .from(organizationDomains)
      .where(eq(organizationDomains.id, id));
    expect(row).toEqual({ status: "disabled" });
    await fixture.db
      .delete(organizationDomains)
      .where(eq(organizationDomains.id, id));
  });
});
