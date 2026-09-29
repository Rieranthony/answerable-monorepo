import { useState } from "react"
import { createRoot } from "react-dom/client"
import { useApp } from "@modelcontextprotocol/ext-apps/react"
import { recordsView, type FixtureRecord } from "../contracts"
import "./records.css"

function Records() {
  const [records, setRecords] = useState<FixtureRecord[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const { error } = useApp({
    appInfo: { name: "Answerable test records", version: "0.1.0" },
    capabilities: {},
    onAppCreated(app) {
      app.ontoolresult = result => {
        const parsed = recordsView.safeParse(result.structuredContent)
        if (parsed.success) setRecords(parsed.data.items)
        else setFailure("The host returned an invalid record list")
      }
    },
  })

  return <main>
    <header><span className="eyebrow">ANSWERABLE · LOCAL FIXTURE</span><h1>Test records</h1><p>Records belong to your authenticated organisation.</p></header>
    {(failure || error) ? <p role="alert">{failure || error?.message}</p> : null}
    <section aria-label="Records" aria-live="polite">
      {records === null ? <p>Connecting to the host…</p> : records.length === 0 ? <p>No test records yet.</p> : <ul>{records.map(record => <li key={record.id}>{record.title}</li>)}</ul>}
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(<Records />)
