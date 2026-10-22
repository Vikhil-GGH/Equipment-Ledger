# The ONLY launcher that can WRITE to production: one migration step at a time, with explicit confirmations.
# Do NOT run it until the owner has approved that exact step (see docs\PRODUCTION_WINDOW_RUNBOOK.md).
#
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-apply.ps1 -Record 20260901000016
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-apply.ps1 -Apply  20260901000015
#
# - Record = the migration is already in place; only its history row is added.
# - Apply  = run that ONE migration (with its documented adaptation) in ONE transaction and record it.
# - The applier refuses anything that is not exactly the next step of the plan, anything partly in place,
#   and anything already recorded. A failing step is rolled back completely.
# - The password is typed hidden and kept in memory only; it is removed afterwards. Nothing is written to disk.
param([string]$Record = '', [string]$Apply = '', [string]$Rollback = '')

$ErrorActionPreference = 'Stop'
$projectRef = 'jhwhftaffsjulrvtajnl'
$dbUser = "postgres.$projectRef"; $dbHost = 'aws-0-us-east-1.pooler.supabase.com'; $dbPort = 5432; $dbName = 'postgres'
if ((@($Record, $Apply, $Rollback) | Where-Object { $_ }).Count -ne 1) { throw 'Give exactly one of -Record, -Apply or -Rollback <version>.' }
$version = if ($Record) { $Record } elseif ($Apply) { $Apply } else { $Rollback }
$mode = if ($Record) { '--record' } elseif ($Apply) { '--apply' } else { '--rollback' }
if ($version -notmatch '^\d{14}$') { throw 'The version must be 14 digits, e.g. 20260901000015.' }

Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
Write-Host "PRODUCTION WRITE: $($mode.TrimStart('-').ToUpper()) $version on project $projectRef"
Write-Host 'This changes the production database. Read the plan first (run-preflight.ps1 -Task plan).'
$typed = Read-Host "Type the project reference ($projectRef) to confirm"
if ($typed -ne $projectRef) { throw 'Confirmation did not match. Nothing was done.' }
$secure = Read-Host -AsSecureString 'Production database password (typing is hidden)'
$bstr = [IntPtr]::Zero
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain)) { throw 'No password entered.' }
  $env:PRODUCTION_DB_URL = 'postgresql://{0}:{1}@{2}:{3}/{4}' -f $dbUser, [uri]::EscapeDataString($plain), $dbHost, $dbPort, $dbName
  $env:PRODUCTION_DB_SSL_CA = 'certs\supabase-ca-2021.crt'
  node scripts\production\apply-migration.mjs --confirm-project $projectRef $mode $version --execute
  Write-Host "Finished (exit code $LASTEXITCODE). Now run: run-preflight.ps1 -Task compare -BackupDir <the backup folder>"
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item Env:\PRODUCTION_DB_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\PRODUCTION_DB_SSL_CA -ErrorAction SilentlyContinue
  $plain = $null; $secure.Dispose()
}
