import { writeFile } from "node:fs/promises"
import sharp from "sharp"
import { COMMA_PATH } from "../components/logo"

// Run from apps/web: bun scripts/build-icons.ts
const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" fill="black"/><svg x="54" y="36" width="72" height="108" viewBox="1103.79 215.998 48.21 72.002"><path fill="white" d="${COMMA_PATH}"/></svg></svg>`,
)
await sharp(svg).png().toFile("app/apple-icon.png")

const sizes = [16, 32, 48]
const images = await Promise.all(
  sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()),
)
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
images.forEach((image, index) => {
  const entry = 6 + index * 16
  header[entry] = sizes[index]
  header[entry + 1] = sizes[index]
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(image.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += image.length
})
await writeFile("app/favicon.ico", Buffer.concat([header, ...images]))
