import { expect, test } from "bun:test";

import {
  magicLinkCodeAttempts,
  magicLinkGrantLifetimeSeconds,
  magicLinkSessionLifetimeSeconds,
  magicLinkTtlMinutes,
} from "../auth/magic-link.ts";
import { requestBodyLimit } from "../http/request-limits.ts";
import { domainLookupTimeoutMs } from "./domain-verification.ts";
import { magicLinkCodeBudgets } from "./magic-link-codes.ts";
import {
  magicLinkDrainDeadlineMs,
  magicLinkLimits,
} from "./magic-link-requests.ts";
import { maxImportAddresses } from "./member-import.ts";

// The public docs state the limits of sign-in by email link as numbers. They cannot be rendered
// from these constants: the web app would have to import ID's server code to read them. So the
// page's table is held to the constants here, row by row, and so is every other page that
// repeats one. A number changed in either place fails this until the other follows.

const docs = (path: string) =>
  Bun.file(
    new URL(`../../../web/content/docs/${path}`, import.meta.url),
  ).text();
const source = (path: string) =>
  Bun.file(new URL(`../${path}`, import.meta.url)).text();
const grouped = (value: number) => value.toLocaleString("en-GB");

/** The two-column rows of the table under a heading: label to value. */
function table(page: string, heading: string) {
  const section = page.split(`\n## ${heading}\n`)[1]!.split("\n## ")[0]!;
  const first = section.indexOf("\n| ");
  const rows = section
    .slice(first)
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .slice(2)
    .map((line) => line.split("|").map((cell) => cell.trim()));
  return Object.fromEntries(rows.map((cells) => [cells[1]!, cells[2]!]));
}

/** Numbers that are constants of the source and not exports. */
async function inSource() {
  const requests = await source("services/magic-link-requests.ts");
  const queue = /maxLength: (\d+), concurrency: (\d+)/.exec(requests)!;
  const budgets = await Promise.all(
    ["login", "magic-link", "connect-directory"].map(async (route) =>
      /createClientBudget\(\{ max: (\d+), windowMs: ([\d_]+) \}\)/
        .exec(await source(`http/pages/routes/${route}.ts`))!
        .slice(1, 3)
        .join(" per "),
    ),
  );
  const sweep = /magic_link_requests[\s\S]*?interval '(\d+) days'/.exec(
    await source("operations/protocol-sweep.ts"),
  )!;
  return {
    queue: { maxLength: Number(queue[1]), concurrency: Number(queue[2]) },
    budgets: new Set(budgets),
    keptDays: Number(sweep[1]),
  };
}

test("the limits table of the magic links page states the code's numbers", async () => {
  const { queue, budgets, keptDays } = await inSource();
  // The three sign-in pages share one budget, which the page states once.
  expect([...budgets]).toEqual(["60 per 10_000"]);
  const [perPage, perMilliseconds] = [...budgets][0]!.split(" per ");
  const hours = (seconds: number) => seconds / 3_600;
  const expected = {
    "Mail to one address from one client": `${magicLinkLimits.addressClientPerMinute} a minute, ${magicLinkLimits.addressClientPerHour} an hour`,
    "Mail to one address, from anyone": `${magicLinkLimits.addressPerDay} a day`,
    "Mail for one organisation": `${grouped(magicLinkLimits.organizationPerHour)} an hour`,
    "Mail to an address no user holds (domain mode)": `${magicLinkLimits.newAddressClientPerHour} an hour per client, ${magicLinkLimits.newAddressOrganizationPerDay} a day per organisation`,
    "A link and its code": `${magicLinkTtlMinutes} minutes`,
    "Tries at a code, per request": `${magicLinkCodeAttempts}`,
    "Wrong codes": `${magicLinkCodeBudgets.clientPerHour} an hour per client, ${grouped(magicLinkCodeBudgets.organizationPerHour)} an hour per organisation`,
    "Posts to the sign-in pages": `${perPage} every ${Number(perMilliseconds!.replaceAll("_", "")) / 1_000} seconds per client and process`,
    "Mail waiting to send": `${queue.concurrency} at a time, ${queue.maxLength} waiting, ${magicLinkDrainDeadlineMs / 1_000} seconds to finish on shutdown`,
    "Addresses per import": grouped(maxImportAddresses),
    "A domain check": `${domainLookupTimeoutMs / 1_000} seconds`,
    "Request records kept": `${keptDays} days`,
  };
  expect(table(await docs("id/magic-links.mdx"), "Limits and budgets")).toEqual(
    expected,
  );
  // The lifetimes sit in a table of their own, under what a sign-in by email is worth.
  expect(
    table(await docs("id/magic-links.mdx"), "What a sign-in by email is worth"),
  ).toMatchObject({
    Session: `${hours(magicLinkSessionLifetimeSeconds)} hours from creation, never extended`,
    Grant: `${magicLinkGrantLifetimeSeconds / 86_400} days`,
  });
});

test("every other page that repeats a number repeats the code's", async () => {
  const { keptDays } = await inSource();
  const hours = `${magicLinkSessionLifetimeSeconds / 3_600} hours`;
  const days = `${magicLinkGrantLifetimeSeconds / 86_400} days`;
  const imports = `${grouped(maxImportAddresses)}`;
  const week = ({ 7: "seven" } as Record<number, string>)[keptDays]!;
  const claims: [string, string[]][] = [
    [
      "id/magic-links.mdx",
      [
        `Up to ${imports} addresses a call`,
        `at most ${domainLookupTimeoutMs / 1_000} seconds`,
        `for ${week} days`,
      ],
    ],
    ["id/sign-in.mdx", [`${hours} from creation`, `grants last ${days}`]],
    [
      "id/oauth.mdx",
      [
        `${days} for a sign-in by`,
        `A \`magic_link\` session lasts ${hours} and its grant ${days}`,
      ],
    ],
    ["id/onboard.mdx", [`up to ${imports} addresses a call`, `${week} days`]],
    ["id/manage.mdx", [`at most ${imports} a call`]],
    ["admin/index.mdx", [`Up to ${imports} \`addresses\``]],
  ];
  for (const [page, phrases] of claims) {
    const text = await docs(page);
    for (const phrase of phrases)
      expect([page, text]).toEqual([page, expect.stringContaining(phrase)]);
  }
  // The sign-in page states the pages whose forms take 4 KiB.
  const signIn = await docs("id/sign-in.mdx");
  for (const [method, path] of [
    ["POST", "/login"],
    ["POST", "/magic-link"],
    ["POST", "/magic-link/code"],
    ["POST", "/connect-directory"],
  ] as const) {
    expect(requestBodyLimit(method, path)).toBe(4 * 1024);
    expect(signIn).toContain(`\`${method} ${path}\``);
  }
  expect(signIn).toContain("(4 KiB:");
});
