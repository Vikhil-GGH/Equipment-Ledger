// Builds the app for GitHub Pages (https://vikhil-ggh.github.io/Equipment-Ledger/, a project site under a sub-path)
// into ./release-dist (git-ignored), then makes it ready for Pages:
//   - every asset URL, the router and the PWA manifest use the /Equipment-Ledger/ base;
//   - 404.html is a copy of index.html (Pages serves it for unknown paths, so deep links like /laptops still load the app);
//   - .nojekyll (no Jekyll processing).
// Nothing is deployed or pushed by this script. Run it from the release commit, with the production .env present:
//   node scripts/release/build-pages.mjs
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'release-dist')
const BASE = process.env.PAGES_BASE ?? '/Equipment-Ledger/'
if (!existsSync(join(ROOT, '.env')) && !process.env.VITE_SUPABASE_URL) {
  console.error('No production settings: put VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (or the environment).')
  process.exit(1)
}
rmSync(OUT, { recursive: true, force: true })
const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], { cwd: ROOT, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
const build = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', OUT, '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_BASE: BASE } })
if (build.status !== 0) process.exit(build.status ?? 1)
copyFileSync(join(OUT, 'index.html'), join(OUT, '404.html'))
writeFileSync(join(OUT, '.nojekyll'), '')
console.log(`\n✔ Pages build ready in ${OUT} (base ${BASE}). Verify it with: node scripts/release/verify-build.mjs`)
