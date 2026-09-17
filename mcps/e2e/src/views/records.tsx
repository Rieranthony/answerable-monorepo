import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { useApp } from "@answerable/mcp-base/apps/react"
import { recordsOutput, type FixtureRecord } from "../contracts"
import "./records.css"

function Records() {
  const [records, setRecords] = useState<FixtureRecord[]>([])
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const pending = useRef<{ signature: string; operationKey: string } | null>(null)
  const { app, isConnected, error } = useApp({
    appInfo: { name: "Answerable test records", version: "0.1.0" },
    capabilities: {},
    onAppCreated(app) {
      app.ontoolresult = result => {
        const parsed = recordsOutput.safeParse(result.structuredContent)
        if (parsed.success) setRecords(parsed.data.records)
        else setFailure("The host returned an invalid record list")
      }
    },
  })

  async function act(name: string, args: Record<string, string>) {
    if (!app || busy) return
    setBusy(true)
    setFailure(null)
    const signature = JSON.stringify({ name, args })
    if (pending.current?.signature !== signature) pending.current = { signature, operationKey: crypto.randomUUID() }
    try {
      const result = await app.callServerTool({ name, arguments: { ...args, operationKey: pending.current.operationKey } })
      if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join(" "))
      pending.current = null
      if (name === "records_create") setTitle("")
      const refreshed = await app.callServerTool({ name: "records_list", arguments: {} })
      if (refreshed.isError) throw new Error("The action completed, but refreshing records failed")
      setRecords(recordsOutput.parse(refreshed.structuredContent).records)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The action failed. Retry to check its outcome.")
    } finally {
      setBusy(false)
    }
  }

  return <main aria-busy={busy}>
    <header><span className="eyebrow">ANSWERABLE · LOCAL FIXTURE</span><h1>Test records</h1><p>Records belong to your authenticated organisation.</p></header>
    {(failure || error) ? <p role="alert">{failure || error?.message}</p> : null}
    <div className="form">
      <label htmlFor="title">Record title</label>
      <div className="row"><input id="title" value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && title.trim()) { event.preventDefault(); void act("records_create", { title: title.trim() }) } }} maxLength={200} required disabled={busy} placeholder="A harmless test record" /><button type="button" onClick={() => void act("records_create", { title: title.trim() })} disabled={!isConnected || busy || !title.trim()}>Create record</button></div>
    </div>
    <section aria-label="Records" aria-live="polite">
      {!isConnected ? <p>Connecting to the host…</p> : records.length === 0 ? <p>No test records yet.</p> : <ul>{records.map(record => <li key={record.id}><span>{record.title}</span><button type="button" className="secondary" aria-label={`Delete ${record.title}`} disabled={busy} onClick={() => void act("records_delete", { recordId: record.id })}>Delete</button></li>)}</ul>}
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(<Records />)
