param(
    [ValidateSet('setup', 'load', 'check', 'backup')]
    [string]$Action = 'setup'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$signingNames = @('MUSEAMO_KEYSTORE', 'MUSEAMO_KEY_ALIAS', 'MUSEAMO_STORE_PASSWORD', 'MUSEAMO_KEY_PASSWORD')
$signingDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Museamo/release-signing'
$configPath = Join-Path $signingDirectory 'signing.json'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$windowsAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Protect-Directory([string]$Directory) {
    $null = New-Item -ItemType Directory -Path $Directory -Force
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Protect-Password([string]$Value) {
    $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
    try { return ConvertFrom-SecureString -SecureString $secure }
    finally { $secure.Dispose() }
}

function Unprotect-Password([string]$Value) {
    try { $secure = ConvertTo-SecureString -String $Value }
    catch { throw "The saved signing password cannot be decrypted by Windows account $windowsAccount. Use the account that created this key, or restore your portable signing backup on this Windows installation." }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secure.Dispose()
    }
}

function Read-SavedConfiguration([switch]$AllowMissing) {
    # Test-Path can report false for a protected file. Read it directly to
    # distinguish a missing configuration from a different account's access.
    try { $savedText = [IO.File]::ReadAllText($configPath) }
    catch [UnauthorizedAccessException] {
        throw "Windows account $windowsAccount cannot read $configPath. Run this command in a terminal under the Windows account that created the signing key. Do not replace the existing key."
    }
    catch [IO.FileNotFoundException] {
        if ($AllowMissing) { return $null }
        throw "No saved signing configuration at $configPath for Windows account $windowsAccount. Run npm run release:signing in this terminal once."
    }
    catch [IO.DirectoryNotFoundException] {
        if ($AllowMissing) { return $null }
        throw "No saved signing configuration at $configPath for Windows account $windowsAccount. Run npm run release:signing in this terminal once."
    }
    try { return $savedText | ConvertFrom-Json }
    catch { throw "Saved signing configuration at $configPath is invalid. Restore the original configuration or your portable signing backup." }
}

function Read-SavedSigning {
    $saved = Read-SavedConfiguration
    if ($saved.schema -ne 1 -or !$saved.keystore -or !$saved.alias -or !$saved.storePassword -or !$saved.keyPassword) { throw 'Saved signing configuration is incomplete. Restore it from backup.' }
    return @{
        schema = 1
        MUSEAMO_KEYSTORE = [string]$saved.keystore
        MUSEAMO_KEY_ALIAS = [string]$saved.alias
        MUSEAMO_STORE_PASSWORD = Unprotect-Password $saved.storePassword
        MUSEAMO_KEY_PASSWORD = Unprotect-Password $saved.keyPassword
    }
}

function Set-SigningEnvironment($Signing) {
    foreach ($name in $signingNames) { [Environment]::SetEnvironmentVariable($name, $Signing[$name], 'Process') }
}

function Get-Keytool {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += Join-Path $env:JAVA_HOME 'bin/keytool.exe' }
    $candidates += Join-Path $env:ProgramFiles 'Android/Android Studio/jbr/bin/keytool.exe'
    $onPath = Get-Command keytool.exe -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
    throw 'Install a JDK or set JAVA_HOME before setting up signing.'
}

function Invoke-Keytool([string[]]$ToolArguments) {
    # Capture native output so exceptions never echo password values into logs.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $script:keytool '-J-Duser.language=en' '-J-Duser.country=US' @ToolArguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw 'Keytool could not access or create the signing key. Check the keystore, alias, and passwords.' }
    return ($output | Out-String)
}

function Check-Key($Signing) {
    if (!(Test-Path -LiteralPath $Signing.MUSEAMO_KEYSTORE -PathType Leaf)) { throw 'Signing keystore is missing. Restore the original key from backup.' }
    Set-SigningEnvironment $Signing
    $listing = Invoke-Keytool @('-list', '-v', '-keystore', $Signing.MUSEAMO_KEYSTORE, '-alias', $Signing.MUSEAMO_KEY_ALIAS, '-storepass:env', 'MUSEAMO_STORE_PASSWORD')
    if ($listing -notmatch 'PrivateKeyEntry') { throw 'The selected alias does not contain a private signing key.' }
    # A certificate request also verifies that the private-key password works.
    $null = Invoke-Keytool @('-certreq', '-keystore', $Signing.MUSEAMO_KEYSTORE, '-alias', $Signing.MUSEAMO_KEY_ALIAS, '-storepass:env', 'MUSEAMO_STORE_PASSWORD', '-keypass:env', 'MUSEAMO_KEY_PASSWORD')
    if ($listing -notmatch 'SHA256:\s*([A-Fa-f0-9:]+)') { throw 'Could not verify the signing certificate fingerprint.' }
    return $Matches[1]
}

try {
    if ($Action -eq 'load') {
        # Machine-only output, captured by release-signing.mjs and never logged.
        $signing = Read-SavedSigning
        if (!(Test-Path -LiteralPath $signing.MUSEAMO_KEYSTORE -PathType Leaf)) { throw 'Signing keystore is missing.' }
        [Console]::Out.WriteLine(($signing | ConvertTo-Json -Compress))
        exit 0
    }
    $script:keytool = Get-Keytool
    if ($Action -eq 'backup') {
        $signing = Read-SavedSigning
        $fingerprint = Check-Key $signing
        $destination = [IO.Path]::GetFullPath((Read-Host 'Backup keystore path outside this repository (ending in .p12)'))
        if ($destination.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Keep the signing backup outside this repository.' }
        if ([IO.Path]::GetExtension($destination) -ne '.p12' -or (Test-Path -LiteralPath $destination)) { throw 'Choose a new .p12 file; existing backups are never overwritten.' }
        $password = Read-Host 'Choose a backup password (save it in your password manager)' -AsSecureString
        $confirmation = Read-Host 'Confirm backup password' -AsSecureString
        $env:MUSEAMO_BACKUP_PASSWORD = (New-Object Net.NetworkCredential('', $password)).Password
        $confirmText = (New-Object Net.NetworkCredential('', $confirmation)).Password
        if ($env:MUSEAMO_BACKUP_PASSWORD.Length -lt 12 -or $env:MUSEAMO_BACKUP_PASSWORD -cne $confirmText) { throw 'Backup passwords must match and contain at least 12 characters.' }
        $password.Dispose()
        $confirmation.Dispose()
        $confirmText = $null
        $null = Invoke-Keytool @('-importkeystore', '-srckeystore', $signing.MUSEAMO_KEYSTORE, '-srcalias', $signing.MUSEAMO_KEY_ALIAS, '-srcstorepass:env', 'MUSEAMO_STORE_PASSWORD', '-srckeypass:env', 'MUSEAMO_KEY_PASSWORD', '-destkeystore', $destination, '-deststoretype', 'PKCS12', '-deststorepass:env', 'MUSEAMO_BACKUP_PASSWORD', '-destkeypass:env', 'MUSEAMO_BACKUP_PASSWORD', '-noprompt')
        $backup = @{
            MUSEAMO_KEYSTORE = $destination
            MUSEAMO_KEY_ALIAS = $signing.MUSEAMO_KEY_ALIAS
            MUSEAMO_STORE_PASSWORD = $env:MUSEAMO_BACKUP_PASSWORD
            MUSEAMO_KEY_PASSWORD = $env:MUSEAMO_BACKUP_PASSWORD
        }
        if ((Check-Key $backup) -ne $fingerprint) { throw 'Backup verification failed; keep the original signing key.' }
        Write-Output "Verified portable signing backup: $destination"
        Write-Output "Alias: $($backup.MUSEAMO_KEY_ALIAS). Keep this backup and its password private."
        exit 0
    }
    $existingConfiguration = Read-SavedConfiguration -AllowMissing
    if ($existingConfiguration) {
        $signing = Read-SavedSigning
    } elseif ($Action -eq 'check') {
        throw 'No saved signing configuration. Run npm run release:signing.'
    } else {
        $present = @($signingNames | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') })
        if ($present.Count -gt 0 -and $present.Count -ne 4) { throw 'Set all four signing variables to save an existing key, or clear all four to create a new key.' }
        Protect-Directory $signingDirectory
        if ($present.Count -eq 4) {
            $signing = @{ schema = 1 }
            foreach ($name in $signingNames) { $signing[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
            $signing.MUSEAMO_KEYSTORE = [IO.Path]::GetFullPath($signing.MUSEAMO_KEYSTORE)
            if ($signing.MUSEAMO_KEYSTORE.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Move the existing release keystore outside the repository before saving its configuration.' }
        } else {
            $keystore = Join-Path $signingDirectory 'museamo-release.p12'
            if (Test-Path -LiteralPath $keystore) { throw 'A signing keystore already exists without its configuration. Restore the matching signing.json; the key will not be replaced.' }
            $randomBytes = New-Object byte[] 32
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
            $generatedPassword = [BitConverter]::ToString($randomBytes).Replace('-', '')
            $signing = @{
                schema = 1
                MUSEAMO_KEYSTORE = $keystore
                MUSEAMO_KEY_ALIAS = 'museamo-release'
                MUSEAMO_STORE_PASSWORD = $generatedPassword
                MUSEAMO_KEY_PASSWORD = $generatedPassword
            }
            Set-SigningEnvironment $signing
            # Persist encrypted recovery information before creating the private key.
            # If creation fails, a later setup checks the saved state instead of replacing it.
            $saved = @{ schema = 1; keystore = $keystore; alias = $signing.MUSEAMO_KEY_ALIAS; storePassword = Protect-Password $generatedPassword; keyPassword = Protect-Password $generatedPassword }
            $saved | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
            $null = Invoke-Keytool @('-genkeypair', '-keystore', $keystore, '-storetype', 'PKCS12', '-alias', $signing.MUSEAMO_KEY_ALIAS, '-keyalg', 'RSA', '-keysize', '4096', '-sigalg', 'SHA256withRSA', '-validity', '10000', '-dname', 'CN=Museamo', '-storepass:env', 'MUSEAMO_STORE_PASSWORD', '-keypass:env', 'MUSEAMO_KEY_PASSWORD', '-noprompt')
            $generatedPassword = $null
        }
        $fingerprint = Check-Key $signing
        if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
            $saved = @{ schema = 1; keystore = $signing.MUSEAMO_KEYSTORE; alias = $signing.MUSEAMO_KEY_ALIAS; storePassword = Protect-Password $signing.MUSEAMO_STORE_PASSWORD; keyPassword = Protect-Password $signing.MUSEAMO_KEY_PASSWORD }
            $saved | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
        }
    }
    $fingerprint = Check-Key $signing
    Write-Output "Local Android signing ready: $($signing.MUSEAMO_KEYSTORE)"
    Write-Output "Certificate SHA-256: $fingerprint"
    Write-Output 'Release commands now load this key automatically for your Windows account.'
    Write-Output 'Create a portable recovery backup with npm run release:signing:backup.'
} catch {
    [Console]::Error.WriteLine("Signing stopped: $($_.Exception.Message)")
    exit 1
} finally {
    foreach ($name in @($signingNames + 'MUSEAMO_BACKUP_PASSWORD')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
}
