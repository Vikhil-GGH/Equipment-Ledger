# Runs a READ-ONLY production check without ever writing the database password anywhere.
#
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1               (the preflight)
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1 -Task probe    (which of 015-020 are in place + duplicate-serial facts)
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1 -Task plan     (the migration plan the applier would follow; still read-only)
#
# - The password is typed at a hidden prompt (not echoed, not stored in the shell history).
# - It is placed in process environment variables for the duration of the run only, then removed.
# - Nothing is written to disk or to the repository; each task opens ONE read-only transaction
#   (verified TLS, rolled back) and prints a report that contains no secrets. Copy the report and share it.
# - The connection details below are the production project's session pooler (public information).
param([ValidateSet('preflight', 'probe', 'plan')][string]$Task = 'preflight')

$ErrorActionPreference = 'Stop'
$projectRef = 'jhwhftaffsjulrvtajnl'
$dbUser     = "postgres.$projectRef"
$dbHost     = 'aws-0-us-east-1.pooler.supabase.com'
$dbPort     = 5432
$dbName     = 'postgres'

Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))   # the repository root
if (-not (Test-Path 'certs\supabase-ca-2021.crt')) { throw 'certs\supabase-ca-2021.crt not found; run this from the repository.' }

Write-Host "Production $Task (READ-ONLY): $dbUser @ $dbHost`:$dbPort/$dbName"
Write-Host 'Enter the production database password (typing is hidden). Not the connection string, just the password.'
$secure = Read-Host -AsSecureString 'Password'
$bstr = [IntPtr]::Zero
try {
  $bstr  = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '^\[?YOUR-PASSWORD\]?$') { throw 'No real password entered.' }
  # Percent-encode so characters such as @ : / # ? in the password cannot change the meaning of the URL.
  $url = 'postgresql://{0}:{1}@{2}:{3}/{4}' -f $dbUser, [uri]::EscapeDataString($plain), $dbHost, $dbPort, $dbName
  $env:PREFLIGHT_DB_URL = $url; $env:PREFLIGHT_DB_SSL_CA = 'certs\supabase-ca-2021.crt'   # the server certificate is VERIFIED
  $env:PRODUCTION_DB_URL = $url; $env:PRODUCTION_DB_SSL_CA = 'certs\supabase-ca-2021.crt'
  switch ($Task) {
    'preflight' { node scripts\production\preflight.mjs }
    'probe'     { node scripts\production\probe-state.mjs }
    'plan'      { node scripts\production\apply-migration.mjs --confirm-project $projectRef }   # no --execute: read-only
  }
  $exit = $LASTEXITCODE
  Write-Host ''
  Write-Host "Finished (exit code $exit). Nothing was written to the database."
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  foreach ($n in 'PREFLIGHT_DB_URL', 'PREFLIGHT_DB_SSL_CA', 'PRODUCTION_DB_URL', 'PRODUCTION_DB_SSL_CA') { Remove-Item "Env:\$n" -ErrorAction SilentlyContinue }
  $plain = $null; $url = $null
  $secure.Dispose()
}
