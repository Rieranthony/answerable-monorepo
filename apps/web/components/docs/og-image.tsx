import "server-only"

import { COMMA_PATH } from "@/components/logo"

const MAX_TITLE_LENGTH = 58

function truncateTitle(title: string) {
  if (title.length <= MAX_TITLE_LENGTH) return title

  return `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

export function DocsOgImage({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        padding: 80,
        backgroundColor: "#ffffff",
        color: "#000000",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Public Sans",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
        }}
      >
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.08,
            maxHeight: 138,
            overflow: "hidden",
          }}
        >
          {truncateTitle(title)}
        </div>
        {description ? (
          <div
            style={{
              marginTop: 30,
              color: "#808080",
              fontSize: 30,
              fontWeight: 400,
              lineHeight: 1.3,
            }}
          >
            {description}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize: 28,
          lineHeight: 1,
        }}
      >
        <svg
          viewBox="1103.79 215.998 48.21 72.002"
          width="27"
          height="40"
          fill="#000000"
        >
          <path d={COMMA_PATH} />
        </svg>
        <span style={{ fontWeight: 700 }}>Answerable</span>
        <span style={{ color: "#808080", fontWeight: 400 }}>Docs</span>
      </div>
    </div>
  )
}
