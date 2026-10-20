// Better Auth reads these from the process when an option is absent
// (`options.secrets ?? BETTER_AUTH_SECRETS` in its context). Tests pass every
// value explicitly, so a developer's environment must never reach them.
for (const name of [
  "BETTER_AUTH_SECRETS",
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "BETTER_AUTH_URL",
])
  delete process.env[name];

// The pages serve a prebuilt stylesheet; compile it once, so `bun test` alone
// runs the asset tests against what a deployment serves.
const css = Bun.spawnSync([process.execPath, "scripts/build-css.ts"], {
  cwd: new URL("../..", import.meta.url).pathname,
  stdout: "ignore",
  stderr: "inherit",
});
if (!css.success) throw new Error("scripts/build-css.ts failed");
