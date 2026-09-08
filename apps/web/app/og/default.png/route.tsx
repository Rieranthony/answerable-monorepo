import { ImageResponse } from "takumi-js/response"
import { Logo } from "@/components/logo"
import { DEFAULT_OG_IMAGE } from "@/lib/metadata"

export const dynamic = "force-static"

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#000000",
        color: "#ffffff",
      }}
    >
      <Logo width={720} height={180} fill="#ffffff" />
    </div>,
    {
      width: DEFAULT_OG_IMAGE.width,
      height: DEFAULT_OG_IMAGE.height,
      format: "png",
    },
  )
}
