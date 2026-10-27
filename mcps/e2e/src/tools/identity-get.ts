// identity.get: who the verified token says is calling, from the token alone.
import { z } from "zod"
import { defineTool } from "../mcp"

export const identityGet = defineTool({
  name: "identity.get",
  description: "Read your verified Answerable ID identity: your user id, the organisation you signed in to and the scopes your token carries.",
  input: z.object({}),
  output: z.object({ userId: z.uuid(), organizationId: z.uuid(), scopes: z.array(z.string()) }),
  scopes: ["e2e:identity"],
  example: {},
  async execute(_input, { principal }) {
    return { userId: principal.userId, organizationId: principal.organizationId, scopes: [...principal.scopes] }
  },
})
