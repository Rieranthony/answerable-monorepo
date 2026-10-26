import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";
import { defineConfig, locally } from "@answerable/config";
import { z } from "zod";

const applicationSecrets = z.string().transform((value, context) => {
  const entries = value.split(",").map((entry) => {
    const match = /^([0-9]+):(.+)$/.exec(entry.trim());
    return {
      version: match ? Number(match[1]) : NaN,
      value: match?.[2]?.trim() ?? "",
    };
  });
  const parsed = z
    .array(
      z.object({
        version: z.number().int().min(0),
        value: z.string().min(32),
      }),
    )
    .min(1)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.version)).size === entries.length,
    )
    .safeParse(entries);
  if (parsed.success) return parsed.data;
  context.addIssue({
    code: "custom",
    message:
      "Expected distinct non-negative integer versions and secrets of at least 32 characters",
  });
  return z.NEVER;
});

/** The largest value a Postgres integer setting accepts. */
const maxInt32 = 2_147_483_647;

const optionalCredential = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

/** Every variable the service reads, with its local defaults; default.env at the repository root lists each one. */
export const idConfig = defineConfig(
  "ID",
  {
    PORT: {
      schema: z.coerce.number().int().min(1).max(65_535),
      fallback: "47300",
      doc: "The port ID listens on",
      source: "image",
    },
    // Not HOST or HOSTNAME, which shells set.
    ID_HOST: {
      schema: z.union([z.ipv4(), z.ipv6()]),
      fallback: "127.0.0.1",
      doc: "The address to listen on: loopback unless a container or a proxy in front needs another",
      source: "image",
    },
    DATABASE_URL: {
      schema: z.url(),
      secret: true,
      defaults: locally(
        "postgres://answerable_id_runtime:answerable@localhost:47432/answerable_id",
      ),
      doc: "ID's Postgres URL as its restricted runtime login, never the schema owner",
      source: "cluster",
    },
    BETTER_AUTH_URL: {
      // One spelling of the origin, without a trailing slash, for the issuer, the pages and the admin audience.
      schema: z.url().transform((url) => url.replace(/\/+$/, "")),
      defaults: locally("http://localhost:47300"),
      doc: "ID's origin: the issuer, the pages' origin and the base of the admin API's audience",
      source: "chart",
    },
    BETTER_AUTH_SECRET: {
      schema: z.string().min(32),
      secret: true,
      defaults: locally(
        "development-only-better-auth-secret-never-for-production",
      ),
      doc: "The application secret, at least 32 characters: signs cookies and encrypts what ID stores",
      source: "deploy",
    },
    BETTER_AUTH_SECRETS: {
      schema: applicationSecrets.optional(),
      secret: true,
      doc: "The rotation ring, version:secret pairs separated by commas: the first writes, every one decrypts",
      source: "deploy",
    },
    GOOGLE_CLIENT_ID: {
      schema: optionalCredential,
      doc: "The Google platform application's client ID; set it with GOOGLE_CLIENT_SECRET or leave both unset",
      source: "deploy",
    },
    GOOGLE_CLIENT_SECRET: {
      schema: optionalCredential,
      secret: true,
      doc: "The Google platform application's client secret",
      source: "deploy",
    },
    MICROSOFT_CLIENT_ID: {
      schema: optionalCredential,
      doc: "The Entra platform application's client ID; set it with MICROSOFT_CLIENT_SECRET or leave both unset",
      source: "deploy",
    },
    MICROSOFT_CLIENT_SECRET: {
      schema: optionalCredential,
      secret: true,
      doc: "The Entra platform application's client secret",
      source: "deploy",
    },
    BETTER_AUTH_TRUSTED_ORIGINS: {
      schema: z.string(),
      fallback: "",
      doc: "Origins trusted besides ID's own, separated by commas: browser origins and identity-provider endpoints; production requires them",
      source: "chart",
    },
    ROOT_ADMIN_SECRET: {
      schema: z.string().min(32).optional(),
      secret: true,
      defaults: locally(
        "development-only-root-admin-secret-never-for-production",
      ),
      doc: "The root bearer, at least 32 characters, for the first run; it stops working once a person holds platform:write",
      source: "deploy",
    },
    ROOT_ADMIN_BREAK_GLASS: {
      schema: z.enum(["true", "false"]),
      fallback: "false",
      doc: "true keeps the root bearer working after a person holds platform:write; for break-glass only",
      source: "operator",
    },
    TRUSTED_PROXY_CIDRS: {
      schema: z
        .string()
        .transform((value) => value.split(",").map((entry) => entry.trim()))
        .refine(
          (entries) => findInvalidTrustedProxies(entries).length === 0,
          "Expected valid proxy IP addresses or CIDRs",
        )
        .optional(),
      doc: "The ingress proxies' networks, IPv4 or IPv6, separated by commas; production requires them",
      source: "cluster",
    },
    DATABASE_POOL_MAX: {
      schema: z.coerce.number().int().min(1).max(maxInt32),
      fallback: "20",
      doc: "Connections per process; size it with docs/06's formula against the database's limit",
      source: "operator",
    },
  },
  {
    refine(environment, issue) {
      if (
        environment.ROOT_ADMIN_BREAK_GLASS === "true" &&
        environment.ROOT_ADMIN_SECRET === undefined
      )
        issue("ROOT_ADMIN_BREAK_GLASS", "Requires ROOT_ADMIN_SECRET");
      for (const [id, secret] of [
        ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
      ] as const) {
        for (const [missing, other] of [
          [id, secret],
          [secret, id],
        ] as const) {
          if (
            environment[missing] === undefined &&
            environment[other] !== undefined
          )
            issue(missing, `Required together with ${other}`);
        }
      }
      if (environment.NODE_ENV !== "production") return;
      if (!environment.TRUSTED_PROXY_CIDRS?.length)
        issue("TRUSTED_PROXY_CIDRS", "Required in production");
      const origins = environment.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map(
        (origin) => origin.trim(),
      );
      if (
        origins.some((origin) => {
          try {
            return (
              new URL(origin).origin !== origin || !/^https?:/.test(origin)
            );
          } catch {
            return true;
          }
        })
      )
        issue(
          "BETTER_AUTH_TRUSTED_ORIGINS",
          "Required origin-only HTTP(S) URLs in production",
        );
    },
  },
);
