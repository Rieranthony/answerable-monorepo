import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"
type CallToolResult = Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>

declare global {
  interface Window {
    getInitial(): Promise<{ html: string; result: CallToolResult }>
  }
}

// Test-only host. Credentials stay in the test process; the opaque iframe sees only bridge messages.
const initial = await window.getInitial()
const iframe = document.querySelector("iframe")!
iframe.style.width = "min(100%, 720px)"
iframe.style.border = "0"
const bridge = new AppBridge(null, { name: "Answerable test host", version: "0.1.0" }, { serverTools: {} })
bridge.onsizechange = ({ height }) => { if (height !== undefined) iframe.style.height = `${Math.min(height, 1200)}px` }
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: {} })
  await bridge.sendToolResult(initial.result)
}
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!))
iframe.srcdoc = initial.html
