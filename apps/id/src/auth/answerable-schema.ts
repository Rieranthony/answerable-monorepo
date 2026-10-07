import type { BetterAuthPlugin } from "better-auth";

export function answerableSchema(): BetterAuthPlugin {
  return {
    id: "answerable-schema",
    schema: {
      ssoProvider: {
        fields: {
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
      oauthConsent: {
        fields: {
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
      oauthResource: {
        fields: {
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
      oauthClientResource: {
        fields: {
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
      oauthClient: {
        fields: {
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
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
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
          organizationId: { type: "string", required: true },
          domain: { type: "string", required: true },
          status: { type: "string", required: true },
        },
      },
    },
  };
}
