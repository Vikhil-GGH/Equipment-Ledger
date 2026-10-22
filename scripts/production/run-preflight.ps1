# Runs the READ-ONLY production preflight without ever writing the database password anywhere.
#
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1
#
# - The password is typed at a hidden prompt (not echoed, not stored in the shell history).
# - It is placed in two process environment variables for the duration of the run only, then removed.
# - Nothing is written to disk or to the repository; the preflight opens ONE read-only transaction
#   (verified TLS, rolled back) and prints a report that contains no secrets. Copy the report and share it.
# - The connection details below are the production project's session pooler (public information).

$ErrorActionPreference = 'Stop'
$projectRef = 'jhwhftaffsjulrvtajnl'
$dbUser     = "postgres.$projectRef"
$dbHost     = 'aws-0-us-east-1.pooler.supabase.com'
$dbPort     = 5432
$dbName     = 'postgres'

Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))   # the repository root
if (-not (Test-Path 'certs\supabase-ca-2021.crt')) { throw 'certs\supabase-ca-2021.crt not found; run this from the repository.' }

Write-Host "Production preflight (READ-ONLY): $dbUser @ $dbHost`:$dbPort/$dbName"
Write-Host 'Enter the production database password (typing is hidden). Not the connection string, just the password.'
$secure = Read-Host -AsSecureString 'Password'
$bstr = [IntPtr]::Zero
try {
  $bstr  = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '^\[?YOUR-PASSWORD\]?$') { throw 'No real password entered.' }
  # Percent-encode so characters such as @ : / # ? in the password cannot change the meaning of the URL.
  $env:PREFLIGHT_DB_URL = 'postgresql://{0}:{1}@{2}:{3}/{4}' -f $dbUser, [uri]::EscapeDataString($plain), $dbHost, $dbPort, $dbName
  $env:PREFLIGHT_DB_SSL_CA = 'certs\supabase-ca-2021.crt'   # Supabase root CA: the server certificate is VERIFIED
  node scripts\production\preflight.mjs
  $exit = $LASTEXITCODE
  Write-Host ''
  Write-Host "Preflight finished (exit code $exit; 0 = nothing blocks, 2 = items to resolve). Nothing was written to the database."
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item Env:\PREFLIGHT_DB_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\PREFLIGHT_DB_SSL_CA -ErrorAction SilentlyContinue
  $plain = $null
  $secure.Dispose()
}
