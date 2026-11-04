// Read the mail of a kept stack: `bun infra/k8s/local/read-mail.ts <the directory the stack kept>`. The stack's fake Postmark stops with its test, and ID's pods keep sending to
// POSTMARK_API_URL, so this serves the same fake again, on the same port with the same certificate and the token ID holds, and prints each email as it arrives, link and code
// included, as the log transport does locally. Ctrl-C stops it. Needs the cluster kept (INFRA_STACK_KEEP=1), which keeps the directory with its kubeconfig and certificates.
import { startFakePostmark } from "@answerable/acceptance"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { postmarkPort } from "./egress"

const workdir = process.argv[2]
if (!workdir) {
  console.error("Usage: bun infra/k8s/local/read-mail.ts <the directory the stack kept>")
  process.exit(2)
}
const kubectl = Bun.spawnSync(["kubectl", "get", "secret", "-n", "answerable", "id-env", "-o", "jsonpath={.data.POSTMARK_SERVER_TOKEN}"], { env: { ...process.env, KUBECONFIG: join(workdir, "kubeconfig") }, stdout: "pipe", stderr: "pipe" })
if (kubectl.exitCode !== 0) {
  console.error(`kubectl could not read the Secret id-env with ${join(workdir, "kubeconfig")}: ${kubectl.stderr.toString().trim()}`)
  process.exit(1)
}
const token = Buffer.from(kubectl.stdout.toString(), "base64").toString()
const fake = startFakePostmark({ token, hostname: "0.0.0.0", port: postmarkPort, tls: { cert: readFileSync(join(workdir, "fake-postmark.pem"), "utf8"), key: readFileSync(join(workdir, "fake-postmark.key"), "utf8") } })
console.log(`The fake Postmark listens on ${fake.url}; each email ID sends is printed here.`)
let shown = 0
for (;;) {
  for (const mail of fake.messages().slice(shown)) {
    console.log(`\n--- ${new Date(mail.receivedAt).toISOString()} to ${mail.to}, ${mail.subject} (tag ${mail.tag})\n${mail.text}`)
    shown++
  }
  await Bun.sleep(500)
}
