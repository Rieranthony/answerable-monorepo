import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { inTenant } from "../__tests__/tenant-command.ts";
import type { Executor } from "../db/client.ts";
import { lockOrganization } from "../db/locks.ts";
import {
  accounts,
  grantContexts,
  magicLinkRequests,
  organizationDomains,
  organizations,
  sessions,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import {
  deleteOrganizationDomain,
  disableDomain,
} from "../services/domains.ts";
import * as memberService from "../services/members.ts";
import {
  disableMagicLink,
  disableOrganization,
} from "../services/organizations.ts";
import { lockMagicLinkAddress } from "../services/magic-link-requests.ts";
import { disableUser, eraseUser } from "../services/users.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  // Enough connections that a wait here is a lock and not the pool.
  fixture = await createAdminFixture(
    { databasePoolMax: 10, databaseConnectionTimeoutMs: 5_000 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
});
afterAll(() => fixture?.close());

const rounds = Number(process.env.MAGIC_LINK_RACE_ROUNDS ?? 6);
// A confirmation takes more statements to reach its locks than a command does. These spreads
// let a confirmation that started first often commit first, and keep some rounds overlapping.
const confirmationLeadMs = [0, 8, 20, 40, 70, 110];
const commandLeadMs = [0, 0, 1, 2, 4, 8];
let nextFirm = 0;

type Person = Awaited<ReturnType<typeof ready>>;

async function ready() {
  const organization = await flow.seedOrganization(
    `races-${++nextFirm}`,
    false,
  );
  const person = await flow.listed(organization);
  const request = await flow.ask(person.email);
  const [domain] = await fixture.db
    .select({ id: organizationDomains.id })
    .from(organizationDomains)
    .where(eq(organizationDomains.domain, organization.domain));
  return { organization, ...person, ...request, domainId: domain!.id };
}

/** A session this person holds that still has standing at their firm. */
async function survivingAuthority(person: Person) {
  const rows = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, person.userId));
  const standing = await Promise.all(
    rows.map((row) =>
      tenantAuthentication(fixture.db, {
        userId: person.userId,
        sessionId: row.id,
        organizationId: person.organization.id,
      }),
    ),
  );
  return standing.filter((row) => row !== null);
}

const commands: Record<string, (person: Person) => Promise<unknown>> = {
  "links off": (person) =>
    inPlatformWrite(fixture.db, (context) =>
      disableMagicLink(context, person.organization.id),
    ),
  "organisation disabled": (person) =>
    inPlatformWrite(fixture.db, (context) =>
      disableOrganization(context, person.organization.id),
    ),
  "domain disabled": (person) =>
    inPlatformWrite(fixture.db, (context) =>
      disableDomain(context, person.organization.id, person.domainId),
    ),
  "domain removed": (person) =>
    inPlatformWrite(fixture.db, (context) =>
      deleteOrganizationDomain(
        context,
        person.organization.id,
        person.domainId,
      ),
    ),
  "member removed": (person) =>
    inTenant(fixture.db, person.organization.id, (context) =>
      memberService.remove(context, person.memberId),
    ),
  "user disabled": (person) =>
    inPlatformUsers(fixture.db, (context) =>
      disableUser(context, person.userId),
    ),
  "user erased": (person) =>
    inPlatformWrite(fixture.db, (context) =>
      eraseUser(context, person.userId, person.userId),
    ),
};

const totals = { signInFirst: 0, commandFirst: 0 };

for (const [name, command] of Object.entries(commands))
  for (const [order, confirmFirst] of [
    ["confirmation started first", true],
    ["command started first", false],
  ] as const)
    test(`${name}, ${order}: no surviving authority, no deadlock and no lock timeout`, async () => {
      const lines: string[] = [];
      const { error } = console;
      console.error = (...args: unknown[]) => void lines.push(args.join(" "));
      try {
        for (let round = 0; round < rounds; round++) {
          const person = await ready();
          const answers = confirmFirst
            ? [
                flow.follow(person.token!, person.cookie),
                Bun.sleep(
                  confirmationLeadMs[round % confirmationLeadMs.length]!,
                ).then(() => command(person)),
              ]
            : [
                command(person),
                Bun.sleep(commandLeadMs[round % commandLeadMs.length]!).then(
                  () => flow.follow(person.token!, person.cookie),
                ),
              ];
          // A command that lost a lock wait would reject this.
          const settled = await Promise.all(answers);
          const response = settled.find(
            (value) => value instanceof Response,
          ) as Response;
          if (response.status === 303) totals.signInFirst++;
          else totals.commandFirst++;
          expect([200, 303]).toContain(response.status);
          expect(await survivingAuthority(person)).toEqual([]);
        }
      } finally {
        console.error = error;
      }
      // Each process's failure lines hold the SQLSTATE: 40P01 and 55P03 would show here.
      expect(
        lines.filter((line) => line.includes("page_auth_call_failed")),
      ).toEqual([]);
    });

test("both orders were seen", () => {
  console.log("[races]", JSON.stringify({ rounds, ...totals }));
  // A few rounds can fall all one way, which would say nothing about the code.
  if (rounds < 6) return;
  expect(totals.signInFirst).toBeGreaterThan(0);
  expect(totals.commandFirst).toBeGreaterThan(0);
});

describe("a confirmation waits for whoever holds what it depends on", () => {
  /** Holds a lock in its own transaction until told, so a wait here is that lock. */
  function holding(lock: (tx: Executor) => Promise<unknown>) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const haveLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const transaction = fixture.db.transaction(async (tx) => {
      await lock(tx);
      locked();
      await held;
    });
    return { haveLock, release, transaction };
  }

  // `FOR NO KEY UPDATE`, which conflicts with a share lock and not with the key-share lock a
  // foreign key takes, so a wait here is the confirmation's own lock.
  const locks: Record<
    string,
    (person: Person, tx: Executor) => Promise<unknown>
  > = {
    "the address": (person, tx) => lockMagicLinkAddress(tx, person.email),
    "the user": (person, tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, person.userId))
        .for("no key update"),
    "the organisation": (person, tx) =>
      tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, person.organization.id))
        .for("no key update"),
    "the provider row": (person, tx) =>
      tx
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, person.organization.magicLink.id))
        .for("no key update"),
    "the request row": (person, tx) =>
      tx
        .select({ id: magicLinkRequests.id })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, person.email))
        .for("no key update"),
  };

  for (const [name, lock] of Object.entries(locks))
    test(`${name}`, async () => {
      const person = await ready();
      const holder = holding((tx) => lock(person, tx));
      await holder.haveLock;
      let answered = false;
      const answer = flow
        .follow(person.token!, person.cookie)
        .then((response) => {
          answered = true;
          return response;
        });
      await Bun.sleep(300);
      expect(answered).toBe(false);
      holder.release();
      await holder.transaction;
      expect((await answer).status).toBe(303);
    });

  test("a row ended while the confirmation waits for it refuses", async () => {
    const person = await ready();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const haveLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = fixture.db.transaction(async (tx) => {
      await tx
        .select({ id: magicLinkRequests.id })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, person.email))
        .for("update");
      locked();
      await held;
      await tx
        .update(magicLinkRequests)
        .set({ attempts: 3 })
        .where(eq(magicLinkRequests.email, person.email));
    });
    await haveLock;
    const answer = flow.follow(person.token!, person.cookie);
    await Bun.sleep(300);
    release();
    await holder;
    const response = await answer;
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    const [row] = await flow.requestsOf(person.email);
    const [event] = await flow.refusals("auth.magic_link.refused", row!.id);
    expect(event!.reason).toBe("ended");
  });

  test("a switch holding only the provider row, committing while the confirmation waits, is an audited refusal", async () => {
    const person = await ready();
    const holder = holding((tx) =>
      tx
        .update(ssoProviders)
        .set({ enabled: false })
        .where(eq(ssoProviders.id, person.organization.magicLink.id)),
    );
    await holder.haveLock;
    const lines: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    let response: Response;
    try {
      const answer = flow.follow(person.token!, person.cookie);
      await Bun.sleep(300);
      holder.release();
      await holder.transaction;
      response = await answer;
    } finally {
      console.error = error;
    }
    expect(response.status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    // Read after the lock: admission saw it off. Without the lock the session trigger would
    // have stopped it, as a failure and with no audit row.
    expect(
      lines.filter((line) => line.includes("page_auth_call_failed")),
    ).toEqual([]);
    const [row] = await flow.requestsOf(person.email);
    const [event] = await flow.refusals("auth.magic_link.refused", row!.id);
    expect(event!.reason).toBe("not_admitted");
  });

  test("two guesses at a row on its last attempt give it one more comparison, not two", async () => {
    const person = await ready();
    await fixture.db
      .update(magicLinkRequests)
      .set({ attempts: 2 })
      .where(eq(magicLinkRequests.email, person.email));
    const holder = holding((tx) =>
      tx
        .select({ id: magicLinkRequests.id })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, person.email))
        .for("update"),
    );
    await holder.haveLock;
    const wrong = person.code === "00000000" ? "11111111" : "00000000";
    const guesses = Promise.all([
      flow.enter(wrong, person.cookie),
      flow.enter(wrong, person.cookie),
    ]);
    await Bun.sleep(200);
    holder.release();
    await holder.transaction;
    await guesses;
    const [row] = await flow.requestsOf(person.email);
    expect(row!.attempts).toBe(3);
  });

  test("a session made while the switch waits is ended by it: the revision moved", async () => {
    const person = await ready();
    const holder = holding((tx) =>
      lockOrganization(tx, person.organization.id),
    );
    await holder.haveLock;
    const answer = flow.follow(person.token!, person.cookie);
    await Bun.sleep(100);
    holder.release();
    await holder.transaction;
    expect((await answer).status).toBe(303);
    await commands["links off"]!(person);
    expect(await survivingAuthority(person)).toEqual([]);
  });

  test("a switch that commits while the confirmation waits refuses it", async () => {
    const person = await ready();
    const holder = holding((tx) =>
      lockOrganization(tx, person.organization.id),
    );
    await holder.haveLock;
    const answer = flow.follow(person.token!, person.cookie);
    await Bun.sleep(100);
    await fixture.db
      .update(ssoProviders)
      .set({ enabled: false })
      .where(eq(ssoProviders.id, person.organization.magicLink.id));
    holder.release();
    await holder.transaction;
    const response = await answer;
    expect(response.status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });
});

test("two confirmations of one token give one session", async () => {
  for (let round = 0; round < rounds; round++) {
    const person = await ready();
    const answers = await Promise.all([
      flow.follow(person.token!, person.cookie),
      flow.follow(person.token!, person.cookie),
      flow.follow(person.token!, person.cookie),
    ]);
    expect(answers.filter((response) => response.status === 303)).toHaveLength(
      1,
    );
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    expect(await flow.accountsOf(person.userId)).toHaveLength(1);
  }
});

test("a link and its code at once give one session", async () => {
  for (let round = 0; round < rounds; round++) {
    const person = await ready();
    const answers = await Promise.all([
      flow.follow(person.token!, person.cookie),
      flow.enter(person.code!, person.cookie),
    ]);
    expect(answers.filter((response) => response.status === 303)).toHaveLength(
      1,
    );
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
  }
});

test("two tokens for one address at once give one account and two sessions", async () => {
  for (let round = 0; round < rounds; round++) {
    const person = await ready();
    const second = await flow.ask(person.email, {
      headers: { "cf-connecting-ip": `198.51.100.${round + 100}` },
    });
    const answers = await Promise.all([
      flow.follow(person.token!, person.cookie),
      flow.follow(second.token!, second.cookie),
    ]);
    expect(answers.map((response) => response.status)).toEqual([303, 303]);
    expect(await flow.accountsOf(person.userId)).toHaveLength(1);
    expect(await flow.sessionsOf(person.userId)).toHaveLength(2);
  }
});

test("a grant in progress against a domain's removal leaves none alive", async () => {
  await flow.registerClient();
  for (let round = 0; round < rounds; round++) {
    const person = await ready();
    await flow.allowClient(person.organization.id);
    const cookie = flow.signedIn(
      await flow.follow(person.token!, person.cookie),
    );
    const [outcome] = await Promise.allSettled([
      flow.issueTokens(cookie, person.memberId),
      commands["domain removed"]!(person),
    ]);
    const live = await fixture.db
      .select()
      .from(grantContexts)
      .where(
        and(
          eq(grantContexts.userId, person.userId),
          sql`${grantContexts.revokedAt} is null`,
        ),
      );
    expect(live).toEqual([]);
    if (outcome.status === "fulfilled")
      expect((await flow.refresh(outcome.value.refresh_token)).status).toBe(
        400,
      );
  }
});

test("the account a confirmation made is not orphaned by a refused one", async () => {
  const person = await ready();
  await inPlatformUsers(fixture.db, (context) =>
    disableUser(context, person.userId),
  );
  await flow.follow(person.token!, person.cookie);
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, person.userId)),
  ).toEqual([]);
  const [user] = await fixture.db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, person.userId));
  expect(user!.status).toBe("disabled");
});
