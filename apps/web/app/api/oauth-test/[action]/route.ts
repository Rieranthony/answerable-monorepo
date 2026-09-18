import { handleOAuthTest } from "@/lib/oauth-test/handler"
import { testClient } from "@/lib/oauth-test/runtime"
export const dynamic = "force-dynamic"
async function handle(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return handleOAuthTest(
    request,
    (await context.params).action,
    process.env.NODE_ENV === "development",
    testClient,
  )
}
export { handle as GET, handle as POST }
