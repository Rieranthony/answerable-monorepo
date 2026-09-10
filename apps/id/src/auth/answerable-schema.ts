import type { BetterAuthPlugin } from "better-auth";

export function answerableSchema(): BetterAuthPlugin {
  return {
    id: "answerable-schema",
    schema: {
      oauthClient: {
        fields: {
          organizationId: { type: "string", required: false, input: false },
          authorizationVersion: {
            type: "number",
            required: true,
            defaultValue: 1,
            input: false,
          },
        },
      },
      organizationDomain: {
        fields: {
          organizationId: {
            type: "string",
            required: true,
            references: { model: "organization", field: "id" },
          },
          domain: { type: "string", required: true },
          status: { type: "string", required: true },
          createdAt: { type: "date", required: true },
          updatedAt: { type: "date", required: true },
        },
      },
    },
  };
}
