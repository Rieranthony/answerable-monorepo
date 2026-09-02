// Lifecycle vocabularies. Each list is the single source for the Drizzle
// column type, the PostgreSQL CHECK constraint, and the Better Auth field
// definition, so the three cannot drift apart.

/** `inert`: imported, cannot log in until bound to an upstream identity. */
export const userStatuses = ["inert", "active", "disabled"] as const;
export type UserStatus = (typeof userStatuses)[number];

export const lifecycleStatuses = ["active", "disabled"] as const;
export type LifecycleStatus = (typeof lifecycleStatuses)[number];

/** Better Auth organization plugin (1.7.2) invitation vocabulary. */
export const invitationStatuses = [
  "pending",
  "accepted",
  "rejected",
  "canceled",
] as const;
export type InvitationStatus = (typeof invitationStatuses)[number];
