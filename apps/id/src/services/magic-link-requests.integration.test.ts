import {
  createPostmarkTransport,
  type Message,
  type Transport,
} from "@answerable/emails";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";

import {
  browser,
  capturingLogs,
  client,
  codeIn,
  linkIn,
  openMagicLinkFixture,
  tokenIn,
  type MagicLinkFixture,
} from "../__tests__/magic-link-requests.ts";
import {
  magicLinkBrowserHash,
  magicLinkIdentifier,
  magicLinkKeys,
} from "../auth/magic-link.ts";
import { magicLinkRequests } from "../db/schema/index.ts";
import {
  addressRequestCounts,
  magicLinkDrainDeadlineMs,
} from "./magic-link-requests.ts";

let fixture: MagicLinkFixture;
beforeAll(async () => {
  fixture = await openMagicLinkFixture();
});
afterAll(() => fixture?.close());
beforeEach(() => {
  fixture.transport.failure = undefined;
});

const failed = (errorCode: number | null, httpStatus: number | null) => ({
  status: "failed" as const,
  errorCode,
  httpStatus,
  retried: false,
});

/** A transport that fails until told otherwise, keeping nothing. */
function failing(result = failed(null, 500)): Transport {
  return { send: async () => result };
}

describe("what is stored", () => {
  test("no raw token and no raw code in the database, and both in the mail", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await fixture.ask(email);
    const [mail] = fixture.mailsTo(email);
    const token = tokenIn(mail!)!;
    const code = codeIn(mail!)!;
    expect(linkIn(mail!)).toBe(
      `http://localhost:47300/magic-link?token=${token}`,
    );
    expect(mail!.html).toContain(token);
    expect(mail!.html).toContain(code);

    const [row] = await fixture.rows(email);
    const [verification] = await fixture.tokens([row!.tokenIdentifier]);
    const everything = JSON.stringify([row, verification]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(code);
    // The row and the plugin's record agree on the one identifier.
    expect(row!.tokenIdentifier).toBe(magicLinkIdentifier(token));
    expect(verification!.identifier).toBe(magicLinkIdentifier(token));
    expect(JSON.parse(verification!.value)).toEqual({
      type: "magic-link",
      email,
    });
    expect(row!.browserHash).toBe(magicLinkBrowserHash(browser));
    expect(row!.clientHash).toBe(
      magicLinkKeys(fixture.environment).clientHash(client),
    );
    expect(row!.codeHmac).toBe(
      magicLinkKeys(fixture.environment).codeHmac(row!.id, code),
    );
    expect(row!.attempts).toBe(0);
  });

  test("the link and the row last thirty minutes, and the pending query is kept", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await fixture.ask(email, { pendingQuery: "client_id=a&sig=b" });
    const [row] = await fixture.rows(email);
    expect(row!.pendingOauthQuery).toBe("client_id=a&sig=b");
    const minutes =
      (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(29.9);
    expect(minutes).toBeLessThan(30.1);
    const [verification] = await fixture.tokens([row!.tokenIdentifier]);
    const remaining = verification!.expiresAt.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(29 * 60_000);
    expect(remaining).toBeLessThanOrEqual(30 * 60_000);
  });

  test("the same code on two requests gives two different HMACs", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await fixture.ask(email, { client: "198.51.100.1" });
    await fixture.ask(email, { client: "198.51.100.2" });
    const [first, second] = await fixture.rows(email);
    const [mail] = fixture.mailsTo(email);
    const code = codeIn(mail!)!;
    const keys = magicLinkKeys(fixture.environment);
    expect(first!.codeHmac).toBe(keys.codeHmac(first!.id, code));
    expect(keys.codeHmac(second!.id, code)).not.toBe(first!.codeHmac);
  });

  test("a row can sign in once it is made: it says `sent` and holds its token while the send runs", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    let during: { status: string; held: number } | undefined;
    const requests = fixture.instance({
      transport: {
        send: async () => {
          const rows = await fixture.rows(email);
          const held = await fixture.tokens([rows[0]!.tokenIdentifier]);
          during = { status: rows[0]!.sendStatus, held: held.length };
          return { status: "sent", messageId: "m" };
        },
      },
    });
    await requests.process({
      address: email,
      browser,
      client,
      pendingQuery: null,
    });
    expect(during).toEqual({ status: "sent", held: 1 });
    expect((await fixture.rows(email))[0]!.sendStatus).toBe("sent");
  });

  test("no connection is held through a send, on a pool of one", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const { createRuntimeLogin } = await import("../__tests__/runtime-role.ts");
    const { createAuth } = await import("../auth.ts");
    const { createMagicLinkRequests } =
      await import("./magic-link-requests.ts");
    const login = await createRuntimeLogin(
      fixture.owner.db,
      fixture.environment,
      { databasePoolMax: 1 },
    );
    try {
      let idle = -1;
      const requests = createMagicLinkRequests({
        auth: createAuth(login.connection.db, fixture.environment),
        db: login.connection.db,
        environment: fixture.environment,
        transport: {
          send: async () => {
            idle = login.connection.pool.idleCount;
            return { status: "sent", messageId: "m" };
          },
        },
      });
      expect(
        await requests.process({
          address: email,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toMatchObject({ outcome: "sent" });
      expect(idle).toBe(1);
    } finally {
      await login.drop();
    }
  });

  test("a firm whose name the mail refuses rolls the whole request back", async () => {
    const firm = await fixture.firm("  ");
    const { email } = await fixture.member(firm);
    const before = (await fixture.magicLinkVerifications()).length;
    await expect(fixture.ask(email)).rejects.toThrow(TypeError);
    expect(await fixture.rows(email)).toEqual([]);
    expect(await fixture.magicLinkVerifications()).toHaveLength(before);
    expect(fixture.mailsTo(email)).toEqual([]);
  });

  test("a row that cannot be written leaves no token behind", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const before = (await fixture.magicLinkVerifications()).length;
    // Postgres refuses this text, after the token is stored.
    await expect(
      fixture.ask(email, { pendingQuery: "client_id=a\u0000" }),
    ).rejects.toBeDefined();
    expect(await fixture.rows(email)).toEqual([]);
    expect(await fixture.magicLinkVerifications()).toHaveLength(before);
    expect(fixture.mailsTo(email)).toEqual([]);
  });

  test("an address the parser refuses costs nothing", async () => {
    const firm = await fixture.firm();
    const requests = fixture.instance();
    const before = fixture.transport.sent.length;
    for (const address of [
      `${"a".repeat(255)}@${firm.domain}`,
      `"alice"@${firm.domain}`,
      `alice=tag@${firm.domain}`,
      `a..b@${firm.domain}`,
      `a@b@${firm.domain}`,
      "not an address",
      "",
    ]) {
      expect(
        await requests.process({
          address,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toEqual({
        outcome: "invalid",
      });
      // It says nothing of the address: the queue had room.
      expect(
        requests.request({ address, browser, client, pendingQuery: null }),
      ).toBe(true);
    }
    expect(await requests.drain(1_000)).toEqual({ abandoned: 0, running: 0 });
    expect(fixture.transport.sent).toHaveLength(before);
  });
});

/** Run this statement under EXPLAIN ANALYZE, with no sequential scan to fall back on. */
async function explained(statement: SQL) {
  return fixture.owner.db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const { rows } = await tx.execute<{ "QUERY PLAN": unknown[] }>(
      sql`explain (analyze, format json) ${statement}`,
    );
    return rows[0]!["QUERY PLAN"];
  });
}

describe("the limits", () => {
  const member = async () => (await fixture.member(await fixture.firm())).email;

  test("one per address and client in 60 seconds, freed at 60", async () => {
    const email = await member();
    expect((await fixture.ask(email)).outcome).toBe("sent");
    const limited = await fixture.ask(email);
    expect(limited).toEqual({
      outcome: "limited",
      limit: "address_client_minute",
    });
    await fixture.age(email, 58);
    expect((await fixture.ask(email)).outcome).toBe("limited");
    await fixture.age(email, 3);
    expect((await fixture.ask(email)).outcome).toBe("sent");
    expect(fixture.mailsTo(email)).toHaveLength(2);
    expect(await fixture.rows(email)).toHaveLength(2);
  });

  test("different clients do not share the 60-second limit, and each has its own hour", async () => {
    const email = await member();
    expect((await fixture.ask(email, { client: "198.51.100.1" })).outcome).toBe(
      "sent",
    );
    expect((await fixture.ask(email, { client: "198.51.100.2" })).outcome).toBe(
      "sent",
    );
    expect((await fixture.ask(email, { client: "198.51.100.1" })).outcome).toBe(
      "limited",
    );
    for (let count = 0; count < 4; count++) {
      await fixture.age(email, 61);
      expect(
        (await fixture.ask(email, { client: "198.51.100.1" })).outcome,
      ).toBe("sent");
    }
    await fixture.age(email, 61);
    expect(await fixture.ask(email, { client: "198.51.100.1" })).toEqual({
      outcome: "limited",
      limit: "address_client_hour",
    });
    expect((await fixture.ask(email, { client: "198.51.100.3" })).outcome).toBe(
      "sent",
    );
  });

  test("the fifth in an hour passes, the sixth is dropped, and an hour later it passes", async () => {
    const email = await member();
    for (let count = 0; count < 5; count++) {
      expect((await fixture.ask(email)).outcome).toBe("sent");
      await fixture.age(email, 61);
    }
    expect(await fixture.ask(email)).toEqual({
      outcome: "limited",
      limit: "address_client_hour",
    });
    expect(fixture.mailsTo(email)).toHaveLength(5);
    await fixture.madeAgo(email, 59 * 60);
    expect((await fixture.ask(email)).outcome).toBe("limited");
    await fixture.madeAgo(email, 61 * 60);
    expect((await fixture.ask(email)).outcome).toBe("sent");
  });

  /** `count` earlier requests by others, in one firm, for addresses `addressOf` names. */
  function earlier(
    organizationId: string,
    addressOf: string,
    count: number,
    {
      age = "0 seconds",
      status = "sent",
    }: { age?: string; status?: string } = {},
  ) {
    return fixture.owner.pool.query(
      `insert into magic_link_requests (id, organization_id, provider_id, provider_revision, purpose, email, token_identifier, browser_hash, code_hmac, client_hash, expires_at, send_status, created_at)
       select uuid_v7(), $1, (select id from sso_providers where organization_id = $1 and kind = 'magic_link'), 1, 'link',
         replace($2, '#', n::text), 'magic-link:earlier-' || gen_random_uuid(), 'other-browser', 'other-code', 'other-client-' || n, now(), $3, now() - $4::interval
       from generate_series(1, $5::int) n`,
      [organizationId, addressOf, status, age, count],
    );
  }

  test("the fiftieth in a day passes, the fifty-first is dropped, and a day later it passes", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await earlier(firm.id, email, 49, { age: "23 hours" });
    expect((await fixture.ask(email)).outcome).toBe("sent");
    await fixture.age(email, 61);
    expect(await fixture.ask(email)).toEqual({
      outcome: "limited",
      limit: "address_day",
    });
    expect(await fixture.ask(email, { client: "198.51.100.9" })).toEqual({
      outcome: "limited",
      limit: "address_day",
    });
    await fixture.age(email, 86_400);
    expect((await fixture.ask(email)).outcome).toBe("sent");
  });

  test("no count of a firm's mail holds back its next person", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    await earlier(firm.id, `filler#@${firm.domain}`, 6_000, {
      age: "10 minutes",
    });
    expect((await fixture.ask(email)).outcome).toBe("sent");
    await fixture.owner.db
      .delete(magicLinkRequests)
      .where(eq(magicLinkRequests.organizationId, firm.id));
  }, 30_000);

  test("the address's count reads its index", async () => {
    const [plan] = await explained(
      addressRequestCounts("person@example.com", "client"),
    );
    expect(JSON.stringify(plan)).toContain(
      "magic_link_requests_email_created_at_idx",
    );
  });

  test("a removed person, and a disabled one, cost nothing: no row and no mail", async () => {
    const firm = await fixture.firm();
    const removed = await fixture.member(firm, "removed");
    await fixture.owner.pool.query(
      `update members set status = 'revoked', revoked_at = now() where id = $1`,
      [removed.memberId],
    );
    const disabled = await fixture.member(firm, "disabled");
    await fixture.owner.pool.query(
      `update users set status = 'disabled', disabled_at = now() where id = $1`,
      [disabled.userId],
    );
    for (const { email } of [removed, disabled]) {
      expect(await fixture.ask(email)).toEqual({ outcome: "stranger" });
      expect(await fixture.rows(email)).toEqual([]);
      expect(fixture.mailsTo(email)).toEqual([]);
    }
  });

  test("a failed send costs nothing, at any limit", async () => {
    const email = await member();
    const down = fixture.instance({ transport: failing() });
    for (let count = 0; count < 8; count++)
      expect(
        (
          await down.process({
            address: email,
            browser,
            client,
            pendingQuery: null,
          })
        ).outcome,
      ).toBe("failed");
    // Eight failures in a row, and the next request is not limited by any of them.
    expect((await fixture.ask(email)).outcome).toBe("sent");
    expect(fixture.mailsTo(email)).toHaveLength(1);
  });

  test("a row counts from when it is made, so a request racing a send is dropped", async () => {
    const email = await member();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inSend = () => {};
    const sending = new Promise<void>((resolve) => {
      inSend = resolve;
    });
    const slow = fixture.instance({
      transport: {
        send: async () => {
          inSend();
          await held;
          return { status: "sent", messageId: "slow" };
        },
      },
    });
    const first = slow.process({
      address: email,
      browser,
      client,
      pendingQuery: null,
    });
    await sending;
    expect(await fixture.ask(email)).toEqual({
      outcome: "limited",
      limit: "address_client_minute",
    });
    release();
    expect((await first).outcome).toBe("sent");
  });

  test("two replicas racing one address send one mail, and the other drops", async () => {
    for (let round = 0; round < 5; round++) {
      const firm = await fixture.firm();
      const { email } = await fixture.member(firm);
      const one = fixture.instance();
      const two = fixture.instance();
      const request = { address: email, browser, client, pendingQuery: null };
      const outcomes = await Promise.all([
        one.process(request),
        two.process(request),
      ]);
      expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
        "limited",
        "sent",
      ]);
      expect(fixture.mailsTo(email)).toHaveLength(1);
      expect(await fixture.rows(email)).toHaveLength(1);
    }
  });

  test("two replicas racing through their queues send one mail", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const one = fixture.instance();
    const two = fixture.instance();
    const request = { address: email, browser, client, pendingQuery: null };
    await capturingLogs(async () => {
      for (let count = 0; count < 4; count++) {
        expect(one.request(request)).toBe(true);
        expect(two.request(request)).toBe(true);
      }
      await Promise.all([one.drain(10_000), two.drain(10_000)]);
    });
    expect(fixture.mailsTo(email)).toHaveLength(1);
  });
});

describe("a send that fails", () => {
  test("a 406 stores Postmark's code and status, removes the token and leaves the row unusable", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const fetch = async () =>
      Response.json(
        { ErrorCode: 406, Message: `${email} is inactive` },
        { status: 422 },
      );
    const requests = fixture.instance({
      transport: createPostmarkTransport({
        serverToken: "t",
        from: "f@example.com",
        replyTo: "r@example.com",
        fetch,
      }),
    });
    const logged = await capturingLogs(async (lines) => {
      expect(
        await requests.process({
          address: email,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toMatchObject({ outcome: "failed", purpose: "link" });
      return lines;
    });
    const [row] = await fixture.rows(email);
    expect(row).toMatchObject({
      sendStatus: "failed",
      postmarkErrorCode: 406,
      postmarkHttpStatus: 422,
    });
    expect(row!.tokenIdentifier).not.toBeNull();
    expect(await fixture.tokens([row!.tokenIdentifier])).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.slice(logged[0]!.indexOf("{")))).toEqual({
      level: "error",
      event: "magic_link_send_failed",
      requestId: row!.id,
      organizationId: firm.id,
      purpose: "link",
      errorCode: 406,
      httpStatus: 422,
      retried: false,
    });
    expect(logged[0]).not.toContain(email);
  });

  test("a 5xx then success is one sent row, and the token stands", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const answers = [
      () => new Response("down", { status: 503 }),
      () => Response.json({ ErrorCode: 0, MessageID: "m1" }),
    ];
    let bodies = 0;
    const requests = fixture.instance({
      transport: createPostmarkTransport({
        serverToken: "t",
        from: "f@example.com",
        replyTo: "r@example.com",
        retryDelayMs: 0,
        fetch: async () => answers[bodies++]!(),
      }),
    });
    expect(
      await requests.process({
        address: email,
        browser,
        client,
        pendingQuery: null,
      }),
    ).toMatchObject({ outcome: "sent" });
    expect(bodies).toBe(2);
    const [row] = await fixture.rows(email);
    expect(row).toMatchObject({
      sendStatus: "sent",
      postmarkErrorCode: null,
      postmarkHttpStatus: null,
    });
    expect(await fixture.tokens([row!.tokenIdentifier])).toHaveLength(1);
  });

  test("a timeout on both tries is failed with no code and no status", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    let tries = 0;
    const requests = fixture.instance({
      transport: createPostmarkTransport({
        serverToken: "t",
        from: "f@example.com",
        replyTo: "r@example.com",
        retryDelayMs: 0,
        timeoutMs: 10,
        fetch: async (_, init) =>
          new Promise<Response>((_, reject) => {
            tries++;
            init.signal!.addEventListener("abort", () =>
              reject(init.signal!.reason),
            );
          }),
      }),
    });
    await capturingLogs(async () => {
      expect(
        await requests.process({
          address: email,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toMatchObject({ outcome: "failed" });
    });
    expect(tries).toBe(2);
    const [row] = await fixture.rows(email);
    expect(row).toMatchObject({
      sendStatus: "failed",
      postmarkErrorCode: null,
      postmarkHttpStatus: null,
    });
    expect(await fixture.tokens([row!.tokenIdentifier])).toEqual([]);
  });

  test("the memory transport's failure is recorded the same way, and no mail is kept", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    fixture.transport.failure = failed(300, 422);
    await capturingLogs(() => fixture.ask(email));
    expect(fixture.mailsTo(email)).toEqual([]);
    expect((await fixture.rows(email))[0]).toMatchObject({
      sendStatus: "failed",
      postmarkErrorCode: 300,
      postmarkHttpStatus: 422,
    });
  });

  test("a transport that throws is a failed send", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const requests = fixture.instance({
      transport: {
        send: async () => {
          throw new TypeError("The recipient must be one plain address");
        },
      },
    });
    await capturingLogs(async () => {
      expect(
        (
          await requests.process({
            address: email,
            browser,
            client,
            pendingQuery: null,
          })
        ).outcome,
      ).toBe("failed");
    });
    const [row] = await fixture.rows(email);
    expect(row!.sendStatus).toBe("failed");
    expect(await fixture.tokens([row!.tokenIdentifier])).toEqual([]);
  });

  test("a failure that cannot be recorded leaves the row as it was made, and escapes nothing", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    const blocker = await fixture.owner.pool.connect();
    const requests = fixture.instance({
      transport: {
        send: async () => {
          await blocker.query("begin");
          await blocker.query(
            "lock table magic_link_requests in access exclusive mode",
          );
          return failed(500, 500);
        },
      },
    });
    const lines = await capturingLogs(async (lines) => {
      expect(
        requests.request({
          address: email,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toBe(true);
      await requests.drain(10_000);
      return lines;
    });
    await blocker.query("rollback");
    blocker.release();
    expect(lines).toEqual([
      `[id] magic link ${JSON.stringify({ level: "error", event: "magic_link_job_failed", name: "Error", code: "55P03" })}`,
    ]);
    const [row] = await fixture.rows(email);
    expect(row!.sendStatus).toBe("sent");
    expect(await fixture.ask(email)).toEqual({
      outcome: "limited",
      limit: "address_client_minute",
    });
  });
});

describe("the logs", () => {
  test("no line holds an address, a token, a code, a link or a hash of any of them", async () => {
    const firm = await fixture.firm();
    const { email: sent } = await fixture.member(firm, "sent");
    const { email: limited } = await fixture.member(firm, "limited");
    const { email: lost } = await fixture.member(firm, "lost");
    const { email: revoked, memberId } = await fixture.member(firm, "revoked");
    await fixture.owner.pool.query(
      `update members set status = 'revoked', revoked_at = now() where id = $1`,
      [memberId],
    );
    const stranger = `stranger@${firm.domain}`;
    const down = fixture.instance({ transport: failing(failed(406, 422)) });
    const lines = await capturingLogs(async (lines) => {
      await fixture.ask(sent);
      await fixture.ask(limited);
      await fixture.ask(limited);
      await fixture.ask(revoked);
      await fixture.ask(stranger);
      await down.process({
        address: lost,
        browser,
        client,
        pendingQuery: "client_id=a&sig=b",
      });
      return lines;
    });
    expect(lines).toHaveLength(6);

    const mails = fixture.transport.sent.filter((message) =>
      [sent, limited].includes(message.to),
    );
    const rows = (
      await Promise.all([sent, limited, lost, revoked].map(fixture.rows))
    ).flat();
    const secrets = [
      sent,
      limited,
      lost,
      revoked,
      stranger,
      firm.domain,
      browser,
      client,
      "client_id=a",
      ...mails.flatMap((mail) => [tokenIn(mail), codeIn(mail), linkIn(mail)]),
      ...rows.flatMap((row) => [
        row.tokenIdentifier,
        row.browserHash,
        row.clientHash,
        row.codeHmac,
      ]),
    ].filter((value): value is string => Boolean(value));
    expect(secrets.length).toBeGreaterThan(15);
    for (const line of lines)
      for (const secret of secrets) expect(line).not.toContain(secret);

    const events = lines.map((line) =>
      JSON.parse(line.slice(line.indexOf("{"))),
    );
    const of = (email: string) => rows.find((row) => row.email === email)?.id;
    expect(events).toEqual([
      {
        event: "magic_link_request",
        outcome: "sent",
        requestId: of(sent),
        organizationId: firm.id,
        purpose: "link",
      },
      {
        event: "magic_link_request",
        outcome: "sent",
        requestId: of(limited),
        organizationId: firm.id,
        purpose: "link",
      },
      {
        event: "magic_link_request",
        outcome: "limited",
        limit: "address_client_minute",
        requestId: expect.any(String),
        organizationId: firm.id,
      },
      // Someone removed logs as a stranger does, with no organisation: a log cannot say which firm
      // was asked about.
      { event: "magic_link_request", outcome: "stranger" },
      { event: "magic_link_request", outcome: "stranger" },
      {
        level: "error",
        event: "magic_link_send_failed",
        requestId: of(lost),
        organizationId: firm.id,
        purpose: "link",
        errorCode: 406,
        httpStatus: 422,
        retried: false,
      },
    ]);
  });

  test("a job that fails logs its class and SQLSTATE, and never the message", async () => {
    const firm = await fixture.firm("  ");
    const { email } = await fixture.member(firm);
    const requests = fixture.instance();
    const lines = await capturingLogs(async (lines) => {
      expect(
        requests.request({
          address: email,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toBe(true);
      await requests.drain(5_000);
      return lines;
    });
    expect(lines).toEqual([
      `[id] magic link ${JSON.stringify({ level: "error", event: "magic_link_job_failed", name: "TypeError" })}`,
    ]);
  });
});

describe("the queue around the job", () => {
  test("overflow is dropped and counted, and the rest go out", async () => {
    const firm = await fixture.firm();
    const people = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fixture.member(firm, `queued${index}`),
      ),
    );
    const requests = fixture.instance({
      queue: { maxLength: 2, concurrency: 1 },
    });
    const lines = await capturingLogs(async (lines) => {
      const taken = people.map(({ email }) =>
        requests.request({
          address: email,
          browser,
          client,
          pendingQuery: null,
        }),
      );
      expect(taken).toEqual([true, true, false, false, false]);
      await requests.drain(5_000);
      return lines;
    });
    expect(
      lines
        .filter((line) => line.includes("magic_link_queue_overflow"))
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))).dropped),
    ).toEqual([1, 2, 3]);
    expect(
      fixture.transport.sent.filter(({ to }) => to.includes("queued")),
    ).toHaveLength(2);
    // Taking nothing after the drain began.
    expect(
      await capturingLogs(async (lines) => {
        expect(
          requests.request({
            address: people[0]!.email,
            browser,
            client,
            pendingQuery: null,
          }),
        ).toBe(false);
        return lines;
      }),
    ).toHaveLength(1);
  });

  test("sends never exceed the concurrency, measured, and four hundred requests lose none", async () => {
    const firm = await fixture.firm();
    const emails = Array.from(
      { length: 400 },
      (_, index) => `load${index}@${firm.domain}`,
    );
    await fixture.owner.pool.query(
      `with made as (
         insert into users (id, name, email, email_verified, status)
         select uuid_v7(), 'Load', address, true, 'active' from unnest($1::text[]) address
         returning id
       )
       insert into members (id, organization_id, user_id)
       select uuid_v7(), $2, id from made`,
      [emails, firm.id],
    );
    let running = 0;
    let peak = 0;
    const delivered: Message[] = [];
    const requests = fixture.instance({
      transport: {
        send: async (message) => {
          peak = Math.max(peak, ++running);
          await Bun.sleep(30);
          running--;
          delivered.push(message);
          return { status: "sent", messageId: "m" };
        },
      },
    });
    const errors = await capturingLogs(async (lines) => {
      for (const address of emails)
        expect(
          requests.request({ address, browser, client, pendingQuery: null }),
        ).toBe(true);
      expect(await requests.drain(magicLinkDrainDeadlineMs)).toEqual({
        abandoned: 0,
        running: 0,
      });
      return lines.filter((line) => line.includes('"level":"error"'));
    });
    expect(errors).toEqual([]);
    expect(delivered).toHaveLength(400);
    expect(new Set(delivered.map(({ to }) => to)).size).toBe(400);
    expect(peak).toBe(5);
  }, 60_000);

  test("the service's queue holds five hundred, and drops the next", async () => {
    const firm = await fixture.firm();
    const requests = fixture.instance();
    const lines = await capturingLogs(async (lines) => {
      const taken = Array.from({ length: 502 }, (_, index) =>
        requests.request({
          address: `stranger${index}@${firm.domain}`,
          browser,
          client,
          pendingQuery: null,
        }),
      );
      expect(taken.filter(Boolean)).toHaveLength(500);
      expect(taken.slice(500)).toEqual([false, false]);
      await requests.drain(magicLinkDrainDeadlineMs);
      return lines;
    });
    expect(
      lines.filter((line) => line.includes('"outcome":"stranger"')),
    ).toHaveLength(500);
  }, 60_000);

  test("a job left running at the deadline is reported, and fails harmlessly when it ends", async () => {
    const firm = await fixture.firm();
    const { email } = await fixture.member(firm);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = fixture.instance({
      queue: { maxLength: 5, concurrency: 1 },
      transport: {
        send: async () => {
          await held;
          return { status: "sent", messageId: "late" };
        },
      },
    });
    const { email: waiting } = await fixture.member(firm, "waiting");
    const lines = await capturingLogs(async (lines) => {
      requests.request({ address: email, browser, client, pendingQuery: null });
      requests.request({
        address: waiting,
        browser,
        client,
        pendingQuery: null,
      });
      const started = Date.now();
      expect(await requests.drain(50)).toEqual({ abandoned: 1, running: 1 });
      expect(Date.now() - started).toBeLessThan(2_000);
      release();
      await Bun.sleep(100);
      return lines;
    });
    expect(
      lines.filter((line) => line.includes("magic_link_queue_abandoned")),
    ).toEqual([
      `[id] magic link ${JSON.stringify({ level: "error", event: "magic_link_queue_abandoned", abandoned: 1, running: 1 })}`,
    ]);
    expect(await fixture.rows(waiting)).toEqual([]);
  });
});
