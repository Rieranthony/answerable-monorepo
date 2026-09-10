import type { BetterAuthPlugin } from "better-auth";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";

export const upstreamTokenSecretsSchema = z
  .array(
    z
      .object({
        version: z.number().int().min(1).max(2_147_483_647),
        value: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .refine(
            (value) =>
              Buffer.from(value, "base64url").toString("base64url") === value,
          ),
      })
      .strict(),
  )
  .min(1)
  .refine(
    (secrets) =>
      new Set(secrets.map((secret) => secret.version)).size === secrets.length,
  );

export type UpstreamTokenSecrets = z.infer<typeof upstreamTokenSecretsSchema>;

/** Dedicated upstream keys; never fall back to auth, signing or replay keys. */
export function upstreamTokenStorage(secrets?: UpstreamTokenSecrets) {
  const key = {
    currentVersion: secrets?.[0]?.version ?? 0,
    keys: new Map(secrets?.map(({ version, value }) => [version, value])),
  };
  const unavailable = () => new Error("Upstream token storage is unavailable");
  const field = {
    type: "string" as const,
    required: false,
    input: false,
    returned: false,
    transform: {
      async input(value: unknown): Promise<string | null | undefined> {
        if (value == null) return value;
        if (typeof value !== "string" || !key.keys.has(key.currentVersion))
          throw unavailable();
        return symmetricEncrypt({ key, data: value });
      },
      async output(value: unknown): Promise<string | null | undefined> {
        if (value == null) return value;
        // Deliberately exclude the provider helper's plaintext/legacy guessing.
        if (
          typeof value !== "string" ||
          !/^\$ba\$[1-9][0-9]*\$[0-9a-f]+$/.test(value)
        )
          throw unavailable();
        try {
          return await symmetricDecrypt({ key, data: value });
        } catch {
          // Key IDs, ciphertext and crypto exceptions never reach diagnostics.
          throw unavailable();
        }
      },
    },
  };
  return {
    id: "upstream-token-storage",
    schema: {
      account: {
        fields: {
          accessToken: field,
          refreshToken: field,
          idToken: field,
        },
      },
    },
  } as const satisfies BetterAuthPlugin;
}
