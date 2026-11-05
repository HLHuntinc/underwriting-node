#!/usr/bin/env node
/**
 * Pre-publish gate (`npm run check`, run by prepublishOnly and CI). Fails when:
 *  - the ESM or CJS build does not load, or they export different names;
 *  - src/version.ts and package.json disagree;
 *  - the CLI is not executable or has no shebang;
 *  - anything that looks like a real key or secret is in dist;
 *  - the tarball would contain anything beyond dist, README, CHANGELOG, LICENSE, package.json.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const problems = []
const check = (ok, message) => ok || problems.push(message)

const esm = await import(pathToFileURL(resolve(root, "dist/index.js")).href)
const cjs = createRequire(import.meta.url)(resolve(root, "dist/index.cjs"))
const names = (m) => Object.keys(m).filter((k) => k !== "default" && k !== "__esModule").sort().join(",")
check(names(esm) === names(cjs), `ESM and CJS export different names:\n  esm: ${names(esm)}\n  cjs: ${names(cjs)}`)
check(typeof esm.HLHunt === "function" && typeof cjs.HLHunt === "function", "HLHunt is not exported from both builds")
check(esm.VERSION === pkg.version, `src/version.ts (${esm.VERSION}) != package.json (${pkg.version})`)
const hooks = await import(pathToFileURL(resolve(root, "dist/webhooks.js")).href)
for (const name of ["constructEvent", "verifySignature", "generateSignatureHeader", "isEvent", "WebhookSignatureError"]) {
  check(typeof hooks[name] === "function", `the ./webhooks entry does not export ${name} (the README and the guide import it from there)`)
}
const hooksCjs = createRequire(import.meta.url)(resolve(root, "dist/webhooks.cjs"))
check(names(hooks) === names(hooksCjs), "the ./webhooks ESM and CJS entries export different names")

const cli = resolve(root, "dist/cli.js")
check((statSync(cli).mode & 0o111) !== 0, "dist/cli.js is not executable")
check(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"), "dist/cli.js has no shebang")

const secretPattern = /hlh_(live|test)_[A-Za-z0-9_-]{16,}|whsec_[0-9a-f]{32,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/
for (const file of readdirSync(resolve(root, "dist"))) {
  const text = readFileSync(resolve(root, "dist", file), "utf8")
  check(!secretPattern.test(text), `dist/${file} contains something that looks like a secret`)
}

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }))
const allowed = /^(dist\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/
for (const f of packed[0].files) check(allowed.test(f.path), `unexpected file in the package: ${f.path}`)

if (problems.length) {
  console.error(`Package check failed:\n- ${problems.join("\n- ")}`)
  process.exit(1)
}
console.log(`Package check passed: ${packed[0].files.length} files, ${(packed[0].size / 1024).toFixed(1)} kB packed.`)
