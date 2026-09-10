import { grantScopes, identityScopes } from "./grant-scopes.ts";
import type { Executor } from "../db/client.ts";
import { findMachineCapability } from "../db/queries/capabilities.ts";

/** Called only after authenticated ownership and organisation/client/resource locks. */
export async function machineCapability(
  tx: Executor,
  input: {
    organizationId: string;
    clientId: string;
    resource: string;
    requestedScopes?: string[];
  },
) {
  const row = await findMachineCapability(tx, input);
  const grant = {
    grantType: "client_credentials" as const,
    subjectType: "client" as const,
  };
  // No eligible row means no trusted target snapshot. Never retain raw targets.
  if (!row)
    return {
      ...grant,
      allowed: false as const,
      reason: "unauthorized_client" as const,
      evidence: { policyVersion: 1, capabilities: [] },
    };
  const scopes = grantScopes(input.requestedScopes, [
    (row.client.scopeCeiling ?? []).filter(
      (scope) => !identityScopes.has(scope),
    ),
    row.capability.scopes,
    row.resource.scopeCeiling ?? [],
  ]);
  const snapshot = {
    ...grant,
    organization: row.organization,
    client: row.client,
    resource: row.resource,
    evidence: {
      policyVersion: 1,
      evaluatedAt: row.evaluatedAt,
      capabilities: [
        {
          id: row.capability.id,
          revision: row.capability.revision,
          grantKind: row.capability.grantKind,
          resource: row.capability.resource,
          scopes: row.capability.scopes,
          validFrom: row.capability.validFrom,
          validUntil: row.capability.validUntil,
        },
      ],
    },
  };
  // Failed scope requests may contain arbitrary secrets, unlike approved scopes.
  if (!scopes)
    return {
      ...snapshot,
      allowed: false as const,
      reason: "invalid_scope" as const,
      scopes: [],
    };
  return {
    ...snapshot,
    allowed: true as const,
    reason: "approved" as const,
    requestedScopes:
      input.requestedScopes === undefined
        ? null
        : [...new Set(input.requestedScopes)].sort(),
    scopes,
  };
}
