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
import {
  accounts,
  members,
  organizationDomains,
  organizations,
  sessions,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { domainVerificationRecord } from "../services/domain-verification.ts";
import {
  deleteOrganizationDomain,
  disableDomain,
  endDomainProof,
  proveDomain,
} from "../services/domains.ts";
import { importMembers } from "../services/member-import.ts";
import * as memberService from "../services/members.ts";
import {
  disableMagicLink,
  setMagicLinkAdmission,
} from "../services/organizations.ts";
import { disableUser } from "../services/users.ts";
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

async function openFirm() {
  const organization = await flow.seedOrganization(
    `domain-races-${++nextFirm}`,
    false,
  );
  const domainId = await flow.openToDomain(organization);
  return { ...organization, domainId };
}

type Firm = Awaited<ReturnType<typeof openFirm>>;
type Round = {
  firm: Firm;
  email: string;
  token: string;
  cookie: string;
  /** Set when the address had a holder before the race. */
  userId?: string;
  memberId?: string;
};

/** A new person's request, or a member's when `listed`, in a firm opened to its domain. */
async function ready(listed = false): Promise<Round> {
  const firm = await openFirm();
  const person = listed ? await flow.listed(firm) : undefined;
  const email = person?.email ?? `new-${createId()}@${firm.domain}`;
  const request = await flow.ask(email);
  return {
    firm,
    email,
    token: request.token!,
    cookie: request.cookie,
    userId: person?.userId,
    memberId: person?.memberId,
  };
}

const usersOf = (email: string) =>
  fixture.db.select().from(users).where(eq(users.email, email));

const membersOf = (firm: Firm, userId: string) =>
  fixture.db
    .select()
    .from(members)
    .where(
      and(eq(members.organizationId, firm.id), eq(members.userId, userId)),
    );

/** A session this address's holder holds that still has standing at their firm. */
async function survivingAuthority({ firm, email }: Round) {
  const [holder] = await usersOf(email);
  if (!holder) return [];
  const rows = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, holder.id));
  const standing = await Promise.all(
    rows.map((row) =>
      tenantAuthentication(fixture.db, {
        userId: holder.id,
        sessionId: row.id,
        organizationId: firm.id,
      }),
    ),
  );
  return standing.filter((row) => row !== null);
}

/** Whatever the order, the person is whole or not there: never a user with half of the rest. */
async function expectWholeOrNothing(round: Round, signedIn: boolean) {
  const holders = await usersOf(round.email);
  expect(holders.length).toBeLessThanOrEqual(1);
  if (signedIn) expect(holders).toHaveLength(1);
  if (!holders.length) return;
  const [holder] = holders;
  expect(await membersOf(round.firm, holder!.id)).toHaveLength(1);
  const held = await fixture.db
    .select({ accountId: accounts.accountId })
    .from(accounts)
    .where(eq(accounts.userId, holder!.id));
  expect(held.length).toBe(signedIn ? 1 : held.length);
}

type Race = {
  listed?: boolean;
  command: (round: Round) => Promise<unknown>;
  /** What must hold once both are done. A session may outlive a command that ends none. */
  afterwards: (round: Round, signedIn: boolean) => Promise<void>;
  /** Which came first, for a race where the person signs in either way. */
  commandFirst?: (answer: never) => boolean;
};

const noStanding = async (round: Round) => {
  expect(await survivingAuthority(round)).toEqual([]);
};

const races: Record<string, Race> = {
  "the switch to listed": {
    command: ({ firm }) =>
      inPlatformWrite(fixture.db, (context) =>
        setMagicLinkAdmission(context, firm.id, "listed"),
      ),
    // A switch ends nobody's session, so a sign-in that won keeps its standing.
    afterwards: (round, signedIn) => expectWholeOrNothing(round, signedIn),
  },
  "the proof taken away": {
    command: ({ firm }) =>
      inPlatformWrite(fixture.db, (context) =>
        endDomainProof(context, firm.id, firm.domainId),
      ),
    afterwards: (round, signedIn) => expectWholeOrNothing(round, signedIn),
  },
  "links turned off": {
    command: ({ firm }) =>
      inPlatformWrite(fixture.db, (context) =>
        disableMagicLink(context, firm.id),
      ),
    afterwards: noStanding,
  },
  "the domain disabled": {
    command: ({ firm }) =>
      inPlatformWrite(fixture.db, (context) =>
        disableDomain(context, firm.id, firm.domainId),
      ),
    afterwards: noStanding,
  },
  "the domain removed": {
    command: ({ firm }) =>
      inPlatformWrite(fixture.db, (context) =>
        deleteOrganizationDomain(context, firm.id, firm.domainId),
      ),
    afterwards: noStanding,
  },
  "the member removed": {
    listed: true,
    command: ({ firm, memberId }) =>
      inTenant(fixture.db, firm.id, (context) =>
        memberService.remove(context, memberId!),
      ),
    afterwards: noStanding,
  },
  "the user disabled": {
    listed: true,
    command: ({ userId }) =>
      inPlatformUsers(fixture.db, (context) => disableUser(context, userId!)),
    afterwards: noStanding,
  },
  "an import of the same address": {
    command: ({ firm, email }) =>
      inPlatformUsers(fixture.db, (context) =>
        importMembers(context, firm.id, [email]),
      ),
    // Each finds what the other made, so the person signs in either way.
    afterwards: async (round) => expectWholeOrNothing(round, true),
    commandFirst: (answer: Awaited<ReturnType<typeof importMembers>>) =>
      answer.counts.created === 1,
  },
};

const totals: Record<string, { signInFirst: number; commandFirst: number }> =
  {};

describe("a first sign-in against each command, in both orders", () => {
  for (const [
    name,
    { command, afterwards, listed, commandFirst },
  ] of Object.entries(races))
    for (const [order, confirmFirst] of [
      ["confirmation started first", true],
      ["command started first", false],
    ] as const)
      test(`${name}, ${order}: consistent, and no deadlock or lock timeout`, async () => {
        const lines: string[] = [];
        const { error } = console;
        console.error = (...args: unknown[]) => void lines.push(args.join(" "));
        const tally = (totals[name] ??= { signInFirst: 0, commandFirst: 0 });
        try {
          for (let round = 0; round < rounds; round++) {
            const current = await ready(listed);
            const follow = () => flow.follow(current.token, current.cookie);
            const answers = confirmFirst
              ? [
                  follow(),
                  Bun.sleep(
                    confirmationLeadMs[round % confirmationLeadMs.length]!,
                  ).then(() => command(current)),
                ]
              : [
                  command(current),
                  Bun.sleep(commandLeadMs[round % commandLeadMs.length]!).then(
                    follow,
                  ),
                ];
            // A command that lost a lock wait would reject this.
            const settled = await Promise.all(answers);
            const response = settled.find(
              (value) => value instanceof Response,
            ) as Response;
            const signedIn = response.status === 303;
            const commandWon = commandFirst
              ? commandFirst(
                  settled.find(
                    (value) => !(value instanceof Response),
                  ) as never,
                )
              : !signedIn;
            if (commandWon) tally.commandFirst++;
            else tally.signInFirst++;
            expect([200, 303]).toContain(response.status);
            await afterwards(current, signedIn);
          }
        } finally {
          console.error = error;
        }
        // Each process's failure lines hold the SQLSTATE: 40P01 and 55P03 would show here.
        expect(
          lines.filter((line) => line.includes("page_auth_call_failed")),
        ).toEqual([]);
      }, 60_000);

  test("two confirmations for one new address: one user, one member, one account", async () => {
    const lines: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      for (let round = 0; round < rounds; round++) {
        const firm = await openFirm();
        const email = `new-${createId()}@${firm.domain}`;
        const [first, second] = [
          await flow.ask(email, {
            headers: { "cf-connecting-ip": "198.51.100.1" },
          }),
          await flow.ask(email, {
            headers: { "cf-connecting-ip": "198.51.100.2" },
          }),
        ];
        const answers = await Promise.all([
          flow.follow(first.token!, first.cookie),
          flow.follow(second.token!, second.cookie),
        ]);
        expect(answers.map(({ status }) => status)).toEqual([303, 303]);
        const holders = await usersOf(email);
        expect(holders).toHaveLength(1);
        expect(
          await membersOf({ id: firm.id } as Firm, holders[0]!.id),
        ).toHaveLength(1);
        expect(await flow.accountsOf(holders[0]!.id)).toHaveLength(1);
        expect(await flow.sessionsOf(holders[0]!.id)).toHaveLength(2);
      }
    } finally {
      console.error = error;
    }
    expect(lines.filter((line) => line.includes("failed"))).toEqual([]);
  }, 60_000);

  test("both orders were seen", () => {
    console.log("[domain races]", JSON.stringify({ rounds, totals }));
    if (rounds < 6) return;
    for (const name of Object.keys(races)) {
      expect(totals[name]!.signInFirst, name).toBeGreaterThan(0);
      expect(totals[name]!.commandFirst, name).toBeGreaterThan(0);
    }
  });
});

describe("what each command waits for, and what it finds", () => {
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

  const shareTheFirm = (firm: Firm) => (tx: Executor) =>
    tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, firm.id))
      .for("share");

  async function expectWaits(
    lock: (tx: Executor) => Promise<unknown>,
    command: () => Promise<unknown>,
  ) {
    const holder = holding(lock);
    await holder.haveLock;
    let done = false;
    const running = command().then((value) => {
      done = true;
      return value;
    });
    await Bun.sleep(250);
    expect(done).toBe(false);
    holder.release();
    await holder.transaction;
    return running;
  }

  const recordsOf = async (firm: Firm) => {
    const [row] = await fixture.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.id, firm.domainId));
    return [[domainVerificationRecord(row!).value]];
  };

  test("the switch waits for a confirmation holding its share of the firm", async () => {
    const firm = await openFirm();
    await expectWaits(shareTheFirm(firm), () =>
      inPlatformWrite(fixture.db, (context) =>
        setMagicLinkAdmission(context, firm.id, "listed"),
      ),
    );
  });

  test("proving and losing a proof wait for it too", async () => {
    const firm = await openFirm();
    const records = await recordsOf(firm);
    await expectWaits(shareTheFirm(firm), () =>
      inPlatformWrite(fixture.db, (context) =>
        proveDomain(context, firm.id, firm.domainId, records),
      ),
    );
    await expectWaits(shareTheFirm(firm), () =>
      inPlatformWrite(fixture.db, (context) =>
        endDomainProof(context, firm.id, firm.domainId),
      ),
    );
  });

  test("the switch committed while a confirmation waits on the firm: it finds listed, and refuses a new person", async () => {
    const round = await ready();
    const holder = holding(async (tx) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, round.firm.id))
        .for("update");
      await tx.execute(
        sql`update sso_providers set admission = 'listed' where organization_id = ${round.firm.id} and kind = 'magic_link'`,
      );
    });
    await holder.haveLock;
    const answer = flow.follow(round.token, round.cookie);
    await Bun.sleep(250);
    holder.release();
    await holder.transaction;
    expect((await answer).status).toBe(200);
    expect(await usersOf(round.email)).toEqual([]);
    const [row] = await flow.requestsOf(round.email);
    const [event] = await flow.refusals("auth.magic_link.refused", row!.id);
    expect(event!.reason).toBe("not_admitted");
  });

  test("the proof lost while a confirmation waits on the firm: it finds that, and refuses a new person", async () => {
    const round = await ready();
    const holder = holding(async (tx) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, round.firm.id))
        .for("update");
      await tx.execute(
        sql`update organization_domains set verified_at = null where id = ${round.firm.domainId}`,
      );
    });
    await holder.haveLock;
    const answer = flow.follow(round.token, round.cookie);
    await Bun.sleep(250);
    holder.release();
    await holder.transaction;
    expect((await answer).status).toBe(200);
    expect(await usersOf(round.email)).toEqual([]);
  });

  test("an import waits for another import, across every firm", async () => {
    const firm = await openFirm();
    await expectWaits(
      (tx) =>
        tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('answerable:member-import', 0))`,
        ),
      () =>
        inPlatformUsers(fixture.db, (context) =>
          importMembers(context, firm.id, [`new-${createId()}@${firm.domain}`]),
        ),
    );
  });

  test("a confirmation waits for an import holding its address, and signs in the person it made", async () => {
    const round = await ready();
    const importing = holding(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`answerable:magic-link:${round.email}`}, 0))`,
      );
    });
    await importing.haveLock;
    let done = false;
    const answer = flow.follow(round.token, round.cookie).then((response) => {
      done = true;
      return response;
    });
    await Bun.sleep(250);
    expect(done).toBe(false);
    const userId = createId();
    await fixture.db.insert(users).values({
      id: userId,
      name: round.email,
      email: round.email,
      emailVerified: true,
      status: "active",
    });
    await fixture.db.insert(members).values({
      id: createId(),
      organizationId: round.firm.id,
      userId,
    });
    importing.release();
    await importing.transaction;
    expect((await answer).status).toBe(303);
    expect(await flow.sessionsOf(userId)).toHaveLength(1);
  });
});
