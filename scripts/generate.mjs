#!/usr/bin/env node
/**
 * Regenerate the API types from the HL Hunt OpenAPI document.
 *
 *   npm run generate                              # from production
 *   HLHUNT_OPENAPI=../app/public/openapi.json npm run generate
 *
 * The document is snapshotted to openapi/openapi.json (committed, so a
 * review shows exactly how the API changed) and openapi-typescript turns it
 * into src/generated/openapi.ts. The hand-written resource layer imports
 * those types, so a field the API renames breaks the SDK's typecheck instead
 * of shipping silently.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = process.env.HLHUNT_OPENAPI ?? "https://underwriting.hlhunt.org/openapi.json"

async function load() {
  if (/^https:\/\//.test(source)) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`GET ${source} -> ${res.status}`)
    return await res.text()
  }
  return readFileSync(resolve(source), "utf8")
}

const text = await load()
const doc = JSON.parse(text)
if (!doc.openapi || !doc.paths) throw new Error(`${source} is not an OpenAPI document`)

mkdirSync(resolve(root, "openapi"), { recursive: true })
mkdirSync(resolve(root, "src/generated"), { recursive: true })
writeFileSync(resolve(root, "openapi/openapi.json"), JSON.stringify(doc, null, 2) + "\n")

execFileSync(
  resolve(root, "node_modules/.bin/openapi-typescript"),
  ["openapi/openapi.json", "--output", "src/generated/openapi.ts", "--export-type", "--alphabetize"],
  { cwd: root, stdio: "inherit" },
)
console.log(`Generated from ${source}: ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.webhooks ?? {}).length} webhook events.`)
