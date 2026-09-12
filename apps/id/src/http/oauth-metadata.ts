import { metadataResponse } from "@better-auth/oauth-provider";
import type { Auth } from "../auth.ts";

/** Publish the installed provider's cryptographic contract and only reachable features. */
export async function publicOAuthMetadata(auth: Auth, request: Request) {
  const native = await auth.api.getOpenIdConfig({
    request,
    asResponse: false,
    returnHeaders: false,
    returnStatus: false,
  });
  const document = { ...native } as Record<string, unknown>;
  for (const field of [
    "introspection_endpoint",
    "introspection_endpoint_auth_methods_supported",
    "introspection_endpoint_auth_signing_alg_values_supported",
    "registration_endpoint",
    "end_session_endpoint",
    "backchannel_logout_supported",
    "backchannel_logout_session_supported",
    "dpop_signing_alg_values_supported",
  ])
    delete document[field];
  document.prompt_values_supported = ["login", "consent", "none"];
  document.token_endpoint_auth_methods_supported = [
    "none",
    "client_secret_basic",
    "client_secret_post",
    "private_key_jwt",
  ];
  document.grant_types_supported = [
    "authorization_code",
    "refresh_token",
    "client_credentials",
  ];
  return metadataResponse(document);
}
