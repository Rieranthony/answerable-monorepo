import { expect, test } from "bun:test";

import { generateClientSecret, hashClientSecret } from "./client-secrets.ts";

test("generates distinct 32-byte unpadded base64url secrets", () => {
  const secret = generateClientSecret();
  expect(secret).toHaveLength(43);
  expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(Buffer.from(secret, "base64url")).toHaveLength(32);
  expect(generateClientSecret()).not.toBe(secret);
});

test("hashes with SHA-256 and unpadded base64url", async () => {
  const secret = "fixed client secret ✓";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  expect(hashClientSecret(secret)).toBe(expected);
  expect(hashClientSecret(secret)).not.toMatch(/[=+/]/);
});
