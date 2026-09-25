import { useState } from "react"
import { createRoot } from "react-dom/client"
import { useApp } from "@modelcontextprotocol/ext-apps/react"
import { recordsOutput, recordsViewOutput, type FixtureRecord } from "../contracts"
import "./records.css"

function Records() {
  const [records, setRecords] = useState<FixtureRecord[]>([])
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [canWrite, setCanWrite] = useState<boolean | null>(null)
  const { app, isConnected, error } = useApp({
    appInfo: { name: "Answerable test records", version: "0.1.0" },
    capabilities: {},
    onAppCreated(app) {
      app.ontoolresult = result => {
        const parsed = recordsViewOutput.safeParse(result.structuredContent)
        if (parsed.success) {
          setRecords(parsed.data.records)
          setCanWrite(parsed.data.canWrite)
        } else setFailure("The host returned an invalid record list")
      }
    },
  })

  async function act(name: string, args: Record<string, string>) {
    if (!app || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await app.callServerTool({ name, arguments: args })
      if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join(" "))
      if (name === "records_create") setTitle("")
      const refreshed = await app.callServerTool({ name: "records_list", arguments: {} })
      if (refreshed.isError) throw new Error("The action completed, but refreshing records failed")
      setRecords(recordsOutput.parse(refreshed.structuredContent).records)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The action failed.")
    } finally {
      setBusy(false)
    }
  }

  return <main aria-busy={busy}>
    <header><span className="eyebrow">ANSWERABLE · LOCAL FIXTURE</span><h1>Test records</h1><p>Records belong to your authenticated organisation.</p></header>
    {(failure || error) ? <p role="alert">{failure || error?.message}</p> : null}
    {canWrite ? <div className="form">
      <label htmlFor="title">Record title</label>
      <div className="row">
        <input id="title" value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && title.trim()) {
            event.preventDefault()
            void act("records_create", { title: title.trim() })
          }
        }} maxLength={200} required disabled={busy} placeholder="A harmless test record" />
        <button type="button" onClick={() => void act("records_create", { title: title.trim() })} disabled={!isConnected || busy || !title.trim()}>Create record</button>
      </div>
    </div> : null}
    <section aria-label="Records" aria-live="polite">
      {!isConnected || canWrite === null ? <p>Connecting to the host…</p> : records.length === 0 ? <p>No test records yet.</p> : <ul>{records.map(record => <li key={record.id}><span>{record.title}</span>{canWrite ? <button type="button" className="secondary" aria-label={`Delete ${record.title}`} disabled={busy} onClick={() => void act("records_delete", { recordId: record.id })}>Delete</button> : null}</li>)}</ul>}
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(<Records />)
