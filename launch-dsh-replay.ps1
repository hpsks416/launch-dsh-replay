# DSH Session Replay - interactive launcher (desktop port)
# Keeps the window open, prints English only (console code-page safe).
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $here 'dsh-replay-web.mjs'
$render = Join-Path $here 'render.mjs'

function Show-Menu {
    Clear-Host
    Write-Host ''
    Write-Host '=============================================='
    Write-Host '  DSH Session Replay (offline, read-only)'
    Write-Host '=============================================='
    Write-Host ''
    Write-Host '  1) Open the guide page in the browser (local server, 127.0.0.1:7781)'
    Write-Host '  2) Render the newest session and open it'
    Write-Host '  3) List sessions'
    Write-Host '  4) Render a session by number'
    Write-Host '  0) Exit'
    Write-Host ''
}

while ($true) {
    Show-Menu
    $choice = Read-Host '  select'
    switch ($choice) {
        '1' {
            Start-Process -FilePath 'node' -ArgumentList @($server) -WorkingDirectory $here
            Write-Host '  server window started; press Enter to return to this menu.'
            Read-Host | Out-Null
        }
        '2' {
            $out = Join-Path $env:TEMP 'dsh-replay-out\latest.html'
            & node $render --latest --out $out
            if (Test-Path $out) { Start-Process $out }
            Read-Host '  press Enter to continue' | Out-Null
        }
        '3' {
            & node $render --list
            Read-Host '  press Enter to continue' | Out-Null
        }
        '4' {
            & node $render --list
            $id = Read-Host '  session id'
            if (-not [string]::IsNullOrWhiteSpace($id)) {
                $out = Join-Path $env:TEMP "dsh-replay-out\$($id.Trim()).html"
                & node $render --id $id.Trim() --out $out
                if (Test-Path $out) { Start-Process $out }
            }
            Read-Host '  press Enter to continue' | Out-Null
        }
        default { return }
    }
}
