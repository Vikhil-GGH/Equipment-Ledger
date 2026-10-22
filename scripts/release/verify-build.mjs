// Checks a release build (default ./release-dist) before anyone deploys it. READ-ONLY.
//   node scripts/release/verify-build.mjs [dir] [--production-ref <ref>]
// Fails (exit 2) on: wrong base path in index.html / manifest, missing 404.html / .nojekyll / service worker,
// any reference to the STAGING project, a database password or service key, or a missing/foreign Supabase URL.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'release-dist'))
const refIdx = args.indexOf('--production-ref')
const base = process.env.PAGES_BASE ?? '/Equipment-Ledger/'
const STAGING_REF = 'ioqfvkvrlamyzowwescf'
const problems = []
const ok = (c, msg) => { console.log(`${c ? '✔' : '✖'} ${msg}`); if (!c) problems.push(msg) }
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
if (!existsSync(join(dir, 'index.html'))) { console.error(`No build in ${dir}`); process.exit(1) }

const html = readFileSync(join(dir, 'index.html'), 'utf8')
ok(html.includes(`src="${base}assets/`) || html.includes(`href="${base}assets/`), `index.html loads its assets from ${base}assets/`)
ok(!/(src|href)="\/(?!Equipment-Ledger\/)[^"]*"/.test(html.replace(/https?:\/\/[^"]*/g, '')), 'index.html has no root-relative URL outside the base path')
ok(existsSync(join(dir, '404.html')) && readFileSync(join(dir, '404.html'), 'utf8') === html, '404.html equals index.html (deep links load the app)')
ok(existsSync(join(dir, '.nojekyll')), '.nojekyll present')
ok(existsSync(join(dir, 'sw.js')), 'service worker sw.js present (replaces the old app\'s sw.js at the same address)')
const manifestName = readdirSync(dir).find((f) => f.endsWith('.webmanifest') || f === 'manifest.json')
if (manifestName) {
  const m = JSON.parse(readFileSync(join(dir, manifestName), 'utf8'))
  ok(m.start_url === base && m.scope === base, `manifest start_url and scope are ${base} (got ${m.start_url} / ${m.scope})`)
  ok((m.icons ?? []).every((i) => !i.src.startsWith('/')), 'manifest icons are relative to the app')
} else ok(false, 'web app manifest present')

const text = walk(dir).filter((f) => /\.(js|html|css|json|webmanifest|txt)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')
ok(!text.includes(STAGING_REF), 'no reference to the staging project')
ok(!/postgres(ql)?:\/\/[^\s"']+:[^\s"'@]{3,}@/.test(text), 'no database connection string with a password')
ok(!/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/.test(text.replace(/anon/g, '')) || /"role":"anon"/.test(Buffer.from((text.match(/eyJ[A-Za-z0-9_-]{15,}\.([A-Za-z0-9_-]{15,})\./) ?? [])[1] ?? '', 'base64').toString()), 'any embedded JWT is the public anon key (role anon), not a service key')
const urls = [...new Set([...text.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))]
ok(urls.length === 1, `exactly one Supabase project is referenced (${urls.join(', ') || 'none'})`)
if (refIdx >= 0) ok(urls[0] === args[refIdx + 1], `the Supabase project is the production one (${args[refIdx + 1]})`)
console.log(`\nFiles: ${walk(dir).length}, ${Math.round(walk(dir).reduce((n, f) => n + statSync(f).size, 0) / 1024)} KB`)
console.log(problems.length ? `\n✖ ${problems.length} problem(s): do NOT deploy.` : '\n✔ Build is safe to deploy.')
process.exit(problems.length ? 2 : 0)
