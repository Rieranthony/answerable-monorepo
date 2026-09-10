import { expect, test } from "bun:test";
import { symmetricEncrypt } from "better-auth/crypto";
import { upstreamTokenStorage } from "./upstream-token-storage.ts";

const old = { version: 1, value: Buffer.alloc(32, 19).toString("base64url") };
const active = {
  version: 2,
  value: Buffer.alloc(32, 27).toString("base64url"),
};
const fields = (keys?: (typeof old)[]) =>
  upstreamTokenStorage(keys).schema.account.fields;
const message = "Upstream token storage is unavailable";

test("upstream storage protects all fields and preserves empty/null values", async () => {
  for (const field of Object.values(fields([old]))) {
    expect(field.input).toBe(false);
    expect(field.returned).toBe(false);
    for (const value of ["synthetic-secret", "", null, undefined]) {
      const stored = await field.transform.input(value);
      if (typeof value === "string") {
        expect(stored).not.toBe(value);
        expect(stored).toStartWith("$ba$1$");
      }
      expect(await field.transform.output(stored)).toBe(value);
    }
  }
});

test("rotation uses the first version and retained keys only for decryption", async () => {
  const initial = fields([old]).accessToken.transform;
  const rotated = fields([active, old]).accessToken.transform;
  const ciphertext = await initial.input("synthetic-old-token");
  expect(await rotated.output(ciphertext)).toBe("synthetic-old-token");
  const current = await rotated.input("synthetic-new-token");
  expect(current).toStartWith("$ba$2$");
  expect(
    await fields([old, active]).accessToken.transform.output(current),
  ).toBe("synthetic-new-token");
  expect(await fields([active]).accessToken.transform.output(current)).toBe(
    "synthetic-new-token",
  );
  await expect(
    fields([active]).accessToken.transform.output(ciphertext),
  ).rejects.toThrow(message);
  await expect(
    fields([{ ...old, value: active.value }]).accessToken.transform.output(
      ciphertext,
    ),
  ).rejects.toThrow(message);
});

test("missing keys, corrupt ciphertext and all legacy formats fail safely", async () => {
  const missing = fields().idToken.transform;
  expect(await missing.input(null)).toBeNull();
  expect(await missing.output(undefined)).toBeUndefined();
  await expect(missing.input("synthetic-secret")).rejects.toThrow(message);
  const transform = fields([old]).idToken.transform;
  const valid = await transform.input("synthetic-secret");
  await expect(missing.output(valid)).rejects.toThrow(message);
  for (const value of [
    1,
    false,
    {},
    "plaintext",
    "deadbeef",
    "",
    "$ba$01$00",
    "$ba$1$ff",
    await symmetricEncrypt({ key: old.value, data: "legacy" }),
  ]) {
    await expect(transform.output(value)).rejects.toThrow(message);
  }
  await expect(transform.input({})).rejects.toThrow(message);
  const tampered = valid!.slice(0, -2) + (valid!.endsWith("00") ? "ff" : "00");
  await expect(transform.output(tampered)).rejects.toThrow(message);
});
