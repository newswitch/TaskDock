$ErrorActionPreference = 'Stop'
$taskdockRoot = Split-Path -Parent $PSScriptRoot
$taskdockCargo = Join-Path $taskdockRoot '.tools\cargo'
if (Test-Path -LiteralPath (Join-Path $taskdockCargo 'bin\cargo.exe')) {
    $env:CARGO_HOME = $taskdockCargo
    $env:RUSTUP_HOME = Join-Path $taskdockRoot '.tools\rustup'
    $env:PATH = (Join-Path $taskdockCargo 'bin') + [IO.Path]::PathSeparator + $env:PATH
}
if ($args.Count -eq 0) { throw 'Supply a command, e.g. cargo test or npm.cmd run tauri:build' }
$taskdockCommand = $args[0]
$taskdockArguments = @($args | Select-Object -Skip 1)
& $taskdockCommand @taskdockArguments
exit $LASTEXITCODE
