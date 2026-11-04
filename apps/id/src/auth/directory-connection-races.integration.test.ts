import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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
  auditEvents,
  magicLinkRequests,
  members,
  organizationDomains,
  organizations,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { deleteOrganizationDomain } from "../services/domains.ts";
import { lockMagicLinkAddress } from "../services/magic-link-requests.ts";
import * as memberService from "../services/members.ts";
import {
  deleteSsoProvider,
  putSsoProvider,
} from "../services/sso-providers.ts";
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
// The right code takes more statements to reach its locks than a command does, and counts its
// attempt first. These spreads let either commit first, and keep some rounds overlapping.
const codeLeadMs = [0, 8, 20, 40, 70, 110];
const commandLeadMs = [0, 0, 1, 2, 4, 8];
let nextFirm = 0;

/** A person part way: verified at the directory, with the code in their inbox. */
async function ready() {
  const of = await flow.seedOrganization(`connect-races-${++nextFirm}`, true);
  const person = await flow.listed(of);
  const sub = `subject-${createId()}`;
  const signIn = await flow.signInByDirectory(person.email, sub);
  expect(signIn.response.headers.get("location")).toBe("/connect-directory");
  const [domain] = await fixture.db
    .select({ id: organizationDomains.id })
    .from(organizationDomains)
    .where(eq(organizationDomains.domain, of.domain));
  const [row] = await flow.requestsOf(person.email);
  return { of, ...person, ...signIn, sub, domainId: domain!.id, row: row! };
}
type Person = Awaited<ReturnType<typeof ready>>;

const changeDirectory = ({ of }: Pick<Person, "of">) =>
  inPlatformWrite(fixture.db, (context) =>
    putSsoProvider(context, of.id, {
      ...flow.directoryInput(of.slug),
      domain: `changed-${createId()}.${of.domain}`,
    }),
  );
const removeDirectory = ({ of }: Pick<Person, "of">) =>
  inPlatformWrite(fixture.db, (context) => deleteSsoProvider(context, of.id));

const commands: Record<string, (person: Person) => Promise<unknown>> = {
  "member removed": (person) =>
    inTenant(fixture.db, person.of.id, (context) =>
      memberService.remove(context, person.memberId),
    ),
  "user disabled": (person) =>
    inPlatformUsers(fixture.db, (context) =>
      disableUser(context, person.userId),
    ),
  "directory changed": changeDirectory,
  "directory removed": removeDirectory,
  "domain removed": (person) =>
    inPlatformWrite(fixture.db, (context) =>
      deleteOrganizationDomain(context, person.of.id, person.domainId),
    ),
};

const totals: Record<string, { connectedFirst: number; commandFirst: number }> =
  {};

/** What must hold whichever came first: connected with its event, or refused with its row. */
async function expectWhole(person: Person) {
  const held = await flow.accountsOf(person.userId);
  expect(held.length).toBeLessThanOrEqual(1);
  // No session path exists here, whichever came first.
  expect(await flow.sessionsOf(person.userId)).toEqual([]);
  const linked = held[0]
    ? await fixture.db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, held[0].id))
    : [];
  const refused = await flow.refusals("auth.magic_link.refused", person.row.id);
  expect(linked).toHaveLength(held.length);
  expect(refused).toHaveLength(1 - held.length);
  return held.length === 1;
}

for (const [name, command] of Object.entries(commands))
  for (const [order, codeFirst] of [
    ["code started first", true],
    ["command started first", false],
  ] as const)
    test(`the right code against ${name}, ${order}: one whole outcome, no deadlock and no lock timeout`, async () => {
      const lines: string[] = [];
      const { error } = console;
      console.error = (...args: unknown[]) => void lines.push(args.join(" "));
      const seen = (totals[`${name}, ${order}`] = {
        connectedFirst: 0,
        commandFirst: 0,
      });
      try {
        for (let round = 0; round < rounds; round++) {
          const person = await ready();
          const enter = () =>
            flow.enterConnectionCode(person.code!, person.cookie);
          const answers = codeFirst
            ? [
                enter(),
                Bun.sleep(codeLeadMs[round % codeLeadMs.length]!).then(() =>
                  command(person),
                ),
              ]
            : [
                command(person),
                Bun.sleep(commandLeadMs[round % commandLeadMs.length]!).then(
                  enter,
                ),
              ];
          // A command that lost a lock wait would reject this.
          const settled = await Promise.all(answers);
          const response = settled.find(
            (value) => value instanceof Response,
          ) as Response;
          expect([200, 303]).toContain(response.status);
          if (await expectWhole(person)) seen.connectedFirst++;
          else seen.commandFirst++;
        }
      } finally {
        console.error = error;
      }
      // Each process's failure lines hold the SQLSTATE: 40P01 and 55P03 would show here. The
      // sign-in a removed directory cannot start logs nothing of the kind.
      expect(
        lines.filter((line) => line.includes("page_auth_call_failed")),
      ).toEqual([]);
    });

const signInCounts: Record<string, number> = {};
for (const [name, command] of Object.entries({
  "directory changed": changeDirectory,
  "directory removed": removeDirectory,
}))
  for (const [order, linkFirst] of [
    ["link started first", true],
    ["command started first", false],
  ] as const)
    test(`a magic-link sign-in against ${name}, ${order}: the link's session and grant stand, either way`, async () => {
      const lines: string[] = [];
      const { error } = console;
      console.error = (...args: unknown[]) => void lines.push(args.join(" "));
      try {
        for (let round = 0; round < rounds; round++) {
          const of = await flow.seedOrganization(
            `connect-races-${++nextFirm}`,
            true,
          );
          const person = await flow.listed(of);
          const asked = await flow.ask(person.email, { method: "link" });
          const follow = () => flow.follow(asked.token!, asked.cookie);
          const run = async () => {
            await command({ of });
          };
          const answers = linkFirst
            ? [
                follow(),
                Bun.sleep(codeLeadMs[round % codeLeadMs.length]!).then(run),
              ]
            : [
                run(),
                Bun.sleep(commandLeadMs[round % commandLeadMs.length]!).then(
                  follow,
                ),
              ];
          const settled = await Promise.all(answers);
          const response = settled.find(
            (value) => value instanceof Response,
          ) as Response;
          expect(response.status).toBe(303);
          const [session] = await flow.sessionsOf(person.userId);
          expect(
            await tenantAuthentication(fixture.db, {
              userId: person.userId,
              sessionId: session!.id,
              organizationId: of.id,
            }),
          ).not.toBeNull();
          signInCounts[`${name}, ${order}`] =
            (signInCounts[`${name}, ${order}`] ?? 0) + 1;
        }
      } finally {
        console.error = error;
      }
      expect(
        lines.filter((line) => line.includes("page_auth_call_failed")),
      ).toEqual([]);
    });

test("both outcomes were seen, and the counts are on record", () => {
  console.log(
    "[connect races]",
    JSON.stringify({ rounds, totals, signInCounts }),
  );
  const all = Object.values(totals);
  expect(all.length).toBe(10);
  expect(all.reduce((sum, row) => sum + row.connectedFirst, 0)).toBeGreaterThan(
    0,
  );
  expect(all.reduce((sum, row) => sum + row.commandFirst, 0)).toBeGreaterThan(
    0,
  );
});

describe("the right code waits for whoever holds what it depends on", () => {
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
  // foreign key takes, so a wait here is the connection's own lock.
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
        .where(eq(organizations.id, person.of.id))
        .for("no key update"),
    "the directory's row": (person, tx) =>
      tx
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, person.of.row!.id))
        .for("no key update"),
    "the request row": (person, tx) =>
      tx
        .select({ id: magicLinkRequests.id })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, person.email))
        .for("no key update"),
  };

  for (const [name, lock] of Object.entries(locks))
    test(name, async () => {
      const person = await ready();
      const holder = holding((tx) => lock(person, tx));
      await holder.haveLock;
      let answered = false;
      const answer = flow
        .enterConnectionCode(person.code!, person.cookie)
        .then((response) => {
          answered = true;
          return response;
        });
      await Bun.sleep(300);
      expect(answered).toBe(false);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      holder.release();
      await holder.transaction;
      expect((await answer).status).toBe(303);
      expect(await flow.accountsOf(person.userId)).toHaveLength(1);
    });

  test("the request row is taken last, under the address, the user, the organisation and the directory", async () => {
    // A command holding the user while it deletes request rows, as erasing a person does, would
    // deadlock with a connection that took the row first. So holding the user, the request row
    // must stay free while the right code waits.
    const person = await ready();
    const holder = holding((tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, person.userId))
        .for("no key update"),
    );
    await holder.haveLock;
    const answer = flow.enterConnectionCode(person.code!, person.cookie);
    await Bun.sleep(300);
    const [free] = await fixture.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: magicLinkRequests.id })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, person.email))
        .for("update", { noWait: true });
      return rows;
    });
    expect(free!.id).toBe(person.row.id);
    holder.release();
    await holder.transaction;
    expect((await answer).status).toBe(303);
  });

  test("asking the mailbox waits for the address, so that its limits hold across replicas", async () => {
    const of = await flow.seedOrganization(`connect-races-${++nextFirm}`, true);
    const person = await flow.listed(of);
    const holder = holding((tx) => lockMagicLinkAddress(tx, person.email));
    await holder.haveLock;
    let answered = false;
    const answer = flow
      .signInByDirectory(person.email, `subject-${createId()}`)
      .then((signIn) => {
        answered = true;
        return signIn;
      });
    await Bun.sleep(300);
    expect(answered).toBe(false);
    holder.release();
    await holder.transaction;
    expect((await answer).response.headers.get("location")).toBe(
      "/connect-directory",
    );
  });

  test("a row that ended, failed or spent its attempts while the right code waited refuses", async () => {
    for (const change of [
      { expiresAt: new Date(Date.now() - 1_000) },
      { sendStatus: "failed" as const },
      { attempts: 4 },
    ]) {
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
        await lockMagicLinkAddress(tx, person.email);
        locked();
        await held;
        await tx
          .update(magicLinkRequests)
          .set(change)
          .where(eq(magicLinkRequests.email, person.email));
      });
      await haveLock;
      const answer = flow.enterConnectionCode(person.code!, person.cookie);
      await Bun.sleep(300);
      release();
      await holder;
      expect((await answer).status).toBe(200);
      expect(await flow.accountsOf(person.userId)).toEqual([]);
      const [event] = await flow.refusals(
        "auth.magic_link.refused",
        person.row.id,
      );
      expect(event!.reason).toBe("ended");
    }
  });

  test("the right code holds the request row before it reads it, so a row another writer is ending refuses", async () => {
    const person = await ready();
    const address = holding((tx) => lockMagicLinkAddress(tx, person.email));
    await address.haveLock;
    const answer = flow.enterConnectionCode(person.code!, person.cookie);
    // Its attempt has committed, and it waits on the address, before any read of the row.
    await Bun.sleep(300);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const haveLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const row = fixture.db.transaction(async (tx) => {
      await tx
        .select({ id: magicLinkRequests.id })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, person.email))
        .for("no key update");
      locked();
      await held;
      await tx
        .update(magicLinkRequests)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(magicLinkRequests.email, person.email));
    });
    await haveLock;
    address.release();
    await address.transaction;
    await Bun.sleep(300);
    release();
    await row;
    expect((await answer).status).toBe(200);
    expect(await flow.accountsOf(person.userId)).toEqual([]);
    const [event] = await flow.refusals(
      "auth.magic_link.refused",
      person.row.id,
    );
    expect(event!.reason).toBe("ended");
  });

  test("a holder who changed while the right code waited for their row is not who it was for", async () => {
    const person = await ready();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const haveLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const nextId = createId();
    const holder = fixture.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, person.userId))
        .for("no key update");
      locked();
      await held;
      await tx
        .update(users)
        .set({
          status: "disabled",
          disabledAt: new Date(),
          retiredEmail: person.email,
          email: `${person.userId}@retired.invalid`,
        })
        .where(eq(users.id, person.userId));
      await tx.insert(users).values({
        id: nextId,
        name: "Next",
        email: person.email,
        emailVerified: true,
        status: "active",
      });
      await tx.insert(members).values({
        id: createId(),
        organizationId: person.of.id,
        userId: nextId,
      });
    });
    await haveLock;
    const answer = flow.enterConnectionCode(person.code!, person.cookie);
    await Bun.sleep(300);
    release();
    await holder;
    expect((await answer).status).toBe(200);
    expect(await flow.accountsOf(nextId)).toEqual([]);
    const [event] = await flow.refusals(
      "auth.magic_link.refused",
      person.row.id,
    );
    expect(event!.reason).toBe("not_connectable");
  });

  test("a holder who appeared after the first read found none has no lock here, so it refuses", async () => {
    const person = await ready();
    await fixture.db
      .update(users)
      .set({ email: `moved-${createId()}@${person.of.domain}` })
      .where(eq(users.id, person.userId));
    const holder = holding((tx) =>
      tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, person.of.id))
        .for("no key update"),
    );
    await holder.haveLock;
    const answer = flow.enterConnectionCode(person.code!, person.cookie);
    await Bun.sleep(300);
    const nextId = createId();
    await fixture.db.insert(users).values({
      id: nextId,
      name: "Next",
      email: person.email,
      emailVerified: true,
      status: "active",
    });
    await fixture.db.insert(members).values({
      id: createId(),
      organizationId: person.of.id,
      userId: nextId,
    });
    holder.release();
    await holder.transaction;
    expect((await answer).status).toBe(200);
    expect(await flow.accountsOf(nextId)).toEqual([]);
    const [event] = await flow.refusals(
      "auth.magic_link.refused",
      person.row.id,
    );
    expect(event!.reason).toBe("not_connectable");
  });

  test("two right codes at once connect once", async () => {
    for (let round = 0; round < rounds; round++) {
      const person = await ready();
      const answers = await Promise.all([
        flow.enterConnectionCode(person.code!, person.cookie),
        flow.enterConnectionCode(person.code!, person.cookie),
        flow.enterConnectionCode(person.code!, person.cookie),
      ]);
      expect(answers.filter((answer) => answer.status === 303)).toHaveLength(1);
      expect(await flow.accountsOf(person.userId)).toHaveLength(1);
    }
  });

  test("the same identity connected from two browsers for two people at once goes to one", async () => {
    for (let round = 0; round < rounds; round++) {
      const of = await flow.seedOrganization(
        `connect-races-${++nextFirm}`,
        true,
      );
      const [first, second] = [await flow.listed(of), await flow.listed(of)];
      const sub = `subject-${createId()}`;
      const a = await flow.signInByDirectory(first.email, sub);
      const b = await flow.signInByDirectory(second.email, sub);
      await Promise.all([
        flow.enterConnectionCode(a.code!, a.cookie),
        flow.enterConnectionCode(b.code!, b.cookie),
      ]);
      const held = await fixture.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.accountId, sub));
      expect(held).toHaveLength(1);
    }
  });
});
