import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import {
  magicLinkBrowserHash,
  magicLinkCodeAttempts,
  magicLinkKeys,
} from "../auth/magic-link.ts";
import {
  recordMagicLinkRefusal,
  type MagicLinkClient,
} from "../auth/magic-link-confirm.ts";
import type { Database } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { magicLinkRequests } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";

/** A browser holds several requests when a person asks twice; this bounds a request's work. */
const comparedRowsPerAttempt = 10;

/**
 * One code from one browser. Every comparison is counted and committed before anything else,
 * because a refusal in the sign-in transaction rolls back, and a count that rolled back would
 * make the limit no limit. A request that has used its three tries is over, for its link as
 * well: the third wrong code ends the row in that same commit. A right code on the third try
 * leaves it live for the sign-in that follows.
 *
 * The answer is the row the code matched, or null, and nothing says why it is null: a browser
 * with no row and a wrong code look alike.
 */
export async function attemptMagicLinkCode(
  db: Database,
  environment: Pick<Environment, "betterAuthSecret" | "betterAuthSecrets">,
  input: {
    browser: string;
    code: string;
    /** A code answers only the page it was mailed for: purposes never cross. */
    purpose: "link" | "connect_directory";
  },
  who: MagicLinkClient,
) {
  const keys = magicLinkKeys(environment);
  const compared = await withDatabaseScope(
    db,
    { kind: "protocol" },
    async (tx) => {
      const held = await tx
        .select()
        .from(magicLinkRequests)
        .where(
          and(
            eq(
              magicLinkRequests.browserHash,
              magicLinkBrowserHash(input.browser),
            ),
            eq(magicLinkRequests.purpose, input.purpose),
            eq(magicLinkRequests.sendStatus, "sent"),
            sql`${magicLinkRequests.expiresAt} > statement_timestamp()`,
            lt(magicLinkRequests.attempts, magicLinkCodeAttempts),
          ),
        )
        .orderBy(desc(magicLinkRequests.createdAt), desc(magicLinkRequests.id))
        .limit(comparedRowsPerAttempt)
        .for("update");
      if (held.length === 0) return [];
      // Each row's comparison runs whatever the others find.
      const answers = held.map((row) => ({
        row,
        matched: keys.codeMatches(row.id, input.code, row.codeHmac!),
        spent: row.attempts + 1 >= magicLinkCodeAttempts,
      }));
      const ids = (rows: typeof answers) => rows.map(({ row }) => row.id);
      await tx
        .update(magicLinkRequests)
        .set({ attempts: sql`${magicLinkRequests.attempts} + 1` })
        .where(inArray(magicLinkRequests.id, ids(answers)));
      await tx
        .update(magicLinkRequests)
        .set({ expiresAt: sql`statement_timestamp()` })
        .where(
          inArray(
            magicLinkRequests.id,
            ids(answers.filter(({ matched, spent }) => spent && !matched)),
          ),
        );
      return answers;
    },
  );
  for (const { row, matched, spent } of compared)
    if (spent && !matched)
      await recordMagicLinkRefusal(
        db,
        row,
        "auth.magic_link.code_exhausted",
        "code_attempts",
        who,
      );
  return compared.find(({ matched }) => matched)?.row ?? null;
}
