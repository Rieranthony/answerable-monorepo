import { APIError } from "better-auth/api";
import { classifyIssuer } from "../services/federation.ts";

export const platformApplications = {
  google: {
    kind: "google",
    tokenEndpointAuthentication: "client_secret_post",
    scopes: ["email", "openid", "profile"],
  },
  microsoft: {
    kind: "entra",
    tokenEndpointAuthentication: "client_secret_post",
    scopes: ["email", "offline_access", "openid", "profile"],
  },
} as const;

export type PlatformApplication = { clientId: string; clientSecret: string };
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
    console.error(
      "[id] auth",
      JSON.stringify({
        level: "error",
        event: "platform_application_missing",
        application,
      }),
    );
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
