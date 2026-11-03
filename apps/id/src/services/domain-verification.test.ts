import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { Resolver } from "node:dns/promises";

import {
  domainLookupTimeoutMs,
  domainVerificationRecord,
  lookupTxtRecords,
  systemTxtResolver,
  txtRecordsHold,
} from "./domain-verification.ts";

const value = "answerable-domain-verification=0123456789abcdef";

describe("the record a firm publishes", () => {
  test("names the challenge host and carries the token", () => {
    expect(
      domainVerificationRecord({
        domain: "acme.example.com",
        verificationToken: "0123456789abcdef",
      }),
    ).toEqual({
      type: "TXT",
      name: "_answerable-challenge.acme.example.com",
      value,
    });
  });
});

describe("txtRecordsHold", () => {
  const holds: [string, string[][]][] = [
    ["one record", [[value]]],
    ["any one record of many", [["other=1"], [value], ["other=2"]]],
    [
      "strings of one record, as Node answers",
      [[value.slice(0, 10), value.slice(10)]],
    ],
    [
      "strings as records of their own, as Bun answers",
      [[value.slice(0, 10)], [value.slice(10)]],
    ],
    [
      "strings that split into three, among others",
      [
        ["other=1"],
        [value.slice(0, 4)],
        [value.slice(4, 9)],
        [value.slice(9)],
        ["other=2"],
      ],
    ],
    [
      "a record that starts like it, before the real one",
      [[value.slice(0, 5)], [value]],
    ],
  ];
  for (const [name, records] of holds)
    test(`holds: ${name}`, () => {
      expect(txtRecordsHold(records, value)).toBe(true);
    });

  const lacks: [string, string[][]][] = [
    ["no records", []],
    ["another token", [["answerable-domain-verification=fedcba9876543210"]]],
    ["the value with more after it", [[`${value}0`]]],
    ["the value with more before it", [[`x${value}`]]],
    ["part of the value", [[value.slice(0, 10)]]],
    ["the token alone", [["0123456789abcdef"]]],
    ["parts in the wrong order", [[value.slice(10)], [value.slice(0, 10)]]],
    [
      "parts with a record between them",
      [[value.slice(0, 10)], ["other=1"], [value.slice(10)]],
    ],
    ["the value in another case", [[value.toUpperCase()]]],
  ];
  for (const [name, records] of lacks)
    test(`lacks: ${name}`, () => {
      expect(txtRecordsHold(records, value)).toBe(false);
    });
});

describe("lookupTxtRecords", () => {
  let logged: Mock<typeof console.error>;
  beforeEach(() => {
    logged = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => logged.mockRestore());

  test("answers what the resolver answers, for the name it was given", async () => {
    const resolve = mock(async (name: string) => [[name]]);
    expect(
      await lookupTxtRecords(resolve, "_answerable-challenge.a.example"),
    ).toEqual([["_answerable-challenge.a.example"]]);
    expect(logged).not.toHaveBeenCalled();
  });

  test("a domain with no record is nothing, and nothing worth logging", async () => {
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      const resolve = async () => {
        throw Object.assign(new Error("queryTxt ENOTFOUND secret.example"), {
          code,
        });
      };
      expect(await lookupTxtRecords(resolve, "a.example")).toEqual([]);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  test("a resolver that fails is nothing, logged by its code and never its message", async () => {
    const resolve = async () => {
      throw Object.assign(new Error("connect 10.0.0.2:53 refused"), {
        code: "ECONNREFUSED",
      });
    };
    expect(await lookupTxtRecords(resolve, "a.example")).toEqual([]);
    expect(logged.mock.calls).toEqual([
      [
        "[id] domains",
        JSON.stringify({
          level: "error",
          event: "domain_lookup_failed",
          code: "ECONNREFUSED",
        }),
      ],
    ]);
  });

  test("a failure with no code is logged with none", async () => {
    const resolve = async () => {
      throw new Error("internal");
    };
    expect(await lookupTxtRecords(resolve, "a.example")).toEqual([]);
    expect(String(logged.mock.calls[0]![1])).toContain('"code":null');
    expect(String(logged.mock.calls[0]![1])).not.toContain("internal");
  });

  test("a resolver that never answers is nothing once the bound passes, and leaves no timer", async () => {
    const started = performance.now();
    const answer = await lookupTxtRecords(
      () => new Promise(() => {}),
      "a.example",
      20,
    );
    expect(answer).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(String(logged.mock.calls[0]![1])).toContain('"code":"ETIMEOUT"');
  });

  test("the bound is five seconds", () => {
    expect(domainLookupTimeoutMs).toBe(5_000);
  });
});

describe("the system's resolver", () => {
  test("asks node:dns once, with the bound as its own timeout", async () => {
    const asked = spyOn(Resolver.prototype, "resolveTxt").mockImplementation(
      async function (this: Resolver, name: string) {
        return [[name]];
      } as Resolver["resolveTxt"],
    );
    try {
      expect(await systemTxtResolver("a.example")).toEqual([["a.example"]]);
      expect(asked).toHaveBeenCalledWith("a.example");
    } finally {
      asked.mockRestore();
    }
  });
});
