import { expect, test } from "bun:test";
import { testEnvironment } from "../__tests__/support.ts";
import { serviceUrl } from "./service-url.ts";
test("service URL removes trailing slashes without changing the origin", () => {
  for (const suffix of ["", "/", "///"])
    expect(
      serviceUrl(
        testEnvironment({ betterAuthUrl: "https://id.example.com" + suffix }),
      ),
    ).toBe("https://id.example.com");
});
