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
