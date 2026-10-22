// Prepares the LOCAL `gh-pages` branch from a verified release build, without touching the working tree, the
// current branch or the network. It does NOT push and does NOT change any GitHub setting: GitHub Pages serves
// whatever branch is chosen in Settings > Pages, so nothing is live until the owner switches that setting.
//   node scripts/release/prepare-pages-branch.mjs [release-dir]
// Refuses to run if the build does not pass verify-build.mjs, or if `origin` already has a gh-pages branch.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = resolve(process.argv[2] ?? join(ROOT, 'release-dist'))
const run = (args, opts = {}) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
const verify = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release', 'verify-build.mjs'), dir], { cwd: ROOT, encoding: 'utf8' })
if (verify.status !== 0) { console.error(verify.stdout); console.error('Build failed verification; nothing was created.'); process.exit(2) }

const remote = spawnSync('git', ['ls-remote', '--heads', 'origin', 'gh-pages'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
if (remote.status === 0 && remote.stdout.trim()) { console.error('origin already has a gh-pages branch: it is not unused. Stopping.'); process.exit(3) }

const releaseCommit = run(['rev-parse', 'HEAD'])
const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
const tmp = mkdtempSync(join(tmpdir(), 'pages-index-'))
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index'), GIT_WORK_TREE: dir }
  run(['add', '-A', '-f', '.'], { env })
  const tree = run(['write-tree'], { env })
  const parent = spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/gh-pages'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  const msg = `Release build of ${branch} @ ${releaseCommit.slice(0, 10)} for GitHub Pages (base /Equipment-Ledger/)`
  const commit = run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg])
  run(['update-ref', 'refs/heads/gh-pages', commit])
  const files = run(['ls-tree', '-r', '--name-only', 'gh-pages']).split('\n')
  console.log(`✔ Local branch gh-pages -> ${commit.slice(0, 10)} (${files.length} files, ${parent ? 'new commit on the existing local branch' : 'new orphan branch'}).`)
  console.log(`  Built from ${branch} @ ${releaseCommit.slice(0, 10)}. NOTHING was pushed; no GitHub setting was changed.`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
