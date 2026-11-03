// Lifecycle vocabularies. Each list is the single source for the Drizzle
// column type, the PostgreSQL CHECK constraint, and the Better Auth field
// definition, so the three cannot drift apart.

export const userStatuses = ["active", "disabled"] as const;

export const membershipStatuses = ["active", "revoked"] as const;

export const lifecycleStatuses = ["active", "disabled"] as const;
export type LifecycleStatus = (typeof lifecycleStatuses)[number];

/** What a row of `sso_providers` is. A directory is `oidc`. */
export const ssoProviderKinds = ["oidc", "magic_link"] as const;
export type SsoProviderKind = (typeof ssoProviderKinds)[number];

/** Who may ask a firm's magic-link row for a link: its effective members, or also anyone
 * at one of its domains that has passed a DNS proof. */
export const magicLinkAdmissions = ["listed", "domain"] as const;
export type MagicLinkAdmissionMode = (typeof magicLinkAdmissions)[number];

/** What a sign-in request mailed: a link and a code, or word that access was removed. */
export const magicLinkPurposes = ["link", "access_removed"] as const;

/** A request is `sending` from before the send until its answer. Only `sent` can sign in. */
export const magicLinkSendStatuses = ["sending", "sent", "failed"] as const;

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
