// Lifecycle vocabularies. Each list is the single source for the Drizzle
// column type, the PostgreSQL CHECK constraint, and the Better Auth field
// definition, so the three cannot drift apart.

/** `inert`: imported, cannot log in until bound to an upstream identity. */
export const userStatuses = ["inert", "active", "disabled"] as const;

export const membershipStatuses = ["active", "revoked"] as const;

export const lifecycleStatuses = ["active", "disabled"] as const;
export type LifecycleStatus = (typeof lifecycleStatuses)[number];

/** The principal responsible for an audit event. */
export const auditActorTypes = ["user", "client", "system"] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

/** `denied`: an authenticated principal was refused by authorisation. */
export const auditOutcomes = ["success", "failure", "denied"] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];

/** Who owns a protected resource: the platform, or one tenant. */
export const resourceClassifications = [
  "platform_shared",
  "tenant_owned",
] as const;
export type ResourceClassification = (typeof resourceClassifications)[number];

/** Whether a committed admin command changed state. */
export const operationOutcomes = ["applied", "noop"] as const;
