import { describe, expect, test } from "bun:test";

import { isUuidV7 } from "../__tests__/support.ts";
import { createId } from "./id.ts";

describe("unit: UUID generation", () => {
  test("creates unique UUIDv7 identifiers", () => {
    const first = createId();
    const second = createId();

    expect(isUuidV7(first)).toBe(true);
    expect(second).not.toBe(first);
  });
});
