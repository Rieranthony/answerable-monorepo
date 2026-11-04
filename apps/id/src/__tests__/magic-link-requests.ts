import type { Message, Transport } from "@answerable/emails";
import { createMemoryTransport } from "@answerable/emails/testing";
import { eq, inArray, like, sql } from "drizzle-orm";

import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { bootstrap, systemActor } from "../bootstrap.ts";
import {
  magicLinkRequests,
  members,
  organizationDomains,
  organizations,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { createMagicLinkRequests } from "../services/magic-link-requests.ts";
import { turnLinksOn } from "./magic-link.ts";
import { openRuntimeRole } from "./runtime-role.ts";
import { testEnvironment } from "./support.ts";

/** One request's browser and client, unless a test names its own. */
export const browser = "browser-cookie-value-that-is-long-and-random";
export const client = "203.0.113.7";

export const tokenIn = ({ text }: Message) =>
  /\/magic-link\?token=([A-Za-z]+)/.exec(text)?.[1];
export const codeIn = ({ text }: Message) => /^(\d{8})$/m.exec(text)?.[1];
export const linkIn = ({ text }: Message) =>
  /https?:\/\/\S*magic-link\?token=\S+/.exec(text)?.[0];

/** Every line the process wrote while `run` ran, to any of the three streams it logs to. */
export async function capturingLogs<T>(run: (lines: string[]) => Promise<T>) {
  const lines: string[] = [];
  const write = (...args: unknown[]) => void lines.push(args.join(" "));
  const { log, error, warn } = console;
  Object.assign(console, { log: write, error: write, warn: write });
  try {
    return await run(lines);
  } finally {
    Object.assign(console, { log, error, warn });
  }
}

/**
 * The job on a fresh restricted runtime login, RLS and grants applying, with the owner
 * beside it to seed and to read what the runtime role cannot. It truncates first, and the
 * platform organisation is bootstrapped, so its row is off as a deployment's is.
 */
export async function openMagicLinkFixture() {
  const environment = testEnvironment();
  const roles = await openRuntimeRole(environment);
  const { owner, runtime } = roles;
  // Each request writes a line; a test that reads them uses `capturingLogs`.
  const { log } = console;
  console.log = () => {};
  const platform = await bootstrap(owner.db, systemActor("magic-link-tests"), {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: environment.platformOrganizationName,
    adminResourceIdentifier: environment.adminResourceIdentifier,
  });
  const auth = createAuth(runtime.db, environment);
  const transport = createMemoryTransport();

  /** A firm with one active domain, on the magic-link row the trigger made, turned on. */
  async function firm(name = "Acme Surveyors") {
    const id = createId();
    const slug = `firm-${id}`;
    const domain = `${slug}.example.com`;
    await owner.db.insert(organizations).values({ id, slug, name });
    await turnLinksOn(owner.db, id);
    const domainId = createId();
    await owner.db
      .insert(organizationDomains)
      .values({ id: domainId, organizationId: id, domain });
    return { id, slug, domain, domainId, name };
  }
  type Firm = Awaited<ReturnType<typeof firm>>;

  /** An active user at the firm's domain, with no membership until `member` makes one. */
  async function person(of: Pick<Firm, "domain">, local = "person") {
    const userId = createId();
    const email = `${local}@${of.domain}`;
    await owner.db.insert(users).values({
      id: userId,
      name: local,
      email,
      emailVerified: true,
      status: "active",
    });
    return { userId, email };
  }

  /** A person the firm lists, as staff import or a directory sign-in leaves one. */
  async function member(
    of: Pick<Firm, "id" | "domain">,
    local?: string,
    window: { validFrom?: Date; validUntil?: Date } = {},
  ) {
    const holder = await person(of, local);
    const memberId = createId();
    await owner.db.insert(members).values({
      id: memberId,
      organizationId: of.id,
      userId: holder.userId,
      ...window,
    });
    return { ...holder, memberId };
  }

  const rows = (email: string) =>
    owner.db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, email))
      .orderBy(magicLinkRequests.id);

  /** Move every request of this address back, as if it had been made that long ago. */
  const age = (email: string, seconds: number) =>
    owner.db
      .update(magicLinkRequests)
      .set({
        createdAt: sql`${magicLinkRequests.createdAt} - make_interval(secs => ${seconds})`,
      })
      .where(eq(magicLinkRequests.email, email));

  /** Say every request of this address was made exactly that long ago. */
  const madeAgo = (email: string, seconds: number) =>
    owner.db
      .update(magicLinkRequests)
      .set({ createdAt: sql`now() - make_interval(secs => ${seconds})` })
      .where(eq(magicLinkRequests.email, email));

  /** The rows of `verifications` holding this token's or these identifiers' records. */
  const tokens = (identifiers: (string | null)[]) =>
    owner.db
      .select()
      .from(verifications)
      .where(
        inArray(
          verifications.identifier,
          identifiers.filter((value) => value !== null),
        ),
      );

  const magicLinkVerifications = () =>
    owner.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(like(verifications.identifier, "magic-link:%"));

  /** A job instance: another call is another replica on the same database. */
  const instance = (
    options: {
      transport?: Transport;
      queue?: { maxLength: number; concurrency: number };
    } = {},
  ) =>
    createMagicLinkRequests({
      auth,
      db: runtime.db,
      environment,
      transport: options.transport ?? transport,
      queue: options.queue,
    });

  const requests = instance();
  /** The real app on the same login: `POST /login` queues on `requests` and sends through
   * the same memory transport. */
  const app = createApp({
    auth,
    db: runtime.db,
    environment,
    magicLinks: requests,
  });
  const ask = (
    address: string,
    overrides: {
      browser?: string;
      client?: string;
      pendingQuery?: string | null;
    } = {},
  ) =>
    requests.process({
      address,
      browser,
      client,
      pendingQuery: null,
      ...overrides,
    });

  return {
    ...roles,
    async close() {
      console.log = log;
      await roles.close();
    },
    environment,
    auth,
    transport,
    platform,
    firm,
    person,
    member,
    rows,
    age,
    madeAgo,
    tokens,
    magicLinkVerifications,
    instance,
    requests,
    app,
    ask,
    mailsTo: (email: string) =>
      transport.sent.filter((message) => message.to === email),
  };
}

export type MagicLinkFixture = Awaited<ReturnType<typeof openMagicLinkFixture>>;
