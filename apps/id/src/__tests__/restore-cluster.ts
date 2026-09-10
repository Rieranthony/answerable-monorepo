import assert from "node:assert/strict";

/** A fresh, loopback-only PostgreSQL cluster using the already running image. */
export async function restoreCluster(root: string, archive: string) {
  async function docker(
    args: string[],
    options: { stdin?: ReturnType<typeof Bun.file>; password?: string } = {},
  ) {
    const child = Bun.spawn(["docker", ...args], {
      cwd: root,
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        ...(options.password ? { POSTGRES_PASSWORD: options.password } : {}),
      },
    });
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, `Disposable PostgreSQL ${args[0]} failed`);
    return output.trim();
  }
  const source = await docker(["compose", "ps", "-q", "postgres"]);
  assert.match(source, /^[a-f0-9]{12,64}$/);
  const image = await docker(["inspect", "--format", "{{.Image}}", source]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const password = crypto.randomUUID();
  const container = await docker(
    [
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      `answerable-id-restore-${crypto.randomUUID()}`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=answerable",
      "--env",
      "POSTGRES_DB=answerable_id_test",
      "--env",
      "POSTGRES_PASSWORD",
      image,
    ],
    { password },
  );
  assert.match(container, /^[a-f0-9]{64}$/);
  let closed = false;
  async function close() {
    if (closed) return;
    await docker(["rm", "--force", container]);
    closed = true;
  }
  try {
    // The official image's temporary initialisation server is Unix-socket-only.
    // Require TCP readiness, otherwise restore could race its shutdown/restart.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const probe = Bun.spawn(
        [
          "docker",
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "answerable",
          "-d",
          "answerable_id_test",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await probe.exited) === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(100);
    }
    assert.ok(ready, "Replacement PostgreSQL did not become ready");
    const address = await docker(["port", container, "5432/tcp"]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
    assert.ok(match, "Replacement PostgreSQL must bind loopback only");
    await docker(
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "-U",
        "answerable",
        "-d",
        "answerable_id_test",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--single-transaction",
        "--exit-on-error",
      ],
      { stdin: Bun.file(archive) },
    );
    const url = new URL(
      `postgres://answerable@127.0.0.1:${match[1]}/answerable_id_test`,
    );
    url.password = password;
    return { url: url.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
