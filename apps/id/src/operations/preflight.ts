import { asc, gt, sql } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { importJWK, SignJWT, jwtVerify } from "jose";
import { createAuth } from "../auth.ts";
import { upstreamTokenStorage } from "../auth/upstream-token-storage.ts";
import type { Database } from "../db/client.ts";
import { accounts, jwks } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";

/** The name of a preflight failure whose message names its cause and holds
 * no key material. */
export const custodyErrorName = "CustodyPreflightError";

function custodyError(message: string) {
  return Object.assign(new Error(message), { name: custodyErrorName });
}

/** Read-only, paged verification while writers are stopped. Returns counts, never credential material.
 * This checks retained ciphertext, not secret-manager delivery, backup completeness or traffic readiness.
 */
export async function checkKeyCustody(db: Database, environment: Environment) {
  if (!environment.upstreamTokenSecrets?.length)
    throw custodyError("Required key configuration is absent");
  let counts: { signingKeys: number; accounts: number };
  try {
    const upstream = upstreamTokenStorage(environment.upstreamTokenSecrets)
      .schema.account.fields.accessToken.transform.output;
    const { secretConfig } = await createAuth(db, environment).$context;
    counts = await db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const counts = { signingKeys: 0, accounts: 0 };
      let after: string | undefined;
      for (;;) {
        const rows = await tx
          .select()
          .from(jwks)
          .where(after ? gt(jwks.id, after) : undefined)
          .orderBy(asc(jwks.id))
          .limit(100);
        if (!rows.length) break;
        for (const row of rows) {
          const privateJwk = JSON.parse(
            await symmetricDecrypt({
              key: secretConfig,
              data: JSON.parse(row.privateKey),
            }),
          );
          const alg = row.alg ?? "EdDSA";
          const privateKey = await importJWK(privateJwk, alg);
          const publicKey = await importJWK(JSON.parse(row.publicKey), alg);
          // A local non-identity canary verifies the stored pair; it is never returned or persisted.
          const canary = await new SignJWT({ purpose: "custody-preflight" })
            .setProtectedHeader({ alg })
            .sign(privateKey);
          await jwtVerify(canary, publicKey, { algorithms: [alg] });
          counts.signingKeys++;
        }
        after = rows.at(-1)!.id;
      }
      after = undefined;
      for (;;) {
        const rows = await tx
          .select({
            id: accounts.id,
            access: accounts.accessToken,
            refresh: accounts.refreshToken,
            identity: accounts.idToken,
          })
          .from(accounts)
          .where(after ? gt(accounts.id, after) : undefined)
          .orderBy(asc(accounts.id))
          .limit(100);
        if (!rows.length) break;
        for (const row of rows) {
          for (const value of [row.access, row.refresh, row.identity])
            await upstream(value);
          counts.accounts++;
        }
        after = rows.at(-1)!.id;
      }
      return counts;
    });
  } catch {
    // A parse or decryption error on decrypted text can quote key material.
    throw custodyError("Key custody preflight failed");
  }
  if (!counts.signingKeys)
    throw custodyError("Signing keys have not been provisioned");
  return counts;
}
