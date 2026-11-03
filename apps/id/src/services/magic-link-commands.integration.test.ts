import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { magicLinkIssuer } from "../auth/magic-link.ts";
import {
  accounts,
  auditEvents,
  grantContexts,
  magicLinkRequests,
  organizationDomains,
  ssoProviders,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  deleteOrganizationDomain,
  disableDomain,
  enableDomain,
} from "./domains.ts";
import { disableUser, eraseUser, retireUserEmail } from "./users.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
  await flow.registerClient();
});
afterAll(() => fixture?.close());

let nextFirm = 0;
const firm = (directory = false) =>
  flow.seedOrganization(`commands-${++nextFirm}`, directory);

async function signIn(person: { email: string; memberId: string }) {
  const request = await flow.ask(person.email);
  const cookie = flow.signedIn(
    await flow.follow(request.token!, request.cookie),
  );
  const tokens = await flow.issueTokens(cookie, person.memberId);
  return { cookie, refreshToken: tokens.refresh_token };
}

const secondDomain = async (organizationId: string) => {
  const domainId = createId();
  const domain = `second-${domainId}.example.com`;
  await fixture.db
    .insert(organizationDomains)
    .values({ id: domainId, organizationId, domain });
  return { domainId, domain };
};

const domainIdOf = async (domain: string) => {
  const [row] = await fixture.db
    .select({ id: organizationDomains.id })
    .from(organizationDomains)
    .where(eq(organizationDomains.domain, domain));
  return row!.id;
};

describe("a domain that stops being the firm's", () => {
  for (const [name, end] of [
    [
      "disabled",
      (organizationId: string, domainId: string) =>
        inPlatformWrite(fixture.db, (context) =>
          disableDomain(context, organizationId, domainId),
        ),
    ],
    [
      "removed",
      (organizationId: string, domainId: string) =>
        inPlatformWrite(fixture.db, (context) =>
          deleteOrganizationDomain(context, organizationId, domainId),
        ),
    ],
  ] as const)
    test(`${name}: its addresses' sessions and grants end, the rest of the firm stays signed in, and no revision moves`, async () => {
      const organization = await firm();
      await flow.allowClient(organization.id);
      const { domainId, domain } = await secondDomain(organization.id);
      const leaving = await flow.listed({ id: organization.id, domain });
      const staying = await flow.listed(organization);
      const gone = await signIn(leaving);
      const kept = await signIn(staying);
      const [sessionBefore] = await flow.sessionsOf(leaving.userId);
      const [grantBefore] = await fixture.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.userId, leaving.userId));

      await end(organization.id, domainId);

      expect(await flow.sessionsOf(leaving.userId)).toEqual([]);
      const refused = await flow.refresh(gone.refreshToken);
      expect(refused.status).toBe(400);
      const page = await fixture.app.request("/login", {
        headers: { cookie: gone.cookie },
      });
      expect(await page.text()).toContain("Work email");

      expect(await flow.sessionsOf(staying.userId)).toHaveLength(1);
      expect((await flow.refresh(kept.refreshToken)).status).toBe(200);
      const stayed = await fixture.app.request("/login", {
        headers: { cookie: kept.cookie },
      });
      expect(await stayed.text()).toContain("Signed in as");

      const [row] = await fixture.db
        .select({ revision: ssoProviders.revision })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, organization.magicLink.id));
      expect(row!.revision).toBe(organization.magicLink.revision);

      const [event] = await fixture.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, domainId),
            eq(
              auditEvents.action,
              `domain.${name === "removed" ? "deleted" : "disabled"}`,
            ),
          ),
        );
      expect(event!.data).toMatchObject({
        magicLinkEffects: {
          deletedSessions: [{ id: sessionBefore!.id, userId: leaving.userId }],
          revokedGrantContexts: [
            { id: grantBefore!.id, userId: leaving.userId },
          ],
        },
      });
    });

  test("a directory's sessions at that domain are not touched", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    await flow.allowClient(organization.id);
    const tokens = await flow.issueTokens(person.cookie, person.memberId);
    const domainId = await domainIdOf(organization.domain);
    await inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, organization.id, domainId),
    );
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    expect((await flow.refresh(tokens.refresh_token)).status).toBe(200);
  });

  test("another firm's address at a same-named part is not touched", async () => {
    const organization = await firm();
    const other = await firm();
    await flow.allowClient(other.id);
    const person = await flow.listed(other);
    const kept = await signIn(person);
    const domainId = await domainIdOf(organization.domain);
    await inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, organization.id, domainId),
    );
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    expect((await flow.refresh(kept.refreshToken)).status).toBe(200);
  });

  test("enabling it again revives nothing, and a command that changes nothing ends nothing", async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    const first = await signIn(person);
    const domainId = await domainIdOf(organization.domain);
    await inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, organization.id, domainId),
    );
    await inPlatformWrite(fixture.db, (context) =>
      enableDomain(context, organization.id, domainId),
    );
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    expect((await flow.refresh(first.refreshToken)).status).toBe(400);
    await fixture.db
      .update(magicLinkRequests)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(magicLinkRequests.email, person.email));
    // A new sign-in works, and enabling an enabled domain leaves it alone.
    const second = await signIn(person);
    await inPlatformWrite(fixture.db, (context) =>
      enableDomain(context, organization.id, domainId),
    );
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    expect((await flow.refresh(second.refreshToken)).status).toBe(200);
  });

  test("enabling a domain ends nothing, and its event says nothing of it", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const domainId = await domainIdOf(organization.domain);
    await inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, organization.id, domainId),
    );
    // A session of that address made while it was disabled, which only this seed could make.
    await flow.magicLinkSession(organization, person);
    await inPlatformWrite(fixture.db, (context) =>
      enableDomain(context, organization.id, domainId),
    );
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, domainId),
          eq(auditEvents.action, "domain.enabled"),
        ),
      );
    expect(event!.data).not.toHaveProperty("magicLinkEffects");
  });

  test("a disabled domain disabled again finds nothing and writes nothing", async () => {
    const organization = await firm();
    const domainId = await domainIdOf(organization.domain);
    const events = () =>
      fixture.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, domainId),
            eq(auditEvents.action, "domain.disabled"),
          ),
        );
    await inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, organization.id, domainId),
    );
    await inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, organization.id, domainId),
    );
    expect(await events()).toHaveLength(1);
  });
});

describe("retiring and erasing a person", () => {
  const seeded = async () => {
    const organization = await firm();
    await flow.allowClient(organization.id);
    const person = await flow.listed(organization);
    await signIn(person);
    // A request still live, for the address, and its token.
    await fixture.db
      .update(magicLinkRequests)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(magicLinkRequests.email, person.email));
    const live = await flow.ask(person.email);
    const rows = await flow.requestsOf(person.email);
    expect(rows).toHaveLength(2);
    return {
      organization,
      ...person,
      identifiers: rows.map((row) => row.tokenIdentifier!),
      live,
    };
  };

  const noRowsLeft = async (person: {
    email: string;
    identifiers: string[];
  }) => {
    expect(await flow.requestsOf(person.email)).toEqual([]);
    for (const identifier of person.identifiers)
      expect(
        await fixture.db
          .select()
          .from(verifications)
          .where(eq(verifications.identifier, identifier)),
      ).toEqual([]);
  };

  /** The next holder of the address: a new user, who signs in with a new `sub`. */
  const nextHolderSignsIn = async (
    person: { email: string; userId: string },
    organization: { id: string; domain: string },
  ) => {
    const local = person.email.split("@")[0]!;
    const next = await flow.listed(organization, local);
    expect(next.userId).not.toBe(person.userId);
    const request = await flow.ask(next.email);
    expect(request.mail).toBeDefined();
    flow.signedIn(await flow.follow(request.token!, request.cookie));
    const [account] = await flow.accountsOf(next.userId);
    expect(account).toMatchObject({
      issuer: magicLinkIssuer,
      accountId: next.email,
    });
    return next;
  };

  test("retiring rewrites the account key and removes the address's rows, and the address can be listed again", async () => {
    const person = await seeded();
    await inPlatformUsers(fixture.db, (context) =>
      disableUser(context, person.userId),
    );
    await inPlatformUsers(fixture.db, (context) =>
      retireUserEmail(context, person.userId),
    );
    const [account] = await flow.accountsOf(person.userId);
    expect(account!.accountId).toBe(`retired:${account!.id}`);
    expect(account!.deletedAt).toBeNull();
    await noRowsLeft(person);
    // The old link died with its rows.
    const page = await flow.open(person.live.token!, person.live.cookie);
    expect(await page.text()).not.toContain(person.email);
    await nextHolderSignsIn(person, person.organization);
  });

  test("erasing does the same", async () => {
    const person = await seeded();
    await inPlatformWrite(fixture.db, (context) =>
      eraseUser(context, person.userId, person.userId),
    );
    const [account] = await flow.accountsOf(person.userId);
    expect(account!.accountId).toBe(`retired:${account!.id}`);
    expect(account!.deletedAt).not.toBeNull();
    await noRowsLeft(person);
    await nextHolderSignsIn(person, person.organization);
  });

  test("erasing someone already retired leaves the next holder's rows alone", async () => {
    const person = await seeded();
    await inPlatformUsers(fixture.db, (context) =>
      disableUser(context, person.userId),
    );
    await inPlatformUsers(fixture.db, (context) =>
      retireUserEmail(context, person.userId),
    );
    const next = await nextHolderSignsIn(person, person.organization);
    await inPlatformWrite(fixture.db, (context) =>
      eraseUser(context, person.userId, person.userId),
    );
    expect(await flow.requestsOf(next.email)).toHaveLength(1);
    expect((await flow.accountsOf(next.userId))[0]!.accountId).toBe(next.email);
  });

  test("other people's accounts and a person's directory account keep their keys", async () => {
    const organization = await firm(true);
    const person = await flow.directorySignIn(organization);
    const browser = "9".repeat(43);
    await fixture.mail.requests.process({
      address: person.email,
      browser,
      client: "203.0.113.20",
      pendingQuery: null,
    });
    const mail = fixture.mail.transport.sent.findLast(
      (message) => message.to === person.email,
    )!;
    const token = /\/magic-link\?token=([A-Za-z]+)/.exec(mail.text)![1]!;
    flow.signedIn(await flow.follow(token, `answerable-sign-in=${browser}`));
    const bystander = await flow.listed(organization);
    const other = createId();
    await fixture.db.insert(accounts).values({
      id: other,
      userId: bystander.userId,
      issuer: magicLinkIssuer,
      providerId: `magic-link:${organization.id}`,
      accountId: bystander.email,
    });
    await inPlatformUsers(fixture.db, (context) =>
      disableUser(context, person.userId),
    );
    await inPlatformUsers(fixture.db, (context) =>
      retireUserEmail(context, person.userId),
    );
    const held = await flow.accountsOf(person.userId);
    const directory = held.find((row) => row.issuer !== magicLinkIssuer)!;
    expect(directory.accountId).toBe(`${organization.slug}-person`);
    const [theirs] = await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, other));
    expect(theirs!.accountId).toBe(bystander.email);
  });
});
