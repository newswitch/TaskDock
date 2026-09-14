$ErrorActionPreference = 'Stop'
$taskdockRoot = Split-Path -Parent $PSScriptRoot
$taskdockTools = Join-Path $taskdockRoot '.tools'
New-Item -ItemType Directory -Path $taskdockTools -Force | Out-Null
$env:CARGO_HOME = Join-Path $taskdockTools 'cargo'
$env:RUSTUP_HOME = Join-Path $taskdockTools 'rustup'
$taskdockInstaller = Join-Path $taskdockTools 'rustup-init.exe'
if (-not (Test-Path -LiteralPath $taskdockInstaller)) {
    Invoke-WebRequest -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $taskdockInstaller -TimeoutSec 60
}
& $taskdockInstaller -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-msvc --default-toolchain stable
exit $LASTEXITCODE
