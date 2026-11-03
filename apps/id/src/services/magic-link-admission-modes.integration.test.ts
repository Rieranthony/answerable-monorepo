import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { liveMagicLinkRow } from "../__tests__/magic-link.ts";
import {
  openMagicLinkFixture,
  type MagicLinkFixture,
} from "../__tests__/magic-link-requests.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import { inTenant } from "../__tests__/tenant-command.ts";
import { retireUserEmail } from "../__tests__/user-queries.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import {
  accounts,
  magicLinkRequests,
  organizationDomains,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { disableDomain } from "./domains.ts";
import {
  admitMagicLink,
  parseMagicLinkAddress,
  usersWithForeignAccounts,
} from "./magic-link-admission.ts";
import { remove } from "./members.ts";
import { disableMagicLink, disableOrganization } from "./organizations.ts";
import { disableUser } from "./users.ts";

let fixture: MagicLinkFixture;
beforeAll(async () => {
  fixture = await openMagicLinkFixture();
});
afterAll(() => fixture?.close());

type Firm = Awaited<ReturnType<MagicLinkFixture["firm"]>>;
/** What the two settings can be. `unproved` is domain mode, with this address's domain not
 * proved: one added after the switch. */
const modes = {
  listed: { admission: "listed", proved: true },
  domain: { admission: "domain", proved: true },
  unproved: { admission: "domain", proved: false },
} as const;
type Mode = keyof typeof modes;

/** The settings written directly: this file is about what admission reads. */
async function setMode(firm: Firm, mode: Mode) {
  const { admission, proved } = modes[mode];
  await fixture.owner.db
    .update(ssoProviders)
    .set({ admission })
    .where(
      and(
        eq(ssoProviders.organizationId, firm.id),
        eq(ssoProviders.kind, "magic_link"),
      ),
    );
  if (proved)
    await fixture.owner.db
      .update(organizationDomains)
      .set({ verifiedAt: sql`now()` })
      .where(eq(organizationDomains.id, firm.domainId));
}

const admission = (email: string) =>
  fixture.runtime.db.transaction(async (tx) => {
    await setDatabaseScope(tx, { kind: "protocol" });
    return admitMagicLink(tx, parseMagicLinkAddress(email)!);
  });

/** The person's account with a provider row, as a directory sign-in writes it. */
const accountWith = (
  userId: string,
  provider: { providerId: string; issuer: string },
) =>
  fixture.owner.db.insert(accounts).values({
    id: createId(),
    userId,
    providerId: provider.providerId,
    issuer: provider.issuer,
    accountId: `subject-${createId()}`,
  });

const directoryOf = (of: { id: string; slug: string; domain: string }) =>
  createSsoProvider(fixture.owner.db, {
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

type Expected = "stranger" | "removed" | "member" | "user" | "new";
type Row = {
  /** Each state, as the command that makes it leaves it, and the address it is about. */
  make: (firm: Firm) => Promise<string>;
  /** Asserted identically in listed mode, in domain mode and on an unproved domain. */
  all?: Expected;
  listed?: Expected;
  domain?: Expected;
  unproved?: Expected;
};

const memberOf = async (firm: Firm) => fixture.member(firm);

const table: Record<string, Row> = {
  "no user yet": {
    make: async (firm) => `new-${createId()}@${firm.domain}`,
    listed: "stranger",
    domain: "new",
    unproved: "stranger",
  },
  "a user with no membership here": {
    make: async (firm) => (await fixture.person(firm)).email,
    listed: "stranger",
    domain: "user",
    unproved: "stranger",
  },
  "a user with an account of this firm's directory and no membership": {
    make: async (firm) => {
      const { email, userId } = await fixture.person(firm);
      await accountWith(userId, await directoryOf(firm));
      return email;
    },
    listed: "stranger",
    domain: "user",
    unproved: "stranger",
  },
  "a user with a membership at another firm only": {
    make: async (firm) => {
      const { email, userId } = await fixture.person(firm);
      await fixture.owner.pool.query(
        `insert into members (id, organization_id, user_id) values ('${createId()}', '${(await fixture.firm()).id}', '${userId}')`,
      );
      return email;
    },
    listed: "stranger",
    domain: "user",
    unproved: "stranger",
  },
  "an effective member": {
    make: async (firm) => (await memberOf(firm)).email,
    all: "member",
  },
  "a member inside their window": {
    make: async (firm) =>
      (
        await fixture.member(firm, "windowed", {
          validFrom: new Date(Date.now() - 3_600_000),
          validUntil: new Date(Date.now() + 3_600_000),
        })
      ).email,
    all: "member",
  },
  "a revoked member": {
    make: async (firm) => {
      const { email, memberId } = await memberOf(firm);
      await inTenant(fixture.owner.db, firm.id, (context) =>
        remove(context, memberId),
      );
      return email;
    },
    all: "removed",
  },
  "a disabled user who is a member": {
    make: async (firm) => {
      const { email, userId } = await memberOf(firm);
      await inPlatformUsers(fixture.owner.db, (context) =>
        disableUser(context, userId),
      );
      return email;
    },
    all: "removed",
  },
  "a disabled user with no membership here": {
    make: async (firm) => {
      const { email, userId } = await fixture.person(firm);
      await inPlatformUsers(fixture.owner.db, (context) =>
        disableUser(context, userId),
      );
      return email;
    },
    all: "removed",
  },
  // Its address is free again, so a person new to this address is what the mode says.
  "a retired user's old address": {
    make: async (firm) => {
      const { email, userId } = await memberOf(firm);
      await inPlatformUsers(fixture.owner.db, (context) =>
        disableUser(context, userId),
      );
      await retireUserEmail(fixture.owner.db, userId);
      return email;
    },
    listed: "stranger",
    domain: "new",
    unproved: "stranger",
  },
  "a retired user's tombstone address, at a firm that lists that domain": {
    make: async (firm) => {
      const { userId } = await memberOf(firm);
      await inPlatformUsers(fixture.owner.db, (context) =>
        disableUser(context, userId),
      );
      await retireUserEmail(fixture.owner.db, userId);
      await fixture.owner.pool.query(
        "delete from organization_domains where domain = 'retired.invalid'",
      );
      await fixture.owner.pool.query(
        `insert into organization_domains (id, organization_id, domain, verified_at) values ('${createId()}', '${firm.id}', 'retired.invalid', now())`,
      );
      return `${userId}@retired.invalid`;
    },
    all: "stranger",
  },
  "a membership that has ended": {
    make: async (firm) =>
      (
        await fixture.member(firm, "late", {
          validUntil: new Date(Date.now() - 1_000),
        })
      ).email,
    all: "stranger",
  },
  "a membership that has not started": {
    make: async (firm) =>
      (
        await fixture.member(firm, "early", {
          validFrom: new Date(Date.now() + 3_600_000),
        })
      ).email,
    all: "stranger",
  },
  "a user with another firm's directory account and no membership": {
    make: async (firm) => {
      const { email, userId } = await fixture.person(firm);
      await accountWith(userId, await directoryOf(await fixture.firm()));
      return email;
    },
    all: "stranger",
  },
  "a user with another firm's magic-link account and no membership": {
    make: async (firm) => {
      const { email, userId } = await fixture.person(firm);
      const other = await fixture.firm();
      await accountWith(
        userId,
        (await liveMagicLinkRow(fixture.owner.db, other.id))!,
      );
      return email;
    },
    all: "stranger",
  },
  "a member with another firm's directory account": {
    make: async (firm) => {
      const { email, userId } = await memberOf(firm);
      await accountWith(userId, await directoryOf(await fixture.firm()));
      return email;
    },
    all: "stranger",
  },
  "a user whose account no provider row names": {
    make: async (firm) => {
      const { email, userId } = await fixture.person(firm);
      await accountWith(userId, {
        providerId: "gone",
        issuer: "https://gone.example",
      });
      return email;
    },
    all: "stranger",
  },
  "a domain turned off": {
    make: async (firm) => {
      const { email } = await memberOf(firm);
      await inPlatformWrite(fixture.owner.db, (context) =>
        disableDomain(context, firm.id, firm.domainId),
      );
      return email;
    },
    all: "stranger",
  },
  "magic links turned off": {
    make: async (firm) => {
      await inPlatformWrite(fixture.owner.db, (context) =>
        disableMagicLink(context, firm.id),
      );
      return `new-${createId()}@${firm.domain}`;
    },
    all: "stranger",
  },
  "an organisation turned off": {
    make: async (firm) => {
      await inPlatformWrite(fixture.owner.db, (context) =>
        disableOrganization(context, firm.id),
      );
      return `new-${createId()}@${firm.domain}`;
    },
    all: "stranger",
  },
};

const outcomeOf = async (email: string): Promise<Expected> => {
  const answer = await admission(email);
  if (answer.outcome !== "admit") return answer.outcome;
  return answer.person.kind;
};

describe("who may have a link, in each mode", () => {
  for (const [name, row] of Object.entries(table))
    for (const mode of Object.keys(modes) as Mode[])
      test(`${name}, ${mode}: ${row.all ?? row[mode]}`, async () => {
        const firm = await fixture.firm();
        // The setting first: a state such as a domain turned off comes after it.
        await setMode(firm, mode);
        const email = await row.make(firm);
        expect(await outcomeOf(email)).toBe((row.all ?? row[mode])!);
      });

  test("public mail is a stranger in every mode, a listed member with a proved row included", async () => {
    // A row older than the list, proved, in domain mode, with a member at it.
    for (const mode of Object.keys(modes) as Mode[]) {
      const firm = await fixture.firm();
      const domain = "proton.me";
      await fixture.owner.db
        .delete(magicLinkRequests)
        .where(eq(magicLinkRequests.organizationId, firm.id));
      await fixture.owner.pool.query(
        "delete from organization_domains where domain = 'proton.me'",
      );
      await fixture.owner.pool.query(
        `insert into organization_domains (id, organization_id, domain, verified_at) values ('${createId()}', '${firm.id}', '${domain}', now())`,
      );
      await setMode(firm, mode);
      const member = await fixture.owner.pool.query(
        "delete from users where email = 'person@proton.me'",
      );
      expect(member.rowCount).toBeLessThanOrEqual(1);
      const { email } = await fixture.member({ id: firm.id, domain });
      expect(await outcomeOf(email), mode).toBe("stranger");
      expect(await outcomeOf(`new@${domain}`), mode).toBe("stranger");
    }
  });

  test("the platform organisation admits nobody, in domain mode on a proved domain included", async () => {
    const domain = `platform-${createId()}.example.com`;
    await fixture.owner.pool.query(
      `insert into organization_domains (id, organization_id, domain, verified_at) values ('${createId()}', '${fixture.platform.organizationId}', '${domain}', now())`,
    );
    const { email } = await fixture.member({
      id: fixture.platform.organizationId,
      domain,
    });
    expect(await outcomeOf(email)).toBe("stranger");
    expect(await outcomeOf(`new@${domain}`)).toBe("stranger");
  });

  test("a domain added after the switch admits nobody new, per address, while the proved one still does", async () => {
    const firm = await fixture.firm();
    await setMode(firm, "domain");
    const later = `later-${createId()}.example.com`;
    await createOrganizationDomain(fixture.owner.db, {
      organizationId: firm.id,
      domain: later,
    });
    expect(await outcomeOf(`new@${firm.domain}`)).toBe("new");
    expect(await outcomeOf(`new@${later}`)).toBe("stranger");
    const person = await fixture.person({ domain: later });
    expect(await outcomeOf(person.email)).toBe("stranger");
    const { email } = await fixture.member({ id: firm.id, domain: later }, "m");
    expect(await outcomeOf(email)).toBe("member");
  });

  test("the answer names the person only by what exists, and a new person by nothing", async () => {
    const firm = await fixture.firm();
    await setMode(firm, "domain");
    const provider = (await liveMagicLinkRow(fixture.owner.db, firm.id))!;
    const row = {
      outcome: "admit",
      organizationId: firm.id,
      firmName: firm.name,
      providerId: provider.id,
      providerRevision: provider.revision,
    };
    expect(await admission(`new@${firm.domain}`)).toEqual({
      ...row,
      person: { kind: "new" },
    } as never);
    const { email, userId } = await fixture.person(firm);
    expect(await admission(email)).toEqual({
      ...row,
      person: { kind: "user", userId },
    } as never);
    const member = await fixture.member(firm, "member");
    expect(await admission(member.email)).toEqual({
      ...row,
      person: {
        kind: "member",
        userId: member.userId,
        memberId: member.memberId,
      },
    } as never);
  });

  test("usersWithForeignAccounts names only those with another firm's account, or one no row names", async () => {
    const firm = await fixture.firm();
    const mine = await fixture.person(firm, "mine");
    await accountWith(mine.userId, await directoryOf(firm));
    const theirs = await fixture.person(firm, "theirs");
    await accountWith(theirs.userId, await directoryOf(await fixture.firm()));
    const orphan = await fixture.person(firm, "orphan");
    await accountWith(orphan.userId, {
      providerId: "gone",
      issuer: "https://gone.example",
    });
    const removedAccount = await fixture.person(firm, "removed-account");
    await accountWith(removedAccount.userId, {
      providerId: "gone",
      issuer: "https://gone-too.example",
    });
    await fixture.owner.db
      .update(accounts)
      .set({ deletedAt: sql`now()`, refreshToken: null })
      .where(eq(accounts.userId, removedAccount.userId));
    const none = await fixture.person(firm, "none");
    const found = await fixture.owner.db.transaction((tx) =>
      usersWithForeignAccounts(
        tx,
        [
          mine.userId,
          theirs.userId,
          orphan.userId,
          removedAccount.userId,
          none.userId,
        ],
        firm.id,
      ),
    );
    expect([...found].sort()).toEqual([theirs.userId, orphan.userId].sort());
    expect(
      await fixture.owner.db.transaction((tx) =>
        usersWithForeignAccounts(tx, [], firm.id),
      ),
    ).toEqual(new Set());
  });
});

describe("the database holds the setting to its vocabulary", () => {
  const attempt = (query: PromiseLike<unknown>) => Promise.resolve(query);

  test("admission is listed or domain", async () => {
    const firm = await fixture.firm();
    await expect(
      attempt(
        fixture.owner.pool.query(
          `update sso_providers set admission = 'anyone' where organization_id = '${firm.id}'`,
        ),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "sso_providers_admission_check",
    });
  });

  test("a row that is not a magic link stays listed", async () => {
    const firm = await fixture.firm();
    const directory = await directoryOf(firm);
    await expect(
      attempt(
        fixture.owner.db
          .update(ssoProviders)
          .set({ admission: "domain" })
          .where(eq(ssoProviders.id, directory.id)),
      ),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "sso_providers_admission_kind_check",
      },
    });
    const [row] = await fixture.owner.db
      .select({ admission: ssoProviders.admission })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, directory.id));
    expect(row).toEqual({ admission: "listed" });
  });

  test("a new row and every new domain start with the least: listed, a token of their own and no proof", async () => {
    const firm = await fixture.firm();
    expect(await liveMagicLinkRow(fixture.owner.db, firm.id)).toMatchObject({
      admission: "listed",
    });
    const second = await fixture.firm();
    const domains = await fixture.owner.db
      .select()
      .from(organizationDomains)
      .where(
        sql`${organizationDomains.id} in (${firm.domainId}, ${second.domainId})`,
      );
    expect(domains.map((row) => row.verifiedAt)).toEqual([null, null]);
    const [a, b] = domains.map((row) => row.verificationToken);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("users are untouched by a stranger's admission", async () => {
    const firm = await fixture.firm();
    await setMode(firm, "domain");
    const email = `new-${createId()}@${firm.domain}`;
    await admission(email);
    expect(
      await fixture.owner.db.select().from(users).where(eq(users.email, email)),
    ).toEqual([]);
  });
});
