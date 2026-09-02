import { relations } from "drizzle-orm";

import {
  accounts,
  invitations,
  members,
  organizations,
  sessions,
  users,
} from "./auth.ts";
import {
  entitlements,
  groupMembers,
  groups,
  organizationDomains,
} from "./authorization.ts";
import {
  oauthAccessTokens,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
} from "./oauth.ts";

// One-side relations are named after the Better Auth model they point at,
// which is the key its adapter looks for when it joins.

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  members: many(members),
  invitations: many(invitations),
  oauthClients: many(oauthClients),
  oauthRefreshTokens: many(oauthRefreshTokens),
  oauthAccessTokens: many(oauthAccessTokens),
  oauthConsents: many(oauthConsents),
}));

export const sessionsRelations = relations(sessions, ({ many, one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  activeOrganization: one(organizations, {
    fields: [sessions.activeOrganizationId],
    references: [organizations.id],
  }),
  oauthRefreshTokens: many(oauthRefreshTokens),
  oauthAccessTokens: many(oauthAccessTokens),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  sessions: many(sessions),
  members: many(members),
  invitations: many(invitations),
  domains: many(organizationDomains),
  groups: many(groups),
  entitlements: many(entitlements),
}));

export const membersRelations = relations(members, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [members.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [members.userId],
    references: [users.id],
  }),
  groupMembers: many(groupMembers),
  entitlements: many(entitlements),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
  inviter: one(users, {
    fields: [invitations.inviterId],
    references: [users.id],
  }),
}));

export const organizationDomainsRelations = relations(
  organizationDomains,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationDomains.organizationId],
      references: [organizations.id],
    }),
  }),
);

export const groupsRelations = relations(groups, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [groups.organizationId],
    references: [organizations.id],
  }),
  groupMembers: many(groupMembers),
  entitlements: many(entitlements),
}));

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, {
    fields: [groupMembers.groupId],
    references: [groups.id],
  }),
  member: one(members, {
    fields: [groupMembers.memberId],
    references: [members.id],
  }),
}));

export const oauthClientsRelations = relations(oauthClients, ({ many, one }) => ({
  user: one(users, {
    fields: [oauthClients.userId],
    references: [users.id],
  }),
  oauthClientResources: many(oauthClientResources),
  oauthRefreshTokens: many(oauthRefreshTokens),
  oauthAccessTokens: many(oauthAccessTokens),
  oauthConsents: many(oauthConsents),
  entitlements: many(entitlements),
}));

export const oauthResourcesRelations = relations(oauthResources, ({ many }) => ({
  oauthClientResources: many(oauthClientResources),
  entitlements: many(entitlements),
}));

export const oauthClientResourcesRelations = relations(
  oauthClientResources,
  ({ one }) => ({
    oauthClient: one(oauthClients, {
      fields: [oauthClientResources.clientId],
      references: [oauthClients.clientId],
    }),
    oauthResource: one(oauthResources, {
      fields: [oauthClientResources.resourceId],
      references: [oauthResources.identifier],
    }),
  }),
);

export const oauthRefreshTokensRelations = relations(
  oauthRefreshTokens,
  ({ many, one }) => ({
    oauthClient: one(oauthClients, {
      fields: [oauthRefreshTokens.clientId],
      references: [oauthClients.clientId],
    }),
    session: one(sessions, {
      fields: [oauthRefreshTokens.sessionId],
      references: [sessions.id],
    }),
    user: one(users, {
      fields: [oauthRefreshTokens.userId],
      references: [users.id],
    }),
    oauthAccessTokens: many(oauthAccessTokens),
  }),
);

export const oauthAccessTokensRelations = relations(
  oauthAccessTokens,
  ({ one }) => ({
    oauthClient: one(oauthClients, {
      fields: [oauthAccessTokens.clientId],
      references: [oauthClients.clientId],
    }),
    session: one(sessions, {
      fields: [oauthAccessTokens.sessionId],
      references: [sessions.id],
    }),
    user: one(users, {
      fields: [oauthAccessTokens.userId],
      references: [users.id],
    }),
    oauthRefreshToken: one(oauthRefreshTokens, {
      fields: [oauthAccessTokens.refreshId],
      references: [oauthRefreshTokens.id],
    }),
  }),
);

export const oauthConsentsRelations = relations(oauthConsents, ({ one }) => ({
  oauthClient: one(oauthClients, {
    fields: [oauthConsents.clientId],
    references: [oauthClients.clientId],
  }),
  user: one(users, {
    fields: [oauthConsents.userId],
    references: [users.id],
  }),
}));

export const entitlementsRelations = relations(entitlements, ({ one }) => ({
  organization: one(organizations, {
    fields: [entitlements.organizationId],
    references: [organizations.id],
  }),
  member: one(members, {
    fields: [entitlements.memberId],
    references: [members.id],
  }),
  group: one(groups, {
    fields: [entitlements.groupId],
    references: [groups.id],
  }),
  oauthClient: one(oauthClients, {
    fields: [entitlements.clientId],
    references: [oauthClients.clientId],
  }),
  oauthResource: one(oauthResources, {
    fields: [entitlements.resource],
    references: [oauthResources.identifier],
  }),
}));
