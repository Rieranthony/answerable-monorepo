import { expect, test } from "bun:test";

import { parseBootstrapEnvironment } from "./bootstrap.ts";
import { EnvironmentValidationError } from "./env.ts";

const source = {
  PLATFORM_DOMAIN: " Answerable.ORG ",
  PLATFORM_SSO_ISSUER: "https://issuer.example.com",
  PLATFORM_SSO_CLIENT_ID: "sso-client",
  PLATFORM_SSO_CLIENT_SECRET: "sso-secret",
};

test("parses bootstrap defaults and normalises the domain", () => {
  expect(parseBootstrapEnvironment(source)).toEqual({
    platformOrganizationName: "Answerable",
    platformDomain: "answerable.org",
    bootstrapClientId: "answerable-bootstrap",
    sso: {
      issuer: source.PLATFORM_SSO_ISSUER,
      clientId: "sso-client",
      clientSecret: "sso-secret",
      discoveryEndpoint: undefined,
    },
  });
});

test("accepts overrides and an explicit discovery URL", () => {
  expect(
    parseBootstrapEnvironment({
      ...source,
      PLATFORM_ORGANIZATION_NAME: "Platform",
      BOOTSTRAP_CLIENT_ID: "machine",
      PLATFORM_SSO_DISCOVERY_ENDPOINT: "https://issuer.example.com/discovery",
    }),
  ).toMatchObject({
    platformOrganizationName: "Platform",
    bootstrapClientId: "machine",
    sso: { discoveryEndpoint: "https://issuer.example.com/discovery" },
  });
});

for (const key of Object.keys(source)) {
  test(`requires ${key}`, () => {
    expect(() =>
      parseBootstrapEnvironment({ ...source, [key]: undefined }),
    ).toThrow(EnvironmentValidationError);
    expect(() => parseBootstrapEnvironment({ ...source, [key]: "" })).toThrow(
      key,
    );
  });
}

for (const domain of [
  "https://answerable.org",
  "answerable.org/path",
  "bad host",
  "-bad.org",
  "bad..org",
]) {
  test(`rejects domain ${domain}`, () => {
    expect(() =>
      parseBootstrapEnvironment({ ...source, PLATFORM_DOMAIN: domain }),
    ).toThrow("PLATFORM_DOMAIN");
  });
}

for (const key of ["PLATFORM_SSO_ISSUER", "PLATFORM_SSO_DISCOVERY_ENDPOINT"]) {
  test(`validates ${key} as a URL`, () => {
    expect(() =>
      parseBootstrapEnvironment({ ...source, [key]: "invalid" }),
    ).toThrow(key);
  });
}
