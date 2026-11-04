import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Executor } from "../db/client.ts";
import { lockOrganization } from "../db/locks.ts";
import { activeOrganizationDomains } from "../db/queries/organization-domains.ts";
import { members, organizations, users } from "../db/schema/index.ts";
import { found } from "../http/problem.ts";
import { createId } from "../lib/id.ts";
import { recordCommandEvents } from "./audit.ts";
import { newUserFields } from "./federation.ts";
import {
  parseMagicLinkAddress,
  usersWithForeignAccounts,
  type MagicLinkAddress,
} from "./magic-link-admission.ts";
import type {
  PlatformReadContext,
  PlatformUsersContext,
} from "./platform-context.ts";

/** A call's limit: one transaction must stay inside the statement and idle timeouts. */
export const maxImportAddresses = 1_000;

export const importRefusals = [
  "invalid",
  "outside_domains",
  "disabled",
  "removed",
  "other_firm",
] as const;
type ImportRefusal = (typeof importRefusals)[number];

export type ImportAnswer =
  | { address: string; outcome: "created" | "added" | "alreadyMember" }
  | { address: string; outcome: "refused"; reason: ImportRefusal };

type Person = {
  holder?: { id: string; status: string };
  member?: { status: string };
  foreign: boolean;
};

/** Each distinct address once, in the order given, as `users.email` holds it when it parses. */
function distinctAddresses(addresses: string[]) {
  const answers = new Map<string, ImportAnswer | MagicLinkAddress>();
  for (const raw of addresses) {
    const parsed = parseMagicLinkAddress(raw);
    const key = parsed?.email ?? raw;
    if (!answers.has(key))
      answers.set(
        key,
        parsed ?? { address: raw, outcome: "refused", reason: "invalid" },
      );
  }
  return answers;
}

/** Split the addresses into what this firm can take at all and what it refuses as it stands. */
async function sortByDomain(
  tx: Executor,
  organizationId: string,
  answers: (ImportAnswer | MagicLinkAddress)[],
) {
  const active = new Set(
    (await activeOrganizationDomains(tx, organizationId)).map(
      ({ domain }) => domain,
    ),
  );
  const refused = new Map<string, ImportAnswer>();
  const asked: string[] = [];
  for (const answer of answers) {
    if (!("email" in answer)) continue;
    const { email, domain } = answer;
    if (!active.has(domain))
      refused.set(email, {
        address: email,
        outcome: "refused",
        reason: "outside_domains",
      });
    else asked.push(email);
  }
  return { refused, asked };
}

/** Everyone holding one of these addresses, a disabled or retired holder included, their
 * membership here, and whether another firm has an account of theirs. One read per kind. */
async function readPeople(
  tx: Executor,
  organizationId: string,
  emails: string[],
) {
  const holders = await tx
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(inArray(users.email, emails));
  const userIds = holders.map(({ id }) => id);
  const memberships = await tx
    .select({ userId: members.userId, status: members.status })
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        inArray(members.userId, userIds),
      ),
    );
  const foreign = await usersWithForeignAccounts(tx, userIds, organizationId);
  const member = new Map(memberships.map((row) => [row.userId, row]));
  return new Map<string, Person>(
    holders.map((holder) => [
      holder.email,
      {
        holder,
        member: member.get(holder.id),
        foreign: foreign.has(holder.id),
      },
    ]),
  );
}

/** What importing this person does. A revoked member stays removed until `members.reinstate`:
 * importing never undoes a removal. `email` with no holder is someone to create. */
function answerFor(email: string, person: Person | undefined): ImportAnswer {
  if (!person) return { address: email, outcome: "created" };
  if (person.holder!.status !== "active")
    return { address: email, outcome: "refused", reason: "disabled" };
  if (person.member?.status === "revoked")
    return { address: email, outcome: "refused", reason: "removed" };
  if (person.member) return { address: email, outcome: "alreadyMember" };
  if (person.foreign)
    return { address: email, outcome: "refused", reason: "other_firm" };
  return { address: email, outcome: "added" };
}

function summary(items: ImportAnswer[]) {
  const counts = { created: 0, added: 0, alreadyMember: 0, refused: 0 };
  for (const { outcome } of items) counts[outcome]++;
  return { counts, items };
}

/** What `importMembers` would answer now, changing nothing and holding no lock. */
export async function previewImport(
  context: PlatformReadContext,
  organizationId: string,
  addresses: string[],
) {
  const { tx } = context;
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        isNull(organizations.deletedAt),
        eq(organizations.id, organizationId),
      ),
    );
  found(organization, "Organisation not found");
  const answers = [...distinctAddresses(addresses).values()];
  const { refused, asked } = await sortByDomain(tx, organizationId, answers);
  const people = await readPeople(tx, organizationId, asked);
  return summary(
    answers.map((answer) =>
      "email" in answer
        ? (refused.get(answer.email) ??
          answerFor(answer.email, people.get(answer.email)))
        : answer,
    ),
  );
}

/**
 * Staff list a firm's people before their first sign-in, so that `sub` exists first: a user and
 * an active membership at once, and no account, which the first sign-in makes. One transaction,
 * answering per address and never all or nothing, and idempotent through the journal.
 *
 * Locks: one import at a time across ID, so that the shared lock table holds at most 1,000 of
 * these; then each address, the first lock a confirmation takes, so that one never finds half
 * of what this does; then a share of the firm, as a confirmation holds, so that a domain
 * removed or the firm disabled waits for this and this waits for them. A directory's first
 * sign-in takes no address lock: the insert and the read after it hold up against one.
 */
export async function importMembers(
  context: PlatformUsersContext,
  organizationId: string,
  addresses: string[],
) {
  const { tx } = context;
  const answers = [...distinctAddresses(addresses).values()];
  const parsed = answers.filter(
    (answer): answer is MagicLinkAddress => "email" in answer,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('answerable:member-import', 0))`,
  );
  const locked = parsed.map(({ email }) => email);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('answerable:magic-link:' || email, 0))
        from unnest(${sql.param(locked)}::text[]) as email`,
  );
  found(
    await lockOrganization(tx, organizationId, "share"),
    "Organisation not found",
  );
  const { refused, asked: emails } = await sortByDomain(
    tx,
    organizationId,
    answers,
  );
  // Inserting first means nothing can appear between the read and the write.
  const created = emails.length
    ? await tx
        .insert(users)
        .values(
          emails.map((email) => ({
            id: createId(),
            ...newUserFields({ email }),
          })),
        )
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email })
    : [];
  const createdIds = new Map(created.map(({ email, id }) => [email, id]));
  const people = await readPeople(tx, organizationId, emails);
  const results = new Map(
    emails.map((email) => [
      email,
      createdIds.has(email)
        ? ({ address: email, outcome: "created" } as const)
        : answerFor(email, people.get(email)),
    ]),
  );
  const joining = emails.flatMap((email) => {
    const outcome = results.get(email)!.outcome;
    return outcome === "created" || outcome === "added"
      ? [{ email, userId: people.get(email)!.holder!.id }]
      : [];
  });
  const joined = joining.length
    ? await tx
        .insert(members)
        .values(
          joining.map(({ userId }) => ({
            id: createId(),
            organizationId,
            userId,
          })),
        )
        .onConflictDoNothing({
          target: [members.organizationId, members.userId],
        })
        .returning({ id: members.id, userId: members.userId })
    : [];
  const memberOf = new Map(joined.map((row) => [row.userId, row.id]));
  // A directory's first sign-in made this membership after the read above.
  for (const { email, userId } of joining)
    if (!memberOf.has(userId))
      results.set(email, { address: email, outcome: "alreadyMember" });
  await recordCommandEvents(
    context,
    joining.flatMap(({ email, userId }) => {
      const targetId = memberOf.get(userId);
      return targetId
        ? [
            {
              organizationId,
              targetType: "member",
              targetId,
              action: "member.imported" as const,
              data: {
                userId,
                userCreated: createdIds.has(email),
                before: null,
                after: { membershipStatus: "active" },
              },
            },
          ]
        : [];
    }),
  );
  return summary(
    answers.map((answer) =>
      "email" in answer
        ? (refused.get(answer.email) ?? results.get(answer.email)!)
        : answer,
    ),
  );
}
