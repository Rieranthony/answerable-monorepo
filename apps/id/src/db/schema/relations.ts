import { relations } from "drizzle-orm";

import { accounts, members, organizations, sessions, users } from "./auth.ts";

// The relations Better Auth's adapter joins on (`joins: true` in auth.ts):
// one-side relations are named after the model they point at, many-side ones
// after the plural model name, which are the keys the adapter looks for.

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(members),
}));

export const membersRelations = relations(members, ({ one }) => ({
  organization: one(organizations, {
    fields: [members.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [members.userId],
    references: [users.id],
  }),
}));
