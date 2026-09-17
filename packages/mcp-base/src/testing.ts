import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

/** Connect the real protocol client. The caller owns authentication and cleanup. */
export async function connectTestClient(options: { url: URL; accessToken: string }) {
  const client = new Client({ name: "answerable-test", version: "0.1.0" })
  try {
    await client.connect(new StreamableHTTPClientTransport(options.url, {
      requestInit: { headers: { Authorization: `Bearer ${options.accessToken}` } },
    }))
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}
