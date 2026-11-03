import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { answerOf, magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import { codeIn } from "../__tests__/magic-link-requests.ts";
import { magicLinkKeys } from "../auth/magic-link.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { magicLinkRequests } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  clientCodeFailures,
  magicLinkCodeBudgets,
  organizationCodeFailures,
} from "./magic-link-codes.ts";

let fixture: AdminFixture;
let flow: ReturnType<typeof magicLinkFlow>;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 1 },
    { originChecks: true, restrictedRole: true },
  );
  flow = magicLinkFlow(fixture);
});
afterAll(() => fixture?.close());

let nextFirm = 0;
const firm = () => flow.seedOrganization(`codes-${++nextFirm}`, false);

async function asked() {
  const organization = await firm();
  const person = await flow.listed(organization);
  const request = await flow.ask(person.email);
  const [row] = await flow.requestsOf(person.email);
  const wrong = request.code === "00000000" ? "11111111" : "00000000";
  return {
    organization,
    ...person,
    cookie: request.cookie,
    token: request.token!,
    code: request.code!,
    wrong,
    row: row!,
  };
}
const attemptsOf = async (email: string) =>
  (await flow.requestsOf(email)).map((row) => row.attempts);
const exhausted = (requestId: string) =>
  flow.refusals("auth.magic_link.code_exhausted", requestId);

describe("three attempts", () => {
  test("each counts, the third ends the request for its link as well, and it says so once", async () => {
    const person = await asked();
    for (const expected of [1, 2]) {
      expect((await flow.enter(person.wrong, person.cookie)).status).toBe(200);
      expect(await attemptsOf(person.email)).toEqual([expected]);
      expect(await exhausted(person.row.id)).toEqual([]);
    }
    await flow.enter(person.wrong, person.cookie);
    expect(await attemptsOf(person.email)).toEqual([3]);
    const events = await exhausted(person.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "system",
      actorId: "magic-link",
      outcome: "denied",
      reason: "code_attempts",
      targetType: "user",
      targetId: person.userId,
      organizationId: person.organization.id,
    });
    expect(JSON.stringify(events[0])).not.toContain(person.email);

    // Ended: not the right code, not the link, and no fourth count or second event.
    const right = await flow.enter(person.code, person.cookie);
    expect(right.status).toBe(200);
    expect(right.headers.getSetCookie()).toEqual([]);
    expect(await attemptsOf(person.email)).toEqual([3]);
    expect((await flow.follow(person.token, person.cookie)).status).toBe(200);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
    const page = await flow.open(person.token, person.cookie);
    expect(await page.text()).not.toContain(person.email);
    expect(await exhausted(person.row.id)).toHaveLength(1);
  });

  test("a right code on the third attempt signs in", async () => {
    const person = await asked();
    await flow.enter(person.wrong, person.cookie);
    await flow.enter(person.wrong, person.cookie);
    flow.signedIn(await flow.enter(person.code, person.cookie));
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
    // Two wrong codes remain counted, and the right one is not one of them.
    expect(await attemptsOf(person.email)).toEqual([2]);
    expect(await exhausted(person.row.id)).toEqual([]);
  });

  test("a wrong-code count survives a refused sign-in", async () => {
    const person = await asked();
    await fixture.db.execute(
      sql`update sso_providers set enabled = false where id = ${person.organization.magicLink.id}`,
    );
    const answer = await flow.enter(person.code, person.cookie);
    expect(answer.status).toBe(200);
    // The confirmation refused and rolled back, and the count it did not own stays.
    expect(await attemptsOf(person.email)).toEqual([1]);
    expect(
      (await flow.refusals("auth.magic_link.refused", person.row.id))[0]!
        .reason,
    ).toBe("not_admitted");
  });

  test("a count commits before the comparison: one that fails after it still counts", async () => {
    const person = await asked();
    const realApi = fixture.auth.api.confirmMagicLink;
    fixture.auth.api.confirmMagicLink = (async () => {
      throw new Error("The database went away");
    }) as never;
    const { error } = console;
    console.error = () => {};
    try {
      const answer = await flow.enter(person.code, person.cookie);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain("That code didn&#39;t work");
    } finally {
      console.error = error;
      fixture.auth.api.confirmMagicLink = realApi;
    }
    expect(await attemptsOf(person.email)).toEqual([1]);
    expect(await flow.tokenRows(person.row.tokenIdentifier!)).toHaveLength(1);
  });

  test("concurrent guesses cannot get a fourth comparison", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email);
    const wrong = code === "00000000" ? "11111111" : "00000000";
    await Promise.all(
      Array.from({ length: 8 }, () => flow.enter(wrong, cookie)),
    );
    expect(await attemptsOf(person.email)).toEqual([3]);
  });
});

describe("rows that take no attempt", () => {
  test("a row still sending, a failed one and an expired one count nothing and sign nobody in", async () => {
    for (const change of [
      { sendStatus: "sending" as const },
      {
        sendStatus: "failed" as const,
        postmarkErrorCode: 406,
        postmarkHttpStatus: 422,
      },
      { expiresAt: new Date(Date.now() - 1_000) },
    ]) {
      const person = await asked();
      await fixture.db
        .update(magicLinkRequests)
        .set(change)
        .where(eq(magicLinkRequests.id, person.row.id));
      const answer = await flow.enter(person.code, person.cookie);
      expect(answer.status).toBe(200);
      expect(answer.headers.getSetCookie()).toEqual([]);
      expect(await attemptsOf(person.email)).toEqual([0]);
      expect(await flow.sessionsOf(person.userId)).toEqual([]);
    }
  });

  test("a row at three attempts names nobody on the link's page and writes no refusal", async () => {
    const person = await asked();
    await fixture.db
      .update(magicLinkRequests)
      .set({ attempts: 3 })
      .where(eq(magicLinkRequests.id, person.row.id));
    const page = await flow.open(person.token, person.cookie);
    expect(await page.text()).not.toContain(person.email);
    await flow.follow(person.token, person.cookie);
    expect(
      await flow.refusals("auth.magic_link.refused", person.row.id),
    ).toEqual([]);
  });
});

describe("a browser with several requests", () => {
  test("every attempt counts on each live row, each gets three, and either code works until then", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const first = await flow.ask(person.email);
    const second = await flow.ask(person.email, {
      cookie: first.cookie,
      headers: { "cf-connecting-ip": "198.51.100.71" },
    });
    expect(second.cookie).toBe(first.cookie);
    const taken = [first.code!, second.code!];
    const wrong = ["00000000", "11111111", "22222222"].find(
      (value) => !taken.includes(value),
    )!;
    await flow.enter(wrong, first.cookie);
    expect(await attemptsOf(person.email)).toEqual([1, 1]);
    await flow.enter(wrong, first.cookie);
    expect(await attemptsOf(person.email)).toEqual([2, 2]);
    // The older request's code signs in on its own row, and the newer still counted a miss.
    flow.signedIn(await flow.enter(first.code!, first.cookie));
    const rows = await flow.requestsOf(person.email);
    expect(rows.map((row) => row.attempts)).toEqual([2, 3]);
    expect(rows[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    const events = await exhausted(rows[1]!.id);
    expect(events).toHaveLength(1);
  });

  test("a row already at three is not counted again beside a live one", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const first = await flow.ask(person.email);
    await fixture.db
      .update(magicLinkRequests)
      .set({ attempts: 3 })
      .where(eq(magicLinkRequests.email, person.email));
    const second = await flow.ask(person.email, {
      cookie: first.cookie,
      headers: { "cf-connecting-ip": "198.51.100.72" },
    });
    await flow.enter(
      "00000000" === second.code ? "11111111" : "00000000",
      first.cookie,
    );
    expect(await attemptsOf(person.email)).toEqual([3, 1]);
  });

  test("one browser's rows for two addresses both count, and a code signs in only its own address", async () => {
    const organization = await firm();
    const one = await flow.listed(organization);
    const two = await flow.listed(organization);
    const first = await flow.ask(one.email);
    const second = await flow.ask(two.email, { cookie: first.cookie });
    flow.signedIn(await flow.enter(second.code!, first.cookie));
    expect(await flow.sessionsOf(two.userId)).toHaveLength(1);
    expect(await flow.sessionsOf(one.userId)).toEqual([]);
  });

  test("the work is bounded: only the newest ten are compared", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const first = await flow.ask(person.email);
    const [template] = await flow.requestsOf(person.email);
    for (let index = 0; index < 11; index++)
      await fixture.db.insert(magicLinkRequests).values({
        ...template!,
        id: createId(),
        tokenIdentifier: `magic-link:other-${createId()}`,
        createdAt: new Date(Date.now() - 1_000 * (index + 1)),
      });
    await flow.enter(
      "00000000" === first.code ? "11111111" : "00000000",
      first.cookie,
    );
    const counted = (await flow.requestsOf(person.email)).filter(
      (row) => row.attempts === 1,
    );
    expect(counted).toHaveLength(10);
    expect(counted.map((row) => row.id)).toContain(template!.id);
  });
});

describe("failure budgets", () => {
  test("the numbers are thirty and a thousand", () => {
    expect(magicLinkCodeBudgets).toEqual({
      clientPerHour: 30,
      organizationPerHour: 1_000,
    });
  });

  test("a client that has spent its budget guessing compares nothing, whoever asked for the row", async () => {
    const guesser = "198.51.100.86";
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email, {
      headers: { "cf-connecting-ip": "198.51.100.87" },
    });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: clientOf(guesser),
      attempts: magicLinkCodeBudgets.clientPerHour,
    });
    const { error } = console;
    console.error = () => {};
    try {
      const answer = await flow.enter(code!, cookie, {
        "cf-connecting-ip": guesser,
      });
      expect(answer.headers.getSetCookie()).toEqual([]);
    } finally {
      console.error = error;
    }
    expect(await attemptsOf(person.email)).toEqual([0]);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });

  /** Rows that used up this much of a budget, made to look like the last hour's guesses. */
  async function spend(values: {
    organizationId: string;
    providerId: string;
    clientHash?: string;
    attempts: number;
    createdAt?: Date;
  }) {
    await fixture.db.insert(magicLinkRequests).values({
      id: createId(),
      purpose: "access_removed",
      providerRevision: 1,
      email: `spent-${createId()}@spent.example.com`,
      clientHash: "another-client",
      expiresAt: new Date(Date.now() - 1_000),
      ...values,
    });
  }
  const keys = () => magicLinkKeys(fixture.environment);
  const clientOf = (address: string) => keys().clientHash(address);

  test("thirty wrong codes an hour from a client stop it comparing, for a right code too, with one answer", async () => {
    const client = "198.51.100.81";
    const headers = { "cf-connecting-ip": client };
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email, { headers });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: clientOf(client),
      attempts: magicLinkCodeBudgets.clientPerHour,
    });
    const lines: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    let spent: Response;
    try {
      spent = await flow.enter(code!, cookie, {
        ...headers,
        "x-request-id": "budget",
      });
    } finally {
      console.error = error;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("magic_link_code_budget_exhausted");
    expect(lines[0]).toContain('"budget":"client"');
    expect(lines[0]).not.toContain(person.email);
    expect(lines[0]).not.toContain(client);
    expect(await attemptsOf(person.email)).toEqual([0]);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);

    const ordinary = await flow.enter("not a code", cookie, {
      ...headers,
      "x-request-id": "budget",
    });
    expect(await answerOf(spent!)).toEqual(await answerOf(ordinary));
    // The link does not go through this budget.
    flow.signedIn(await flow.follow(codes(person.email), cookie, headers));
  });

  const codes = (email: string) => {
    const mail = fixture.mail.transport.sent.findLast((m) => m.to === email)!;
    return /\/magic-link\?token=([A-Za-z]+)/.exec(mail.text)![1]!;
  };

  test("just under the budget still compares", async () => {
    const client = "198.51.100.82";
    const headers = { "cf-connecting-ip": client };
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email, { headers });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: clientOf(client),
      attempts: magicLinkCodeBudgets.clientPerHour - 1,
    });
    flow.signedIn(await flow.enter(code!, cookie, headers));
  });

  test("only the last hour counts", async () => {
    const client = "198.51.100.83";
    const headers = { "cf-connecting-ip": client };
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email, { headers });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: clientOf(client),
      attempts: magicLinkCodeBudgets.clientPerHour,
      createdAt: new Date(Date.now() - 3_601_000),
    });
    flow.signedIn(await flow.enter(code!, cookie, headers));
  });

  test("asking from one client and guessing from another does not escape the asker's budget", async () => {
    const asker = "198.51.100.84";
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email, {
      headers: { "cf-connecting-ip": asker },
    });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: clientOf(asker),
      attempts: magicLinkCodeBudgets.clientPerHour,
    });
    const { error } = console;
    console.error = () => {};
    try {
      const answer = await flow.enter(code!, cookie, {
        "cf-connecting-ip": "198.51.100.85",
      });
      expect(answer.headers.getSetCookie()).toEqual([]);
    } finally {
      console.error = error;
    }
    expect(await attemptsOf(person.email)).toEqual([0]);
  });

  test("a thousand an hour for a firm stops comparing there and names which, and another firm goes on", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const { cookie, code } = await flow.ask(person.email);
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      attempts: magicLinkCodeBudgets.organizationPerHour,
    });
    const other = await firm();
    const elsewhere = await flow.listed(other);
    const theirs = await flow.ask(elsewhere.email, { cookie });
    const lines: string[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const answer = await flow.enter(code!, cookie);
      expect(answer.status).toBe(200);
    } finally {
      console.error = error;
    }
    expect(lines.join()).toContain('"budget":"organization"');
    expect(lines.join()).toContain(organization.id);
    expect(await attemptsOf(person.email)).toEqual([0]);
    // The browser's other firm was compared and counted.
    expect(await attemptsOf(elsewhere.email)).toEqual([1]);
    flow.signedIn(await flow.enter(theirs.code!, cookie));
  });

  test("the counts add up attempts, on the partial indexes", async () => {
    const organization = await firm();
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: "counted",
      attempts: 2,
    });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: "counted",
      attempts: 3,
    });
    await spend({
      organizationId: organization.id,
      providerId: organization.magicLink.id,
      clientHash: "counted",
      attempts: 0,
    });
    const count = (query: ReturnType<typeof sql>) =>
      withDatabaseScope(fixture.appDb, { kind: "protocol" }, async (tx) => {
        const { rows } = await tx.execute<{ wrong: number }>(query);
        return rows[0]!.wrong;
      });
    expect(await count(clientCodeFailures("counted"))).toBe(5);
    expect(await count(organizationCodeFailures(organization.id))).toBe(5);
    expect(await count(clientCodeFailures("nobody"))).toBe(0);

    const plan = async (query: ReturnType<typeof sql>) => {
      await fixture.db.execute(sql`analyze magic_link_requests`);
      return fixture.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const { rows } = await tx.execute<{ "QUERY PLAN": string }>(
          sql`explain ${query}`,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
    };
    expect(await plan(clientCodeFailures("counted"))).toContain(
      "magic_link_requests_client_attempted_idx",
    );
    expect(await plan(organizationCodeFailures(organization.id))).toContain(
      "magic_link_requests_organization_attempted_idx",
    );
  });
});

test("a code from another request's mail, or the same digits on another row, compares as wrong", async () => {
  const organization = await firm();
  const one = await flow.listed(organization);
  const two = await flow.listed(organization);
  const first = await flow.ask(one.email);
  const second = await flow.ask(two.email);
  const answer = await flow.enter(second.code!, first.cookie);
  expect(answer.headers.getSetCookie()).toEqual([]);
  expect(await attemptsOf(one.email)).toEqual([1]);
  expect(codeIn(second.mail!)).toBe(second.code);
});
