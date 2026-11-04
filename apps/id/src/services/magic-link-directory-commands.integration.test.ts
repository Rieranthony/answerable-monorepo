import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { tenantAuthentication } from "../auth/tenant-authentication.ts";
import {
  auditEvents,
  grantContexts,
  sessions,
  ssoProviders,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { disableOrganization } from "./organizations.ts";
import { deleteSsoProvider, putSsoProvider } from "./sso-providers.ts";
import { eraseUser } from "./users.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  fixture = await createAdminFixture(
    {},
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
  await flow.registerClient();
});
afterAll(() => fixture?.close());

let nextFirm = 0;
async function firm(directory = true) {
  const of = await flow.seedOrganization(
    `directory-commands-${++nextFirm}`,
    directory,
  );
  await flow.allowClient(of.id);
  return of;
}
type Firm = Awaited<ReturnType<typeof firm>>;

/** One person with a live grant from a link, and their session. */
async function byLink(of: Firm) {
  const person = await flow.listed(of);
  const asked = await flow.ask(person.email, { method: "link" });
  const cookie = flow.signedIn(await flow.follow(asked.token!, asked.cookie));
  const tokens = await flow.issueTokens(cookie, person.memberId);
  return { ...person, cookie, tokens };
}

/** One person with a live grant from the firm's directory, and their session. */
async function byDirectory(of: Firm) {
  const person = await flow.directorySignIn(
    of,
    { providerId: of.slug },
    `directory-${createId()}`,
  );
  const tokens = await flow.issueTokens(person.cookie, person.memberId);
  return { ...person, tokens };
}

const stands = async (of: Firm, userId: string) => {
  const [session] = await flow.sessionsOf(userId);
  return (
    (await tenantAuthentication(fixture.db, {
      userId,
      sessionId: session!.id,
      organizationId: of.id,
    })) !== null
  );
};

const refreshes = async (token: string) => {
  const renewed = await flow.refresh(token);
  return renewed.status === 200
    ? ((await renewed.json()) as { refresh_token: string }).refresh_token
    : null;
};

const grantsOf = (userId: string) =>
  fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.userId, userId));

async function lastEvent(of: Firm, action: string) {
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, of.id),
        eq(auditEvents.action, action),
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(1);
  return event!;
}

const change = (of: Firm) =>
  inPlatformWrite(fixture.db, (context) =>
    putSsoProvider(context, of.id, {
      ...flow.directoryInput(of.slug),
      domain: `changed-${createId()}.${of.domain}`,
    }),
  );

describe("a directory command ends directory grants only", () => {
  test("connecting a directory for the first time: a magic-link grant still refreshes, and the audit lists nothing ended", async () => {
    const of = await firm(false);
    const person = await byLink(of);
    await inPlatformWrite(fixture.db, (context) =>
      putSsoProvider(context, of.id, flow.directoryInput(of.slug)),
    );
    expect(await refreshes(person.tokens.refresh_token)).not.toBeNull();
    expect(await stands(of, person.userId)).toBe(true);
    const event = await lastEvent(of, "sso_provider.created");
    expect((event.data as { effects: unknown }).effects).toEqual({
      revokedGrantContexts: [],
    });
    const [grant] = await grantsOf(person.userId);
    expect(grant!.revokedAt).toBeNull();
  });

  test("changing it: the directory's grant and session end, the link's do not, and the audit lists only what ended", async () => {
    const of = await firm();
    const viaLink = await byLink(of);
    const viaDirectory = await byDirectory(of);
    const [directoryGrant] = await grantsOf(viaDirectory.userId);
    await change(of);
    expect(await refreshes(viaLink.tokens.refresh_token)).not.toBeNull();
    expect(await stands(of, viaLink.userId)).toBe(true);
    expect(await refreshes(viaDirectory.tokens.refresh_token)).toBeNull();
    expect(await stands(of, viaDirectory.userId)).toBe(false);
    const event = await lastEvent(of, "sso_provider.updated");
    expect((event.data as { effects: unknown }).effects).toEqual({
      revokedGrantContexts: [
        { id: directoryGrant!.id, userId: viaDirectory.userId },
      ],
    });
  });

  test("removing it: the same, and an account of this directory then stands in nobody's way of a link", async () => {
    const of = await firm();
    const viaLink = await byLink(of);
    const viaDirectory = await byDirectory(of);
    const [directoryGrant] = await grantsOf(viaDirectory.userId);
    await inPlatformWrite(fixture.db, (context) =>
      deleteSsoProvider(context, of.id),
    );
    expect(await refreshes(viaLink.tokens.refresh_token)).not.toBeNull();
    expect(await stands(of, viaLink.userId)).toBe(true);
    expect(await refreshes(viaDirectory.tokens.refresh_token)).toBeNull();
    expect(await stands(of, viaDirectory.userId)).toBe(false);
    const event = await lastEvent(of, "sso_provider.deleted");
    expect((event.data as { effects: unknown }).effects).toEqual({
      revokedGrantContexts: [
        { id: directoryGrant!.id, userId: viaDirectory.userId },
      ],
    });
    const asked = await flow.ask(viaDirectory.email);
    expect(asked.mail).toBeDefined();
    flow.signedIn(await flow.follow(asked.token!, asked.cookie));
  });

  test("an unchanged command ends nothing", async () => {
    const of = await firm();
    const viaDirectory = await byDirectory(of);
    const result = await inPlatformWrite(fixture.db, (context) =>
      putSsoProvider(context, of.id, flow.directoryInput(of.slug)),
    );
    expect(result.changed).toBe(false);
    expect(await refreshes(viaDirectory.tokens.refresh_token)).not.toBeNull();
  });

  test("what stays is this firm's own magic-link origin: another firm's row buys a grant nothing here", async () => {
    const of = await firm();
    const elsewhere = await firm();
    const person = await byDirectory(of);
    // No flow makes this, since a grant's session is its own firm's. It says what the rule is.
    const [grant] = await grantsOf(person.userId);
    const id = createId();
    await fixture.db.insert(grantContexts).values({
      ...grant!,
      id,
      authorizationCodeId: createId(),
      authenticationProviderId: elsewhere.magicLink.id,
    });
    await change(of);
    for (const row of await grantsOf(person.userId))
      expect(row.revokedAt, row.id).not.toBeNull();
  });

  test("another firm's grants of either kind, and another firm's magic-link row, are not this command's", async () => {
    const of = await firm();
    const elsewhere = await firm();
    const viaLink = await byLink(elsewhere);
    const viaDirectory = await byDirectory(elsewhere);
    const mine = await byDirectory(of);
    await change(of);
    expect(await refreshes(viaLink.tokens.refresh_token)).not.toBeNull();
    expect(await refreshes(viaDirectory.tokens.refresh_token)).not.toBeNull();
    expect(await refreshes(mine.tokens.refresh_token)).toBeNull();
  });

  test("a person with both keeps the link's grant through a directory change", async () => {
    const of = await firm();
    const person = await byDirectory(of);
    const asked = await flow.ask(person.email, { method: "link" });
    const cookie = flow.signedIn(await flow.follow(asked.token!, asked.cookie));
    const viaLink = await flow.issueTokens(cookie, person.memberId);
    await change(of);
    expect(await refreshes(viaLink.refresh_token)).not.toBeNull();
    expect(await refreshes(person.tokens.refresh_token)).toBeNull();
    const rows = await fixture.db
      .select({
        kind: ssoProviders.kind,
        revokedAt: grantContexts.revokedAt,
      })
      .from(grantContexts)
      .innerJoin(
        ssoProviders,
        eq(ssoProviders.id, grantContexts.authenticationProviderId),
      )
      .where(eq(grantContexts.userId, person.userId));
    for (const row of rows)
      expect(row.revokedAt === null).toBe(row.kind === "magic_link");
    expect(
      await fixture.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, person.userId)),
    ).toHaveLength(2);
  });
});

describe("what ends a whole firm or a whole person still ends everything", () => {
  test("disabling the organisation revokes both kinds of grant", async () => {
    const of = await firm();
    const viaLink = await byLink(of);
    const viaDirectory = await byDirectory(of);
    await inPlatformWrite(fixture.db, (context) =>
      disableOrganization(context, of.id),
    );
    for (const { userId } of [viaLink, viaDirectory]) {
      const [grant] = await grantsOf(userId);
      expect(grant!.revokedAt).not.toBeNull();
    }
    expect(await refreshes(viaLink.tokens.refresh_token)).toBeNull();
    expect(await refreshes(viaDirectory.tokens.refresh_token)).toBeNull();
  });

  test("erasing a person revokes both of theirs", async () => {
    const of = await firm();
    const person = await byDirectory(of);
    const asked = await flow.ask(person.email, { method: "link" });
    const cookie = flow.signedIn(await flow.follow(asked.token!, asked.cookie));
    await flow.issueTokens(cookie, person.memberId);
    await inPlatformWrite(fixture.db, (context) =>
      eraseUser(context, person.userId, person.userId),
    );
    const grants = await grantsOf(person.userId);
    expect(grants).toHaveLength(2);
    for (const grant of grants) expect(grant.revokedAt).not.toBeNull();
  });
});
