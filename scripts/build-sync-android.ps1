param([string]$AndroidSdk = $env:ANDROID_HOME, [switch]$Release)
$ErrorActionPreference = 'Stop'
if (-not $AndroidSdk) { $AndroidSdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$previousSdk = $env:ANDROID_HOME
try {
    $env:ANDROID_HOME = $AndroidSdk
    $buildArguments = @((Join-Path $PSScriptRoot 'build-sync-android.mjs'))
    if ($Release) { $buildArguments += '--release' }
    & node @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'The shared Android sync core build failed.' }
} finally { $env:ANDROID_HOME = $previousSdk }
