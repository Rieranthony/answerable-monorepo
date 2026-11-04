import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import {
  browser,
  codeIn,
  openMagicLinkFixture,
  tokenIn,
  type MagicLinkFixture,
} from "../__tests__/magic-link-requests.ts";
import { liveMagicLinkRow } from "../__tests__/magic-link.ts";
import { retireUserEmail } from "../__tests__/user-queries.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { inTenant } from "../__tests__/tenant-command.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import { deleteSsoProvider } from "../db/queries/sso-providers.ts";
import { accounts, members, ssoProviders, users } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { deleteOrganizationDomain, disableDomain } from "./domains.ts";
import {
  admitMagicLink,
  parseMagicLinkAddress,
} from "./magic-link-admission.ts";
import { remove } from "./members.ts";
import {
  disableMagicLink,
  disableOrganization,
  enableMagicLink,
  eraseOrganization,
} from "./organizations.ts";
import { disableUser, eraseUser } from "./users.ts";

let fixture: MagicLinkFixture;
beforeAll(async () => {
  fixture = await openMagicLinkFixture();
});
afterAll(() => fixture?.close());

async function directoryOf(of: { id: string; slug: string; domain: string }) {
  return createSsoProvider(fixture.owner.db, {
    organizationId: of.id,
    providerId: of.slug,
    issuer: `https://${of.slug}.idp.example`,
    domain: of.domain,
    oidc: {
      clientId: `${of.slug}-client`,
      clientSecret: "secret",
      authorizationEndpoint: `https://${of.slug}.idp.example/authorize`,
      tokenEndpoint: `https://${of.slug}.idp.example/token`,
      jwksEndpoint: `https://${of.slug}.idp.example/jwks`,
    },
  });
}

/** The person's account with a provider row, as a directory sign-in writes it. */
async function accountWith(
  userId: string,
  provider: { providerId: string; issuer: string },
) {
  await fixture.owner.db.insert(accounts).values({
    id: createId(),
    userId,
    providerId: provider.providerId,
    issuer: provider.issuer,
    accountId: `subject-${createId()}`,
  });
}

/** Each state, as the command that makes it leaves it, and the address it is about. */
const strangers: Record<string, () => Promise<string>> = {
  "an address no user holds": async () =>
    `nobody@${(await fixture.firm()).domain}`,
  "a user with no membership here": async () =>
    (await fixture.person(await fixture.firm())).email,
  "a domain no firm has": async () => "person@nowhere.example.com",
  "a retired address": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await inPlatformUsers(fixture.owner.db, (context) =>
      disableUser(context, userId),
    );
    await retireUserEmail(fixture.owner.db, userId);
    return email;
  },
  "an erased user's address": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      eraseUser(context, userId, userId),
    );
    return email;
  },
  "a domain turned off": async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      disableDomain(context, firm.id, firm.domainId),
    );
    return email;
  },
  "a domain removed": async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      deleteOrganizationDomain(context, firm.id, firm.domainId),
    );
    return email;
  },
  "an organisation turned off": async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      disableOrganization(context, firm.id),
    );
    return email;
  },
  "an organisation erased": async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      eraseOrganization(context, firm.id, firm.id),
    );
    return email;
  },
  "magic links turned off": async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      disableMagicLink(context, firm.id),
    );
    return email;
  },
  "magic links turned off at a firm with a directory": async () => {
    const firm = await fixture.firm();
    await directoryOf(firm);
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      disableMagicLink(context, firm.id),
    );
    return email;
  },
  "a user soft-deleted with their address kept": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.person(firm);
    await fixture.owner.db
      .update(users)
      .set({
        status: "disabled",
        disabledAt: sql`now()`,
        deletedAt: sql`now()`,
      })
      .where(eq(users.id, userId));
    return email;
  },
  "a member of another firm only": async () => {
    const firm = await fixture.firm();
    const other = await fixture.firm();
    const { email, userId } = await fixture.person(firm);
    await fixture.owner.db
      .insert(members)
      .values({ id: createId(), organizationId: other.id, userId });
    return email;
  },
  "a removed person at a firm with magic links off": async () => {
    const firm = await fixture.firm();
    const { email, memberId } = await fixture.member(firm);
    await inTenant(fixture.owner.db, firm.id, (context) =>
      remove(context, memberId),
    );
    await inPlatformWrite(fixture.owner.db, (context) =>
      disableMagicLink(context, firm.id),
    );
    return email;
  },
  "a magic-link row soft-deleted": async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await fixture.owner.db
      .update(ssoProviders)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(ssoProviders.organizationId, firm.id),
          eq(ssoProviders.kind, "magic_link"),
        ),
      );
    return email;
  },
  "the platform organisation": async () => {
    const domain = `platform-${createId()}.example.com`;
    await fixture.owner.pool.query(
      `insert into organization_domains (id, organization_id, domain) values ('${createId()}', '${fixture.platform.organizationId}', '${domain}')`,
    );
    const { email } = await fixture.member({
      id: fixture.platform.organizationId,
      domain,
    });
    return email;
  },
  "a membership that has not started": async () => {
    const firm = await fixture.firm();
    return (
      await fixture.member(firm, "early", {
        validFrom: new Date(Date.now() + 3_600_000),
      })
    ).email;
  },
  "a membership that has ended": async () => {
    const firm = await fixture.firm();
    return (
      await fixture.member(firm, "late", {
        validUntil: new Date(Date.now() - 1_000),
      })
    ).email;
  },
  "another firm's directory account": async () => {
    const firm = await fixture.firm();
    const other = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(userId, await directoryOf(other));
    return email;
  },
  "another firm's removed directory's account": async () => {
    const firm = await fixture.firm();
    const other = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(userId, await directoryOf(other));
    await inPlatformWrite(fixture.owner.db, (context) =>
      deleteSsoProvider(context, other.id),
    );
    return email;
  },
  "another firm's magic-link account": async () => {
    const firm = await fixture.firm();
    const other = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(
      userId,
      (await liveMagicLinkRow(fixture.owner.db, other.id))!,
    );
    return email;
  },
  "an account no provider row names": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(userId, {
      providerId: "gone",
      issuer: "https://gone.example",
    });
    return email;
  },
};

const removed: Record<string, () => Promise<string>> = {
  "a revoked membership": async () => {
    const firm = await fixture.firm();
    const { email, memberId } = await fixture.member(firm);
    await inTenant(fixture.owner.db, firm.id, (context) =>
      remove(context, memberId),
    );
    return email;
  },
  "a revoked and soft-deleted membership": async () => {
    const firm = await fixture.firm();
    const { email, memberId } = await fixture.member(firm);
    await fixture.owner.db
      .update(members)
      .set({
        status: "revoked",
        revokedAt: sql`now()`,
        deletedAt: sql`now()`,
      })
      .where(eq(members.id, memberId));
    return email;
  },
  "a disabled user": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await inPlatformUsers(fixture.owner.db, (context) =>
      disableUser(context, userId),
    );
    return email;
  },
  "a disabled user with no membership here": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.person(firm);
    await inPlatformUsers(fixture.owner.db, (context) =>
      disableUser(context, userId),
    );
    return email;
  },
};

const admitted: Record<string, () => Promise<string>> = {
  "a member": async () => (await fixture.member(await fixture.firm())).email,
  "a membership inside its window": async () =>
    (
      await fixture.member(await fixture.firm(), "windowed", {
        validFrom: new Date(Date.now() - 3_600_000),
        validUntil: new Date(Date.now() + 3_600_000),
      })
    ).email,
  "this firm's directory account": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(userId, await directoryOf(firm));
    return email;
  },
  "this firm's removed directory's account": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(userId, await directoryOf(firm));
    await inPlatformWrite(fixture.owner.db, (context) =>
      deleteSsoProvider(context, firm.id),
    );
    return email;
  },
  "this firm's own magic-link account": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await accountWith(
      userId,
      (await liveMagicLinkRow(fixture.owner.db, firm.id))!,
    );
    return email;
  },
  "a soft-deleted account of another firm": async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    const other = await fixture.firm();
    await accountWith(userId, await directoryOf(other));
    await fixture.owner.db
      .update(accounts)
      .set({ deletedAt: sql`now()` })
      .where(eq(accounts.userId, userId));
    return email;
  },
  "a firm with a directory as well": async () => {
    const firm = await fixture.firm();
    await directoryOf(firm);
    return (await fixture.member(firm)).email;
  },
  "an account of another person at another firm, which is theirs": async () => {
    const firm = await fixture.firm();
    const other = await fixture.firm();
    const stranger = await fixture.member(other);
    await accountWith(stranger.userId, await directoryOf(other));
    return (await fixture.member(firm)).email;
  },
};

describe("sent and stored, for each state", () => {
  test.each(Object.keys(strangers))(
    "%s: nothing is sent and nothing is written",
    async (state) => {
      const email = await strangers[state]!();
      const verifications = (await fixture.magicLinkVerifications()).length;
      expect(await fixture.ask(email)).toEqual({ outcome: "stranger" });
      expect(fixture.mailsTo(email)).toEqual([]);
      expect(await fixture.rows(email)).toEqual([]);
      expect(await fixture.magicLinkVerifications()).toHaveLength(
        verifications,
      );
    },
  );

  test.each(Object.keys(removed))(
    "%s: asks as a stranger does, and nothing is sent or written",
    async (state) => {
      const email = await removed[state]!();
      const verifications = (await fixture.magicLinkVerifications()).length;
      expect(await fixture.ask(email)).toEqual({ outcome: "stranger" });
      expect(fixture.mailsTo(email)).toEqual([]);
      expect(await fixture.rows(email)).toEqual([]);
      expect(await fixture.magicLinkVerifications()).toHaveLength(
        verifications,
      );
    },
  );

  test.each(Object.keys(admitted))(
    "%s: one mail with a link and a code, and a row",
    async (state) => {
      const email = await admitted[state]!();
      const outcome = await fixture.ask(email);
      expect(outcome).toMatchObject({ outcome: "sent", purpose: "link" });
      const mail = fixture.mailsTo(email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.tag).toBe("sign-in");
      expect(tokenIn(mail[0]!)).toBeDefined();
      expect(codeIn(mail[0]!)).toMatch(/^\d{8}$/);
      const rows = await fixture.rows(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: "link", sendStatus: "sent" });
      expect(rows[0]!.browserHash).not.toBeNull();
      expect(rows[0]!.codeHmac).not.toBeNull();
    },
  );

  test("the mail names the firm, the row names the organisation and the row's revision at issue", async () => {
    const firm = await fixture.firm("Named & Partners");
    const { email } = await fixture.member(firm);
    await inPlatformWrite(fixture.owner.db, (context) =>
      disableMagicLink(context, firm.id),
    );
    await inPlatformWrite(fixture.owner.db, (context) =>
      enableMagicLink(context, firm.id),
    );
    const provider = (await liveMagicLinkRow(fixture.owner.db, firm.id))!;
    expect(provider.revision).toBe(4);
    await fixture.ask(email);
    const [row] = await fixture.rows(email);
    expect(row).toMatchObject({
      organizationId: firm.id,
      providerId: provider.id,
      providerRevision: 4,
    });
    const [mail] = fixture.mailsTo(email);
    expect(mail!.subject).toBe("Sign in to Named & Partners");
    expect(mail!.html).toContain("Named &amp; Partners");
  });
});

describe("what admission answers", () => {
  const admission = (email: string) =>
    fixture.runtime.db.transaction(async (tx) => {
      await setDatabaseScope(tx, { kind: "protocol" });
      return admitMagicLink(tx, parseMagicLinkAddress(email)!);
    });

  test("admit names the user, the member and the row, for confirm to use", async () => {
    const firm = await fixture.firm();
    const { email, userId, memberId } = await fixture.member(firm);
    const provider = (await liveMagicLinkRow(fixture.owner.db, firm.id))!;
    expect(await admission(email)).toEqual({
      outcome: "admit",
      person: { kind: "member", userId, memberId },
      organizationId: firm.id,
      firmName: firm.name,
      providerId: provider.id,
      providerRevision: provider.revision,
    });
  });

  test("removed says only that", async () => {
    const firm = await fixture.firm();
    const { email, userId } = await fixture.member(firm);
    await inPlatformUsers(fixture.owner.db, (context) =>
      disableUser(context, userId),
    );
    expect(await admission(email)).toEqual({ outcome: "removed" });
  });

  test.each([
    ["domain", "organization_domains", "organization_domains_deleted_check"],
    ["organisation", "organizations", "organizations_deleted_check"],
  ] as const)(
    "a soft-deleted %s is out even with a status that says active, which a check otherwise refuses",
    async (_, table, constraint) => {
      const firm = await fixture.firm();
      const { email } = await fixture.member(firm);
      await expect(
        fixture.owner.db.transaction(async (tx) => {
          const target = table === "organizations" ? firm.id : firm.domainId;
          await tx.execute(
            sql.raw(`alter table ${table} drop constraint ${constraint}`),
          );
          // A live child stands in the way of a live key: only the parent's own row moves.
          await tx.execute(
            sql.raw(
              `alter table organization_domains drop constraint organization_domains_organization_live_fk;
               alter table members drop constraint members_organization_live_fk;
               alter table sso_providers drop constraint sso_providers_organization_live_fk;`,
            ),
          );
          await tx.execute(
            sql.raw(
              `update ${table} set deleted_at = now() where id = '${target}'`,
            ),
          );
          throw Object.assign(new Error("roll back"), {
            outcome: await admitMagicLink(tx, parseMagicLinkAddress(email)!),
          });
        }),
      ).rejects.toMatchObject({ outcome: { outcome: "stranger" } });
    },
  );

  test("without a protocol scope RLS hides the member, so it fails closed", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const outcome = await fixture.runtime.db.transaction((tx) =>
      admitMagicLink(tx, parseMagicLinkAddress(email)!),
    );
    expect(outcome).toEqual({ outcome: "stranger" });
  });

  test("the address's case and surrounding space reach one holder", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await fixture.ask(`  ${email.toUpperCase()}\n`);
    expect(fixture.mailsTo(email)).toHaveLength(1);
    expect(await fixture.rows(email)).toHaveLength(1);
  });

  test("a subdomain of a listed domain is a stranger", async () => {
    const firm = await fixture.firm();
    await fixture.member(firm);
    const email = `person@sub.${firm.domain}`;
    await fixture.owner.db.insert(users).values({
      id: createId(),
      name: "Sub",
      email,
      status: "active",
    });
    expect(await fixture.ask(email)).toEqual({ outcome: "stranger" });
  });

  test("a browser value is stored only as its hash", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await fixture.ask(email);
    const [row] = await fixture.rows(email);
    expect(JSON.stringify(row)).not.toContain(browser);
  });
});
