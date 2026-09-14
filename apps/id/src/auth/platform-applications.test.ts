import { expect, spyOn, test } from "bun:test";
import {
  hydrateSsoProviderRow,
  platformApplicationFor,
} from "./platform-applications.ts";

const applications = {
  google: { clientId: "google-test-id", clientSecret: "google-test-secret" },
  microsoft: {
    clientId: "microsoft-test-id",
    clientSecret: "microsoft-test-secret",
  },
};
const issuers = {
  google: "https://accounts.google.com",
  microsoft:
    "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
};
test("leaves absent, projected, malformed and own rows unchanged", () => {
  for (const row of [
    null,
    undefined,
    1,
    "row",
    {},
    { issuer: issuers.google },
    ...[
      null,
      "bad",
      "null",
      "[]",
      '"text"',
      "{}",
      '{"credentials":"own","clientId":"own"}',
    ].map((oidcConfig) => ({ oidcConfig })),
  ])
    expect(hydrateSsoProviderRow(row, applications)).toBe(row);
});
for (const application of ["google", "microsoft"] as const) {
  test(`hydrates ${application} deterministically without mutating storage`, () => {
    expect(platformApplicationFor(issuers[application])).toBe(application);
    const row = {
      issuer: issuers[application],
      oidcConfig: JSON.stringify({ credentials: "platform", pkce: true }),
    };
    const hydrated = hydrateSsoProviderRow(row, applications);
    expect(hydrated).not.toBe(row);
    expect(hydrated.oidcConfig).toBe(
      JSON.stringify({
        credentials: "platform",
        pkce: true,
        clientId: applications[application].clientId,
        clientSecret: applications[application].clientSecret,
        tokenEndpointAuthentication: "client_secret_post",
      }),
    );
    expect(hydrateSsoProviderRow(hydrated, applications)).toEqual(hydrated);
    expect(JSON.parse(row.oidcConfig)).toEqual({
      credentials: "platform",
      pkce: true,
    });
  });
}
test("missing and unsupported applications fail closed with a redacted diagnostic", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [issuer, application] of [
      [issuers.google, "google"],
      [issuers.microsoft, "microsoft"],
      ["https://generic.example.com", null],
    ] as const) {
      expect(() =>
        hydrateSsoProviderRow(
          { issuer, oidcConfig: '{"credentials":"platform"}' },
          {},
        ),
      ).toThrow(
        expect.objectContaining({
          status: "SERVICE_UNAVAILABLE",
          body: {
            code: "platform_application_missing",
            message:
              "The platform application for this directory is not configured",
          },
        }),
      );
      expect(log).toHaveBeenLastCalledWith(
        "[id] auth",
        JSON.stringify({
          level: "error",
          event: "platform_application_missing",
          application,
        }),
      );
    }
  } finally {
    log.mockRestore();
  }
});
