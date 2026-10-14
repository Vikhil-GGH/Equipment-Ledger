// Sets the app role of a STAGING account — the staging equivalent of
// running `update profiles set role = …` in the SQL editor. The account
// itself is created in the staging dashboard first (Authentication ->
// Users -> Add user), because creating logins needs Supabase Auth.
//
//   npm run staging:set-role                          (STAGING_ADMIN_EMAIL -> admin)
//   npm run staging:set-role -- someone@example.com editor
//   npm run staging:set-role -- someone@example.com viewer
//
// Refuses to run against production (see lib.mjs).
import { connectStagingDb, fail, loadStagingEnv } from './lib.mjs'

const ROLES = ['admin', 'editor', 'viewer', 'scanner']
const env = loadStagingEnv(['STAGING_DB_URL'])
const [emailArg, roleArg] = process.argv.slice(2)
const email = emailArg ?? env.STAGING_ADMIN_EMAIL
const role = roleArg ?? 'admin'
if (!email) fail('Give an email, or set STAGING_ADMIN_EMAIL in .env.staging.local.')
if (!ROLES.includes(role)) fail(`Role must be one of: ${ROLES.join(', ')}`)

const db = await connectStagingDb(env)
let exitCode = 0
try {
  // Upsert: also re-creates the profile if the admin page's "Remove access"
  // deleted it (the login itself still exists in Supabase Auth).
  const { rows } = await db.query(
    `insert into profiles (id, email, role)
       select id, email, $2::user_role from auth.users where lower(email) = lower($1) and not is_anonymous
     on conflict (id) do update set role = excluded.role
     returning email, role`,
    [email, role],
  )
  if (rows.length === 0) {
    throw new Error(
      `No staging account with email ${email}. Create it first: staging dashboard -> Authentication -> Users -> Add user -> Create new user (tick Auto Confirm User).`,
    )
  }
  console.log(`✔ ${rows[0].email} is now ${rows[0].role} on staging.`)
  const all = await db.query(`select email, role from profiles where email not like 'anonymous-%' order by email`)
  console.log('\nStaging accounts:')
  for (const r of all.rows) console.log(`  ${r.role.padEnd(8)} ${r.email}`)
} catch (err) {
  console.error(`\n✖ ${err.message}\n`)
  exitCode = 1
} finally {
  await db.end()
}
process.exit(exitCode)
