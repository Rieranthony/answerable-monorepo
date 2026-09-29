import { useState } from "react"
import { createRoot } from "react-dom/client"
import { useApp } from "@modelcontextprotocol/ext-apps/react"
import { z } from "zod"
import { recordsPage, recordsView, type FixtureRecord } from "../contracts"
import "./records.css"

// The part of a prepared intent the view needs to commit it.
const intentSchema = z.object({ intent_id: z.string(), commit_token: z.string(), commit_tool: z.string(), policy_class: z.string(), preview: z.object({ summary: z.string() }) })
type Intent = z.infer<typeof intentSchema>

// A tool failure is one text block holding the error envelope as JSON.
function reason(text: string) {
  try {
    return String(JSON.parse(text).error.message)
  } catch {
    return text
  }
}

function Records() {
  const [records, setRecords] = useState<FixtureRecord[] | null>(null)
  const [canWrite, setCanWrite] = useState(false)
  const [title, setTitle] = useState("")
  const [pending, setPending] = useState<Intent | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { app, error } = useApp({
    appInfo: { name: "Answerable test records", version: "0.1.0" },
    capabilities: {},
    onAppCreated(app) {
      app.ontoolresult = result => {
        const parsed = recordsView.safeParse(result.structuredContent)
        if (parsed.success) {
          setRecords(parsed.data.items)
          setCanWrite(parsed.data.canWrite)
        } else setFailure("The host returned an invalid record list")
      }
    },
  })

  async function call(name: string, args: Record<string, unknown>) {
    const result = await app!.callServerTool({ name, arguments: args })
    if (result.isError) throw new Error(reason(result.content.map(item => item.type === "text" ? item.text : "").join("")))
    return result.structuredContent
  }
  async function run(step: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      await step()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The action failed.")
    } finally {
      setBusy(false)
    }
  }
  // Commit with the tool the intent names; a controlled intent carries the summary the person confirmed.
  async function commit(intent: Intent) {
    const confirmed = intent.policy_class === "agent" ? {} : { preview_summary: intent.preview.summary }
    await call(intent.commit_tool, { intent_id: intent.intent_id, commit_token: intent.commit_token, ...confirmed })
    setPending(null)
    setRecords(recordsPage.parse(await call("records_list", {})).items)
  }
  const create = () => run(async () => {
    await commit(intentSchema.parse(await call("records_create", { title: title.trim() })))
    setTitle("")
  })
  const remove = (record: FixtureRecord) => run(async () => setPending(intentSchema.parse(await call("records_delete", { id: record.id }))))

  return <main aria-busy={busy}>
    <header><span className="eyebrow">ANSWERABLE · LOCAL FIXTURE</span><h1>Test records</h1><p>Records belong to your authenticated organisation.</p></header>
    {(failure || error) ? <p role="alert">{failure || error?.message}</p> : null}
    {canWrite ? <div className="form">
      <label htmlFor="title">Record title</label>
      <div className="row">
        <input id="title" value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && title.trim()) {
            event.preventDefault()
            void create()
          }
        }} maxLength={200} required disabled={busy} placeholder="A harmless test record" />
        <button type="button" onClick={() => void create()} disabled={!app || busy || !title.trim()}>Create record</button>
      </div>
    </div> : null}
    {pending ? <section className="confirm" aria-label="Confirm the change">
      <p>{pending.preview.summary}</p>
      <div className="row">
        <button type="button" onClick={() => void run(() => commit(pending))} disabled={busy}>Confirm</button>
        <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
      </div>
    </section> : null}
    <section aria-label="Records" aria-live="polite">
      {records === null ? <p>Connecting to the host…</p> : records.length === 0 ? <p>No test records yet.</p> : <ul>{records.map(record => <li key={record.id}>
        <span>{record.title}</span>
        {canWrite ? <button type="button" className="secondary" aria-label={`Delete ${record.title}`} disabled={busy || pending !== null} onClick={() => void remove(record)}>Delete</button> : null}
      </li>)}</ul>}
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(<Records />)
