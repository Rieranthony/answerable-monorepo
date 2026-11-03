import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import domains from "free-email-domains";
import { version } from "free-email-domains/package.json";

import { isPublicMailDomain } from "./public-mail-domains.ts";
import { publicMailDomains } from "./public-mail-domains.generated.ts";
import { renderPublicMailDomains } from "./public-mail-domains-render.ts";

const repository = new URL("../../../../", import.meta.url);

describe("the generated list", () => {
  test("is what the generator writes from the pinned package", async () => {
    const committed = await Bun.file(
      new URL("./public-mail-domains.generated.ts", import.meta.url),
    ).text();
    // On a new version: bun run --filter @answerable/id public-mail:generate. On this version,
    // the package's postinstall ran and rewrote its own list from the network: see below.
    expect(
      renderPublicMailDomains(domains, version) === committed,
      "src/lib/public-mail-domains.generated.ts differs from free-email-domains: run `bun run --filter @answerable/id public-mail:generate` and commit it",
    ).toBe(true);
    expect(committed).toStartWith(
      `// Generated from free-email-domains ${version}:`,
    );
  });

  test("is pinned, and the package's install script stays off", async () => {
    // Its postinstall fetches its sources and rewrites domains.json, so an install that ran
    // it would answer differently every day (measured: 30,429 against the published 30,402).
    // Bun trusts this package by default, and listing what may run turns that default off.
    const { trustedDependencies } = await Bun.file(
      new URL("package.json", repository),
    ).json();
    expect(trustedDependencies).toBeArray();
    expect(trustedDependencies).not.toContain("free-email-domains");
    const { devDependencies } = await Bun.file(
      new URL("apps/id/package.json", repository),
    ).json();
    expect(devDependencies["free-email-domains"]).toBe(version);
  });

  test("is one lowercase, distinct host name per entry", () => {
    expect(publicMailDomains.length).toBeGreaterThan(30_000);
    expect(new Set(publicMailDomains).size).toBe(publicMailDomains.length);
    const host =
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
    expect(publicMailDomains.filter((domain) => !host.test(domain))).toEqual(
      [],
    );
  });

  test("renders one domain to a line", () => {
    expect(renderPublicMailDomains(["a.example", "b.example"], "1.2.3"))
      .toBe(`// Generated from free-email-domains 1.2.3: bun run --filter @answerable/id public-mail:generate. Never edit it by hand.
export const publicMailDomains: readonly string[] = [
  "a.example",
  "b.example",
];
`);
  });
});

describe("isPublicMailDomain", () => {
  test("matches the domain in any case and with stray space", () => {
    for (const domain of ["gmail.com", "GMail.COM", " gmail.com ", "proton.me"])
      expect(isPublicMailDomain(domain), domain).toBe(true);
  });

  test("matches exactly: a subdomain or a suffix of a listed domain is not listed", () => {
    for (const domain of [
      "firm.gmail.com",
      "notgmail.com",
      "gmail.com.example.com",
      "gmail",
      "",
    ])
      expect(isPublicMailDomain(domain), domain).toBe(false);
  });

  test("holds no domain the repository's fixtures sign in with", async () => {
    const roots = [
      "apps/id/src",
      "apps/id/scripts",
      "mcps/admin/src",
      "packages/acceptance/src",
      "packages/acceptance/scripts",
      "packages/id-admin/src",
      "infra/k8s",
      "infra/ops",
    ];
    const pattern = /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g;
    const found = new Set<string>();
    for (const root of roots)
      for (const name of await readdir(new URL(root, repository), {
        recursive: true,
      })) {
        if (!/\.(ts|tsx|json|ya?ml|sql)$/.test(name)) continue;
        if (name.includes("node_modules") || name.includes(".generated."))
          continue;
        const file = Bun.file(new URL(`${root}/${name}`, repository));
        for (const [, domain] of (await file.text()).matchAll(pattern))
          found.add(domain!);
      }
    // These name public mail on purpose: tests of the refusal.
    const refusals = ["gmail.com", "proton.me", "mailinator.com"];
    expect(
      [...found].filter(
        (domain) => isPublicMailDomain(domain) && !refusals.includes(domain),
      ),
    ).toEqual([]);
    expect(found.size).toBeGreaterThan(10);
  });
});
