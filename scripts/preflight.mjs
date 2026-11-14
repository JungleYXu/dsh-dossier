#!/usr/bin/env node
/**
 * preflight — verify this checkout is installable BEFORE anything is installed.
 *
 * It exists because several failure classes are invisible until the app restarts:
 *
 *  - a client bundle whose `__ModuleLoader__.load({ id })` differs from the
 *    package name. The web boot then treats the bundle as "loaded without
 *    registering", executes it a second time, and the duplicate registration
 *    aborts startup with `web boot: 1 entry did not activate`.
 *  - a client bundle that forgot to declare a host package it requires, so the
 *    boot graph loads it before that module exists and the factory throws.
 *  - an installed copy that is a stale snapshot rather than a link: the source
 *    was fixed but the app boots the old bytes.
 *
 * Usage: node scripts/preflight.mjs   (exits 1 on any problem)
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const problems = []

const read = (name) => readFileSync(join(root, name), 'utf8')
const fail = (message) => problems.push(message)

// ---- package.json ---------------------------------------------------------
let manifest
try {
  manifest = JSON.parse(read('package.json'))
} catch (error) {
  console.error(`FAIL  package.json is not valid JSON: ${error.message}`)
  process.exit(1)
}

const name = manifest.name
if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) fail('package.json name must be a lowercase npm-style name')
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)) fail('package.json version must be semver')
if (manifest.type !== 'module') fail('package.json type must be "module" (the host imports index.js as ESM)')
if (manifest.exports?.['./client'] !== './client.js') fail('package.json exports["./client"] must be "./client.js" (the web boot resolves the bundle through it)')
if (manifest.dsh?.bundle?.patch === undefined) fail('package.json dsh.bundle.patch is missing')
else if (!existsSync(join(root, manifest.dsh.bundle.patch))) fail(`dsh.bundle.patch points at ${manifest.dsh.bundle.patch}, which does not exist`)
if (manifest.dsh?.client?.platform !== 'web') fail('package.json dsh.client.platform must be "web"')

for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
  if (!(manifest.files ?? []).some((entry) => entry === required)) fail(`package.json files[] must list ${required}, or the published package is incomplete`)
}

// ---- the client bundle ----------------------------------------------------
const client = read('client.js')
const loads = (client.match(/__ModuleLoader__\.load\(/g) ?? []).length
if (loads !== 1) fail(`client.js must call window.__ModuleLoader__.load() exactly once (found ${loads})`)

const idMatch = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"`]([^'"`]+)['"`]/)
if (!idMatch) fail('client.js must register through window.__ModuleLoader__.load({ id, factory })')
else if (idMatch[1] !== name) fail(`client.js registers id "${idMatch[1]}" but the package is "${name}" — the boot graph looks the factory up by package name, so a mismatch aborts the web boot`)

if (/\bid:\s*['"`]@local\//.test(client)) fail('client.js must not register an @local/ prefixed id — the profile installs this package under its own name')
if (/^\s*(import|export)\s/m.test(client)) fail('client.js must not use static import/export — it is a classic script evaluated by the module loader')

// Every `require()` in the factory must be a package the host provides. The
// dossier bundle only asks for react, so anything else is a typo or a missing
// dsh.client.inject entry and would throw at boot.
const requires = [...new Set([...client.matchAll(/\brequire\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]))]
const allowed = new Set(['react', ...(manifest.dsh?.client?.inject ?? [])
  .map((spec) => spec.replace(/^@deepseek-ai\/dsh-client-/, ''))
  .map((short) => short)])
for (const spec of requires) {
  if (spec.startsWith('.') || spec.startsWith('/')) continue
  if (spec !== 'react' && !allowed.has(spec)) fail(`client.js requires "${spec}" but it is neither react nor listed in dsh.client.inject — at boot the factory would get undefined`)
}

// ---- the bundle patch -----------------------------------------------------
if (existsSync(join(root, 'cordis.patch.yml'))) {
  const patch = read('cordis.patch.yml')
  if (!new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(patch)) fail(`cordis.patch.yml must insert a row with name: ${name}`)
  if (!/\bid:\s*\S+/.test(patch)) fail('cordis.patch.yml must give the inserted row an id')
}

// ---- the installed copy (drift detector) ----------------------------------
const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const installed = join(profileDir, 'node_modules', name)

if (existsSync(installed)) {
  let linked = false
  try {
    linked = realpathSync(installed).toLowerCase() === realpathSync(root).toLowerCase()
  } catch {
    linked = false
  }
  if (linked) {
    console.log(`note: installed at ${relative(process.cwd(), installed) || installed} as a link (no copy to drift)`)
  } else {
    const compared = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json'].filter((file) => existsSync(join(installed, file)))
    const stale = compared.filter((file) => readFileSync(join(installed, file), 'utf8') !== read(file))
    if (stale.length > 0 && statSync(installed).isDirectory()) {
      fail(`the installed copy is stale: ${stale.join(', ')} differ${stale.length === 1 ? 's' : ''} from this checkout — reinstall (or link) before restarting, or the app boots the old bundle`)
    }
  }
} else {
  console.log('note: not installed in the current profile yet')
}

// ---- verdict --------------------------------------------------------------
if (problems.length > 0) {
  console.error(`FAILED (${problems.length})`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`ok: ${name}@${manifest.version} is ready to install (${requires.length} required module(s), client id matches the package name)`)
