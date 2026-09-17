#!/usr/bin/env node
// Corre los bloques .http que declaran su status esperado en el comentario
// (ej. "### Test 3: Sin token — 401") y valida la respuesta contra ese numero.
//
//   node smoke.mjs                  # solo casos 4xx/5xx (no mutan datos)
//   node smoke.mjs --all            # incluye los happy path 2xx (DESTRUCTIVO)
//   node smoke.mjs Account          # limita a una carpeta o archivo
//   node smoke.mjs --dry Account    # lista sin ejecutar
//   node smoke.mjs --login          # pide token fresco antes de correr
//   node smoke.mjs -v               # muestra el body de las respuestas que fallan
//   node smoke.mjs --jobs=4         # concurrencia (default 2; subirla dispara el 429 del server)
//   node smoke.mjs --failed         # reejecuta solo lo que fallo en la corrida anterior
//   node smoke.mjs --dump=out       # guarda la respuesta COMPLETA de cada caso en out/

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const runAll = args.includes('--all')
const dry = args.includes('--dry')
const doLogin = args.includes('--login')
const onlyFailed = args.includes('--failed')
const dumpDir = args.find(a => a.startsWith('--dump='))?.split('=')[1] ?? null
const verbose = args.includes('--verbose') || args.includes('-v')
const targets = args.filter(a => !a.startsWith('-'))
const ROOT = process.cwd()

const jobsArg = args.find(a => a.startsWith('--jobs='))
const CONCURRENCY = jobsArg ? Number(jobsArg.split('=')[1]) : 2

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
            y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` }

// --- variables de .vscode/settings.json (mismo formato que usa REST Client) ---
let vars = {}
try {
  const raw = readFileSync(join(ROOT, '.vscode/settings.json'), 'utf8')
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
  const envs = cfg['rest-client.environmentVariables'] ?? {}
  vars = { ...envs.$shared, ...envs[process.env.HTTP_ENV ?? ''] }
} catch (e) {
  console.error(c.r('No pude leer .vscode/settings.json: ' + e.message))
  process.exit(1)
}
if (!vars.baseUrl) { console.error(c.r('Falta baseUrl en $shared')); process.exit(1) }

// --- token fresco (opcional) ---
if (doLogin && !dry) {
  const need = ['apiKey', 'username', 'password'].filter(k => !vars[k])
  if (need.length) { console.error(c.r('Faltan en $shared para --login: ' + need.join(', '))); process.exit(1) }
  const res = await fetch(`${vars.baseUrl}/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: vars.apiKey, username: vars.username, password: vars.password }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) { console.error(c.r(`login fallo: HTTP ${res.status}`)); process.exit(1) }
  // la forma del body varia; busca el primer campo que parezca un JWT
  const find = (o, d = 0) => {
    if (d > 3 || !o || typeof o !== 'object') return null
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^ey[\w-]+\.[\w-]+\./.test(v)) return { k, v }
      if (typeof v === 'object') { const r = find(v, d + 1); if (r) return r }
    }
    return null
  }
  const hit = find(body)
  if (!hit) { console.error(c.r('login OK pero no encontre un JWT en la respuesta')); process.exit(1) }
  vars.token = hit.v
  console.log(c.g(`token fresco desde login (campo "${hit.k}")\n`))
}

// --- descubrir archivos ---
function walk (dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules' || e === '.vscode') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.http')) out.push(p)
  }
  return out
}
let files = walk(ROOT)
if (targets.length) {
  files = files.filter(f => targets.some(t => relative(ROOT, f).startsWith(t.replace(/^\.\//, ''))))
}
files.sort()

// --- parseo de bloques ---
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/
const interp = s => s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m))

function parse (file) {
  const rel = relative(ROOT, file)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)

  // Una corrida de lineas "###" consecutivas es UN solo encabezado: varios
  // archivos usan ### tambien para comentarios de continuacion.
  const blocks = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('###')) {
      const title = []
      while (i < lines.length && lines[i].startsWith('###')) {
        title.push(lines[i].replace(/^#+\s*/, '').trim())
        i++
      }
      i--
      cur = { title: title.filter(Boolean).join(' '), lines: [] }
      blocks.push(cur)
    } else if (cur) cur.lines.push(lines[i])
  }

  const out = []
  for (const blk of blocks) {
    // El repo usa dos convenciones: "— 401" (Account) y "→ 401" (resto),
    // mas algunos "— esperado 401 (...)".
    const expected = blk.title.match(/(?:[—→]|->|esperado)\s*(\d{3})\b/)?.[1]
    if (!expected) continue                       // sin anotacion: no es aserible

    const L = blk.lines
    let i = 0, req = null
    for (; i < L.length; i++) {
      const m = L[i].match(METHOD)
      if (m) { req = { method: m[1], url: m[2] }; break }
    }
    if (!req) continue

    const headers = {}
    for (i++; i < L.length && L[i].trim() !== ''; i++) {
      const idx = L[i].indexOf(':')
      if (idx > 0) headers[L[i].slice(0, idx).trim()] = L[i].slice(idx + 1).trim()
    }
    const body = L.slice(i + 1).join('\n').trim()

    out.push({
      file: rel,
      title: blk.title.slice(0, 90),
      expected: Number(expected),
      method: req.method,
      url: interp(req.url),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, interp(v)])),
      body: body ? interp(body) : undefined,
    })
  }
  return out
}

let cases = files.flatMap(parse)
if (!runAll) cases = cases.filter(t => t.expected >= 400)

// --failed: reejecuta solo los casos marcados FAIL en la ultima corrida
const LAST = join(ROOT, '.smoke-last.json')
const caseId = t => `${t.file} | ${t.title}`
if (onlyFailed) {
  if (!existsSync(LAST)) { console.error(c.r('No hay corrida previa (.smoke-last.json)')); process.exit(1) }
  const prev = new Set(JSON.parse(readFileSync(LAST, 'utf8')).failed)
  cases = cases.filter(t => prev.has(caseId(t)))
  if (!cases.length) { console.log(c.g('La corrida anterior no dejo fallos.')); process.exit(0) }
}

// requests con variables sin resolver -> no se ejecutan
const unresolved = t => /\{\{\w+\}\}/.test(t.url + JSON.stringify(t.headers) + (t.body ?? ''))

console.log(`${cases.length} casos${runAll ? '' : ' (solo 4xx/5xx; usa --all para incluir 2xx)'}\n`)
if (dry) {
  for (const t of cases) console.log(`${c.d(t.file)}  ${t.expected}  ${t.method} ${t.title}`)
  process.exit(0)
}
if (runAll) console.log(c.y('AVISO: --all ejecuta happy paths que crean/borran datos reales.\n'))

// --- ejecucion ---
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let cursor = 0
async function worker () {
  while (cursor < cases.length) {
    const t = cases[cursor++]
    if (unresolved(t)) { results.push({ t, skip: 'variable sin resolver' }); continue }

    // El API limita por rate: reintenta el 429 respetando Retry-After.
    let res = null, err = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(t.url, {
          method: t.method,
          headers: t.headers,
          body: t.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
        })
        if (res.status !== 429 || t.expected === 429) break
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt)
      } catch (e) {
        err = e.name === 'TimeoutError' ? 'timeout' : e.message
        break
      }
    }
    if (err) { results.push({ t, error: err }); continue }
    const mismatch = res.status !== t.expected
    const full = (verbose && mismatch) || dumpDir ? await res.text().catch(() => '') : null
    const preview = verbose && mismatch ? full.replace(/\s+/g, ' ').slice(0, 600) : null
    results.push({ t, got: res.status, preview, full })
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// --- reporte, agrupado por archivo ---
results.sort((a, b) => a.t.file.localeCompare(b.t.file) || a.t.title.localeCompare(b.t.title))
let pass = 0, fail = 0, skip = 0, lastFile = null
for (const r of results) {
  if (r.t.file !== lastFile) { console.log(`\n${r.t.file}`); lastFile = r.t.file }
  if (r.skip)       { skip++; console.log(`  ${c.y('SKIP')} ${r.t.title} ${c.d('(' + r.skip + ')')}`) }
  else if (r.error) { fail++; console.log(`  ${c.r('FAIL')} ${r.t.title} ${c.d('(' + r.error + ')')}`) }
  else if (r.got === r.t.expected) { pass++; console.log(`  ${c.g('PASS')} ${r.t.title}`) }
  else {
    fail++
    console.log(`  ${c.r('FAIL')} ${r.t.title} ${c.d(`esperaba ${r.t.expected}, dio ${r.got}`)}`)
    console.log(`       ${c.d(r.t.method + ' ' + r.t.url.replace(vars.baseUrl, ''))}`)
    if (r.preview) console.log(`       ${c.d(r.preview)}`)
  }
}

if (dumpDir) {
  mkdirSync(dumpDir, { recursive: true })
  const dump = results.map(r => ({
    file: r.t.file, test: r.t.title, method: r.t.method,
    url: r.t.url.replace(vars.baseUrl, ''),
    expected: r.t.expected, got: r.got ?? null, error: r.error ?? null,
    request: r.t.body ?? null, response: r.full ?? null,
  }))
  writeFileSync(join(dumpDir, 'responses.json'), JSON.stringify(dump, null, 2))
  console.log(c.d(`\nrespuestas completas -> ${join(dumpDir, 'responses.json')}`))
}
writeFileSync(LAST, JSON.stringify({
  failed: results.filter(r => r.error || (r.got !== undefined && r.got !== r.t.expected)).map(r => caseId(r.t)),
}, null, 1))
console.log(`\n${c.g(pass + ' pass')}  ${fail ? c.r(fail + ' fail') : '0 fail'}  ${c.y(skip + ' skip')}`)
process.exit(fail ? 1 : 0)
