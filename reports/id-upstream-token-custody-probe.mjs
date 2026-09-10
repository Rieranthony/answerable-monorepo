// Read-only provider probe. Run from the repository root with Bun.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(
  new URL("../apps/id/package.json", import.meta.url),
);
const oauthPath = pathToFileURL(require.resolve("better-auth/oauth2"));
const { decryptOAuthToken, setTokenUtil } = await import(oauthPath.href);
const { symmetricDecrypt } = await import(
  pathToFileURL(require.resolve("better-auth/crypto")).href
);
const checks = [];
async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
}

// Synthetic fixtures only. No deployment environment, database or network access.
const oldSecret = "synthetic-old-provider-secret-000000000000000";
const newSecret = "synthetic-new-provider-secret-000000000000000";
const plaintext = "synthetic-upstream-access-token";
const context = (secretConfig, enabled = true) => ({
  secretConfig,
  options: { account: { encryptOAuthTokens: enabled } },
});
const singleKey = context(oldSecret);
const oldRing = context({ currentVersion: 1, keys: new Map([[1, oldSecret]]) });
const rotated = context({
  currentVersion: 2,
  keys: new Map([
    [1, oldSecret],
    [2, newSecret],
  ]),
  legacySecret: oldSecret,
});

await check("disabled encryption preserves plaintext", async () => {
  assert.equal(
    await setTokenUtil(plaintext, context(oldSecret, false)),
    plaintext,
  );
});
const ciphertext = await setTokenUtil(plaintext, singleKey);
await check("enabled encryption changes storage and round-trips", async () => {
  assert.notEqual(ciphertext, plaintext);
  assert.equal(await decryptOAuthToken(ciphertext, singleKey), plaintext);
});
await check("enabled reads still accept non-hex legacy plaintext", async () => {
  assert.equal(await decryptOAuthToken(plaintext, singleKey), plaintext);
});
await check(
  "even-length hex plaintext is misclassified as ciphertext",
  async () => {
    await assert.rejects(async () => decryptOAuthToken("deadbeef", singleKey));
  },
);
const versioned = await setTokenUtil(plaintext, oldRing);
await check(
  "versioned ciphertext survives rotation with old key retained",
  async () => {
    assert.ok(versioned.startsWith("$ba$1$"));
    assert.equal(await decryptOAuthToken(versioned, rotated), plaintext);
    assert.ok((await setTokenUtil(plaintext, rotated)).startsWith("$ba$2$"));
  },
);
await check("legacy ciphertext requires the retained legacy key", async () => {
  assert.equal(await decryptOAuthToken(ciphertext, rotated), plaintext);
  await assert.rejects(async () => decryptOAuthToken(ciphertext, oldRing));
});
await check("retired key and incorrect key fail closed", async () => {
  await assert.rejects(async () =>
    decryptOAuthToken(
      versioned,
      context({
        currentVersion: 2,
        keys: new Map([[2, newSecret]]),
      }),
    ),
  );
  await assert.rejects(async () =>
    symmetricDecrypt({ key: newSecret, data: ciphertext }),
  );
});
await check(
  "installed account writer leaves ID token outside encryption helper",
  async () => {
    const source = await readFile(
      new URL("./link-account.mjs", oauthPath),
      "utf8",
    );
    assert.equal((source.match(/idToken: account\.idToken/g) ?? []).length, 3);
    assert.equal(
      (source.match(/accessToken: await setTokenUtil/g) ?? []).length,
      3,
    );
    assert.equal(
      (source.match(/refreshToken: await setTokenUtil/g) ?? []).length,
      3,
    );
  },
);

console.log(
  JSON.stringify(
    {
      scope:
        "Installed provider helpers and source; not a database or complete SSO proof",
      checks,
    },
    null,
    2,
  ),
);
