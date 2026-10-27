# Launcher for the reviewed assignment change list. Dry run unless -Execute. Run only after the migration chain is complete
# and the owner has approved this step (docs\PRODUCTION_GO_NO_GO.md). The password is typed hidden and never stored.
#   powershell -ExecutionPolicy Bypass -File scripts\production\run-assignments.ps1 -ChangeList "$env:USERPROFILE\EquipmentLedger-reconcile\change-list.json" -Expect 51
param([Parameter(Mandatory)][string]$ChangeList, [Parameter(Mandatory)][int]$Expect, [switch]$Execute)
$ErrorActionPreference = 'Stop'
$projectRef = 'jhwhftaffsjulrvtajnl'
$dbUser = "postgres.$projectRef"; $dbHost = 'aws-0-us-east-1.pooler.supabase.com'; $dbPort = 5432; $dbName = 'postgres'
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$mode = if ($Execute) { 'EXECUTE (commits)' } else { 'dry run (rolls back)' }
Write-Host "PRODUCTION assignments on ${projectRef}: $mode"
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
  $extra = @(); if ($Execute) { $extra += '--execute' }
  node scripts\production\apply-assignments.mjs --confirm-project $projectRef --change-list $ChangeList --expect $Expect @extra
  Write-Host "Finished (exit code $LASTEXITCODE)."
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item Env:\PRODUCTION_DB_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\PRODUCTION_DB_SSL_CA -ErrorAction SilentlyContinue
  $plain = $null; $secure.Dispose()
}
