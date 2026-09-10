import { expect, test } from "bun:test";
import { createOperationCipher } from "./operation-cipher.ts";
const oldKey = Buffer.alloc(32, 1).toString("base64url");
const newKey = Buffer.alloc(32, 2).toString("base64url");

test("versioned encryption recovers exact JSON, binds the operation and supports key rotation", async () => {
  const old = createOperationCipher({
    activeKeyId: "old",
    keys: { old: oldKey },
  });
  const rotated = createOperationCipher({
    activeKeyId: "new",
    keys: { old: oldKey, new: newKey },
  });
  const body = {
    secret: "never-store-this-plaintext",
    nested: [true, null, 42],
  };
  const encrypted = await old.encrypt("operation-one", body);
  expect(encrypted).not.toContain(body.secret);
  expect(await rotated.decrypt("operation-one", encrypted)).toEqual(body);
  expect(await old.encrypt("operation-one", body)).not.toBe(encrypted);
  await expect(rotated.decrypt("operation-two", encrypted)).rejects.toThrow();
  const next = await rotated.encrypt("operation-one", body);
  expect(await rotated.decrypt("operation-one", next)).toEqual(body);
  await expect(old.decrypt("operation-one", next)).rejects.toThrow();
  const parts = encrypted.split(".");
  parts[3] = (parts[3]!.startsWith("A") ? "B" : "A") + parts[3]!.slice(1);
  await expect(
    rotated.decrypt("operation-one", parts.join(".")),
  ).rejects.toThrow();
  await expect(
    createOperationCipher({
      activeKeyId: "old",
      keys: { old: newKey },
    }).decrypt("operation-one", encrypted),
  ).rejects.toThrow();
});

test("invalid key configuration and oversized responses fail before storage", async () => {
  for (const config of [
    { activeKeyId: "missing", keys: { old: oldKey } },
    { activeKeyId: "old", keys: { old: "short" } },
    { activeKeyId: "old", keys: { old: "!".repeat(43) } },
  ])
    expect(() => createOperationCipher(config)).toThrow();
  const cipher = createOperationCipher({
    activeKeyId: "old",
    keys: { old: oldKey },
  });
  await expect(cipher.encrypt("one", "x".repeat(1_048_576))).rejects.toThrow(
    "too large",
  );
  await expect(cipher.decrypt("one", "malformed")).rejects.toThrow();
  await expect(cipher.encrypt("one", { amount: NaN })).rejects.toThrow(
    "finite JSON",
  );
});

test("keyed request fingerprints support rotation and reject changed input without exposing a plain digest", () => {
  const original = createOperationCipher({
    activeKeyId: "old",
    keys: { old: oldKey },
  });
  const rotated = createOperationCipher({
    activeKeyId: "new",
    keys: { old: oldKey, new: newKey },
  });
  const input = '{"clientSecret":"guessable-secret"}';
  const fingerprint = original.fingerprint(input);
  expect(fingerprint).toStartWith("hmac-v1.");
  expect(fingerprint).not.toContain("guessable-secret");
  expect(rotated.matchesFingerprint(input, fingerprint)).toBe(true);
  expect(rotated.matchesFingerprint(input + "changed", fingerprint)).toBe(
    false,
  );
  expect(rotated.fingerprint(input)).not.toBe(fingerprint);
  expect(() =>
    original.matchesFingerprint(input, rotated.fingerprint(input)),
  ).toThrow();
  const replacement = createOperationCipher({
    activeKeyId: "old",
    keys: { old: newKey },
  });
  expect(replacement.matchesFingerprint(input, fingerprint)).toBe(false);
  for (const invalid of [
    "",
    "hmac-v2.a.b",
    "hmac-v1..",
    "hmac-v1.b2xk.short",
    "hmac-v1.!.'",
  ])
    expect(() => original.matchesFingerprint(input, invalid)).toThrow();
});
