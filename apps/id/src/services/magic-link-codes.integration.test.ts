import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { magicLinkFlow } from "../__tests__/magic-link-flow.ts";
import { codeIn } from "../__tests__/magic-link-requests.ts";
import { magicLinkRequests } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

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
    const [ended] = await flow.requestsOf(person.email);
    expect(ended!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
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
    // It was the third try, and it is over because it signed in.
    expect(await attemptsOf(person.email)).toEqual([3]);
    expect(await exhausted(person.row.id)).toEqual([]);
  });

  test("the third wrong code ends the request with its count: when its audit row cannot be written, the link is dead all the same", async () => {
    const person = await asked();
    await flow.enter(person.wrong, person.cookie);
    await flow.enter(person.wrong, person.cookie);
    const { error } = console;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    await fixture.db.execute(
      sql`alter table audit_events add constraint refuses_for_test check (action <> 'auth.magic_link.code_exhausted') not valid`,
    );
    try {
      await flow.enter(person.wrong, person.cookie);
    } finally {
      console.error = error;
      await fixture.db.execute(
        sql`alter table audit_events drop constraint refuses_for_test`,
      );
    }
    expect(lines.join()).toContain("magic_link_audit_unavailable");
    expect(await exhausted(person.row.id)).toEqual([]);
    const page = await flow.open(person.token, person.cookie);
    expect(await page.text()).not.toContain(person.email);
    expect(
      (await flow.follow(person.token, person.cookie)).headers.getSetCookie(),
    ).toEqual([]);
    expect(await flow.sessionsOf(person.userId)).toEqual([]);
  });

  test("a right third code whose sign-in failed leaves the link working, and compares no fourth", async () => {
    const person = await asked();
    await flow.enter(person.wrong, person.cookie);
    await flow.enter(person.wrong, person.cookie);
    const realApi = fixture.auth.api.confirmMagicLink;
    fixture.auth.api.confirmMagicLink = (async () => {
      throw new Error("The database went away");
    }) as never;
    const { error } = console;
    console.error = () => {};
    try {
      await flow.enter(person.code, person.cookie);
    } finally {
      console.error = error;
      fixture.auth.api.confirmMagicLink = realApi;
    }
    expect(await attemptsOf(person.email)).toEqual([3]);
    expect(await exhausted(person.row.id)).toEqual([]);
    expect(
      (await flow.enter(person.code, person.cookie)).headers.getSetCookie(),
    ).toEqual([]);
    expect(await attemptsOf(person.email)).toEqual([3]);
    flow.signedIn(await flow.follow(person.token, person.cookie));
  });

  test("wrong codes on other requests, from this client or this firm, never stop a right one", async () => {
    const organization = await firm();
    const person = await flow.listed(organization);
    const client = { "cf-connecting-ip": "198.51.100.81" };
    const { cookie, code } = await flow.ask(person.email, { headers: client });
    const [template] = await flow.requestsOf(person.email);
    for (let index = 0; index < 40; index++)
      await fixture.db.insert(magicLinkRequests).values({
        ...template!,
        id: createId(),
        email: `guessed-${index}@${organization.domain}`,
        tokenIdentifier: `magic-link:guessed-${createId()}`,
        browserHash: `guessed-${index}`,
        attempts: 3,
        expiresAt: new Date(Date.now() - 1_000),
      });
    flow.signedIn(await flow.enter(code!, cookie, client));
    expect(await flow.sessionsOf(person.userId)).toHaveLength(1);
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

  test("a count commits before the sign-in: one that fails after it still counts", async () => {
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
  test("a failed row and an expired one count nothing and sign nobody in", async () => {
    for (const change of [
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
    // The older request's code signs in on its own row, and the newer counted a miss, its third.
    flow.signedIn(await flow.enter(first.code!, first.cookie));
    const rows = await flow.requestsOf(person.email);
    expect(rows.map((row) => row.attempts)).toEqual([3, 3]);
    expect(rows[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows[1]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
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
