import { App } from "@modelcontextprotocol/ext-apps"

document.getElementById("root")!.textContent = "fixture-rendered"

const app = new App({ name: "browser-export-fixture", version: "0.1.0" }, {})
app.connect().catch(() => {})
