import { APIError } from "better-auth/api";
import { classifyIssuer } from "../services/federation.ts";
import { logEvent } from "../lib/log.ts";

export const platformApplications = {
  google: { tokenEndpointAuthentication: "client_secret_post" },
  microsoft: { tokenEndpointAuthentication: "client_secret_post" },
} as const;

/** The scopes an SSO row gets when it names none. ID stores no upstream
 * refresh token, so it never asks a directory for `offline_access`, which
 * the SSO plugin's own default would request. */
export const directoryScopes = ["email", "openid", "profile"] as const;

type PlatformApplication = { clientId: string; clientSecret: string };
export type PlatformApplications = {
  google?: PlatformApplication;
  microsoft?: PlatformApplication;
};
export type PlatformApplicationIds = {
  google?: { clientId: string };
  microsoft?: { clientId: string };
};

export function platformApplicationFor(
  issuer: string,
): "google" | "microsoft" | null {
  const { kind } = classifyIssuer(issuer);
  return kind === "google" ? "google" : kind === "entra" ? "microsoft" : null;
}

export function hydrateSsoProviderRow<T>(
  row: T,
  applications: PlatformApplications,
): T {
  if (
    !row ||
    typeof row !== "object" ||
    !("oidcConfig" in row) ||
    typeof row.oidcConfig !== "string"
  )
    return row;
  let config;
  try {
    config = JSON.parse(row.oidcConfig);
  } catch {
    return row;
  }
  if (!config || config.credentials !== "platform") return row;
  const application = platformApplicationFor(
    "issuer" in row && typeof row.issuer === "string" ? row.issuer : "",
  );
  const credentials = application && applications[application];
  if (!credentials) {
    logEvent("auth", "platform_application_missing", { application });
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "platform_application_missing",
      message: "The platform application for this directory is not configured",
    });
  }
  return {
    ...row,
    oidcConfig: JSON.stringify({
      ...config,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      tokenEndpointAuthentication:
        platformApplications[application].tokenEndpointAuthentication,
    }),
  };
}
