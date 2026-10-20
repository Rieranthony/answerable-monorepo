import type { BetterAuthPlugin } from "better-auth";

export function answerableSchema(): BetterAuthPlugin {
  return {
    id: "answerable-schema",
    schema: {
      account: {
        fields: {
          // ID asks no directory for offline_access and keeps no upstream
          // refresh token, even when a directory returns one.
          refreshToken: {
            type: "string",
            required: false,
            input: false,
            returned: false,
            transform: { input: () => null },
          },
        },
      },
      // Federation reads organisations and memberships through the adapter;
      // ID writes them itself, so no organisation plugin or routes.
      organization: {
        fields: {
          name: { type: "string", required: true },
          slug: { type: "string", required: true, unique: true },
          status: {
            type: "string",
            required: true,
            defaultValue: "active",
            input: false,
          },
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
      member: {
        fields: {
          organizationId: {
            type: "string",
            required: true,
            references: { model: "organization", field: "id" },
          },
          userId: {
            type: "string",
            required: true,
            references: { model: "user", field: "id" },
          },
          status: {
            type: "string",
            required: true,
            defaultValue: "active",
            input: false,
          },
          deletedAt: {
            type: "date",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
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
