$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$MAX_BYTES = 16384
function Fail([string]$Code) { throw ('CLOCK_JOURNAL_STORE_' + $Code) }
function Hash([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function ExactKeys($Value, [string[]]$Keys) {
    if ($Value -isnot [Collections.IDictionary] -or (($Value.Keys | Sort-Object) -join ',') -cne (($Keys | Sort-Object) -join ',')) { Fail 'RECORD_REJECTED' }
}
function NoDuplicateKeys($Element) {
    if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $seen.Add($property.Name)) { Fail 'RECORD_REJECTED' }
            NoDuplicateKeys $property.Value
        }
    } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
        foreach ($item in $Element.EnumerateArray()) { NoDuplicateKeys $item }
    }
}
function ParseObject([string]$Text) {
    $document = $null
    try {
        $options = [Text.Json.JsonDocumentOptions]::new()
        $options.MaxDepth = 10
        $document = [Text.Json.JsonDocument]::Parse($Text, $options)
        NoDuplicateKeys $document.RootElement
        $value = ConvertFrom-Json -InputObject $Text -AsHashtable -Depth 10
        if ($value -isnot [Collections.IDictionary]) { Fail 'RECORD_REJECTED' }
        return $value
    } catch { Fail 'RECORD_REJECTED' }
    finally { if ($document) { $document.Dispose() } }
}
function ValidateRecoveryAttempt($Value, [string]$Reservation) {
    ExactKeys $Value @('schemaVersion','reservationId','kind','status','sourceSha','manifestSha256','operationId','stage',
        'callIdSha256','approvedRootCommit','issuedAt','expiresAt','reservedAt','directoryId','aclSha256',
        'priorJournalDirectoryId','originalRequestSha256','maximumReadRequests','remoteWritesAllowed','providerAdvancesAllowed',
        'retryAllowed','physicalExecutionAllowed')
    foreach ($field in @('schemaVersion','issuedAt','expiresAt','reservedAt','maximumReadRequests','remoteWritesAllowed','providerAdvancesAllowed')) {
        if (($Value[$field] -isnot [long] -and $Value[$field] -isnot [int]) -or
            $Value[$field] -lt 0 -or $Value[$field] -gt 9007199254740991) { Fail 'RECORD_REJECTED' }
    }
    if ($Value.schemaVersion -ne 1 -or $Value.reservationId -cne $Reservation -or $Value.kind -cne 'clock_recovery_read_only' -or
        $Value.status -cne 'reserved' -or $Value.stage -notin @('dev','test') -or
        $Value.operationId -isnot [string] -or $Value.operationId -cnotmatch '^[A-Za-z0-9:_-]{8,128}$') { Fail 'RECORD_REJECTED' }
    foreach ($field in @('sourceSha','approvedRootCommit')) {
        if ($Value[$field] -isnot [string] -or $Value[$field] -cnotmatch '^[a-f0-9]{40}$') { Fail 'RECORD_REJECTED' }
    }
    foreach ($field in @('manifestSha256','callIdSha256','directoryId','aclSha256')) {
        if ($Value[$field] -isnot [string] -or $Value[$field] -cnotmatch '^[a-f0-9]{64}$') { Fail 'RECORD_REJECTED' }
    }
    foreach ($field in @('priorJournalDirectoryId','originalRequestSha256')) {
        if ($null -ne $Value[$field] -and ($Value[$field] -isnot [string] -or $Value[$field] -cnotmatch '^[a-f0-9]{64}$')) { Fail 'RECORD_REJECTED' }
    }
    if ($Value.remoteWritesAllowed -ne 0 -or $Value.providerAdvancesAllowed -ne 0 -or
        $Value.retryAllowed -isnot [bool] -or $Value.retryAllowed -cne $false -or
        $Value.physicalExecutionAllowed -isnot [bool] -or $Value.physicalExecutionAllowed -cne $false -or
        $Value.issuedAt -gt $Value.reservedAt -or $Value.reservedAt -ge $Value.expiresAt -or
        $Value.expiresAt - $Value.issuedAt -gt 900000) { Fail 'RECORD_REJECTED' }
    $maximum = 15
    if ($null -ne $Value.originalRequestSha256) {
        $maximum = 16
        if ($null -eq $Value.priorJournalDirectoryId) { Fail 'RECORD_REJECTED' }
    }
    if ($Value.maximumReadRequests -ne $maximum -or
        ($null -ne $Value.priorJournalDirectoryId -and $Value.priorJournalDirectoryId -ceq $Value.directoryId)) { Fail 'RECORD_REJECTED' }
}
function ValidateRecord([string]$Filename, [string]$Text) {
    if ($Text -match '(?:[rs]k_(?:test|live)_[A-Za-z0-9_]{12,}|whsec_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]{20,}\.)') { Fail 'RECORD_REJECTED' }
    $value = ParseObject $Text
    if ($Filename -cnotmatch '^([a-f0-9]{64})\.(intent|delivery|readback|provider-advance-intent|provider-advance-result|caller-attempt|recovery-attempt)\.json$') { Fail 'FILE_REJECTED' }
    $reservation = $Matches[1]
    $kind = $Matches[2]
    if ($kind -eq 'recovery-attempt') { ValidateRecoveryAttempt $value $reservation; return }
    $keys = switch ($kind) {
        'intent' { @('schemaVersion','reservationId','sourceSha','operationId','phase','scope','reservedAt','clientRequestToken','transactionSha256','readbackSha256') }
        'delivery' { @('schemaVersion','reservationId','transactionSha256','delivery','recordedAt','retryAllowed','physicalExecutionAllowed') }
        'readback' { @('schemaVersion','reservationId','transactionSha256','readbackSha256','recordedAt','status','reason','clockReadable','retryAllowed','physicalExecutionAllowed') }
        'provider-advance-intent' { @('schemaVersion','reservationId','transactionSha256','readbackSha256','operationId','testClockId','priorFrozenTimeSeconds','targetFrozenTimeSeconds','apiVersion','bodySha256','body','idempotencyKey','reservedAt') }
        'provider-advance-result' { @('schemaVersion','reservationId','transactionSha256','targetFrozenTimeSeconds','status','recordedAt','retryAllowed','readyEvidencePublished','physicalAuthorizationChecked') }
        'caller-attempt' { @('schemaVersion','reservationId','sourceSha','manifestSha256','requestSha256','transactionSha256','readbackSha256','operationId','phase','stage','approvedRootCommit','callIdSha256','issuedAt','expiresAt','reservedAt','directoryId','aclSha256','status','retryAllowed','physicalExecutionAllowed') }
    }
    ExactKeys $value $keys
    if ($value.schemaVersion -ne 1 -or $value.reservationId -cne $reservation -or $value.transactionSha256 -cnotmatch '^[a-f0-9]{64}$') { Fail 'RECORD_REJECTED' }
    if ($kind -eq 'intent') {
        ExactKeys $value.scope @('awsAccountId','region','stage','appTableName','privacyTableName','ownerSub','stripeAccountId','customerId','testClockId','bindingId')
        if ($value.sourceSha -cnotmatch '^[a-f0-9]{40}$' -or $value.operationId -cnotmatch '^[A-Za-z0-9:_-]{1,128}$' -or
            $value.phase -notin @('install','advance_fence','ready','refresh')) { Fail 'RECORD_REJECTED' }
        foreach ($entry in $value.scope.Values) { if ($entry -isnot [string] -or $entry.Length -lt 1 -or $entry.Length -gt 256) { Fail 'RECORD_REJECTED' } }
    }
    if ($value.Contains('readbackSha256') -and $value.readbackSha256 -cnotmatch '^[a-f0-9]{64}$') { Fail 'RECORD_REJECTED' }
    if ($kind -eq 'caller-attempt') {
        foreach ($field in @('manifestSha256','requestSha256','callIdSha256','directoryId','aclSha256')) {
            if ($value[$field] -isnot [string] -or $value[$field] -cnotmatch '^[a-f0-9]{64}$') { Fail 'RECORD_REJECTED' }
        }
        if ($value.sourceSha -cnotmatch '^[a-f0-9]{40}$' -or $value.approvedRootCommit -cnotmatch '^[a-f0-9]{40}$' -or
            $value.operationId -cnotmatch '^[A-Za-z0-9:_-]{8,128}$' -or $value.phase -notin @('install','advance_fence','ready','refresh') -or
            $value.stage -notin @('dev','test') -or $value.status -cne 'reserved') { Fail 'RECORD_REJECTED' }
        foreach ($field in @('issuedAt','expiresAt','reservedAt')) {
            if ($value[$field] -isnot [long] -and $value[$field] -isnot [int]) { Fail 'RECORD_REJECTED' }
            if ($value[$field] -lt 0 -or $value[$field] -gt 9007199254740991) { Fail 'RECORD_REJECTED' }
        }
        if ($value.issuedAt -gt $value.reservedAt -or $value.reservedAt -ge $value.expiresAt -or $value.expiresAt - $value.issuedAt -gt 900000) { Fail 'RECORD_REJECTED' }
    }
    foreach ($field in @('retryAllowed','physicalExecutionAllowed','readyEvidencePublished','physicalAuthorizationChecked')) {
        if ($value.Contains($field) -and $value[$field] -cne $false) { Fail 'RECORD_REJECTED' }
    }
}
function RestrictedAcl($Info, [bool]$Directory) {
    $acl = [IO.FileSystemAclExtensions]::GetAccessControl($Info)
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $script:Actor.Value) { Fail 'ACL_REJECTED' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3 -or ($Directory -and -not $acl.AreAccessRulesProtected)) { Fail 'ACL_REJECTED' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -notin $script:Allowed -or $rule.AccessControlType -ne 'Allow' -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or ($Directory -and $rule.IsInherited)) { Fail 'ACL_REJECTED' }
        if ($Directory -and ($rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None)) { Fail 'ACL_REJECTED' }
    }
    return $acl
}
function SafeParent([string]$Parent) {
    if (-not [IO.Directory]::Exists($Parent)) { Fail 'DIRECTORY_REQUIRED' }
    $acl = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($Parent))
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $script:Allowed -and
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
            ($rule.FileSystemRights -band $writeMask) -ne 0) { Fail 'PARENT_ACL_REJECTED' }
    }
}
function ReadBytes([IO.FileStream]$Stream) {
    if ($Stream.Length -lt 1 -or $Stream.Length -gt $MAX_BYTES) { Fail 'RECORD_REJECTED' }
    $Stream.Position = 0
    $buffer = [byte[]]::new([int]$Stream.Length)
    $offset = 0
    while ($offset -lt $buffer.Length) {
        $read = $Stream.Read($buffer, $offset, $buffer.Length - $offset)
        if ($read -eq 0) { Fail 'FILE_REJECTED' }
        $offset += $read
    }
    return ,$buffer
}
$directoryHandle = $null
$ancestorHandles = [Collections.Generic.List[IDisposable]]::new()
$stream = $null
try {
    $inputText = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($inputText) -gt 49152) { Fail 'RECORD_REJECTED' }
    $request = ParseObject $inputText
    if ($request.schemaVersion -ne 1 -or $request.action -notin @('initialize','inspect','write','read')) { Fail 'RECORD_REJECTED' }
    $keys = @('schemaVersion','action','directory')
    if ($request.action -in @('write','read')) { $keys += @('expectedDirectoryId','expectedAclSha256','filename') }
    if ($request.action -eq 'write') { $keys += @('payloadJson','payloadSha256') }
    ExactKeys $request $keys
    $directory = $request.directory
    if ($directory -isnot [string] -or $directory -notmatch '^[A-Za-z]:[\\/]' -or $directory.Length -gt 240 -or
        $directory.Substring(2) -match '[<>:"|?*\x00-\x1f]') { Fail 'PATH_REJECTED' }
    $directory = [IO.Path]::GetFullPath($directory)
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($directory))
    if ($drive.DriveFormat -ne 'NTFS' -or $drive.DriveType -ne [IO.DriveType]::Fixed) { Fail 'NTFS_REQUIRED' }
    $ancestor = [IO.Path]::GetDirectoryName($directory)
    while ($ancestor) {
        if (-not [IO.Directory]::Exists($ancestor)) { Fail 'DIRECTORY_REQUIRED' }
        if (([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'PATH_REJECTED' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $script:Actor = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $script:Allowed = @($script:Actor.Value, 'S-1-5-18', 'S-1-5-32-544')
    SafeParent ([IO.Path]::GetDirectoryName($directory))
    if ($request.action -eq 'initialize') {
        if ([IO.Directory]::Exists($directory) -or [IO.File]::Exists($directory)) { Fail 'DIRECTORY_EXISTS' }
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($script:Actor)
        foreach ($identity in $script:Allowed) {
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity),
                [Security.AccessControl.FileSystemRights]::FullControl,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        }
        [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($directory), $security)
    }
    if (-not [IO.Directory]::Exists($directory)) { Fail 'DIRECTORY_REQUIRED' }
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'PATH_REJECTED' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ClockJournalNative {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
  public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
  public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
 public static Info Inspect(SafeFileHandle handle) {
  Info info;if(!GetFileInformationByHandle(handle,out info))throw new InvalidOperationException();return info;
 }
}
'@
    # Lock the whole local path top-down. A writable ancestor cannot redirect a
    # filename after the bound directory has been checked.
    $chain = [Collections.Generic.Stack[string]]::new()
    $component = $directory
    while ($component) { $chain.Push($component); $component = [IO.Path]::GetDirectoryName($component) }
    while ($chain.Count -gt 0) {
        $component = $chain.Pop()
        $handle = [ClockJournalNative]::CreateFileW($component, 0, 3, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
        if ($handle.IsInvalid) { $handle.Dispose(); Fail 'FILE_REJECTED' }
        $ancestorHandles.Add($handle)
        $part = [ClockJournalNative]::Inspect($handle)
        if (($part.Attributes -band 0x400) -ne 0 -or ($part.Attributes -band 0x10) -eq 0) { Fail 'PATH_REJECTED' }
        $directoryHandle = $handle
    }
    $info = [ClockJournalNative]::Inspect($directoryHandle)
    if (($info.Attributes -band 0x400) -ne 0 -or ($info.Attributes -band 0x10) -eq 0) { Fail 'PATH_REJECTED' }
    $idText = '{0}:{1}:{2}:{3}:{4}' -f $info.Volume, $info.IndexHigh, $info.IndexLow, $info.Creation.dwHighDateTime, $info.Creation.dwLowDateTime
    $directoryId = Hash ([Text.Encoding]::UTF8.GetBytes($idText))
    $acl = RestrictedAcl ([IO.DirectoryInfo]::new($directory)) $true
    $sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
    $aclHash = Hash ([Text.Encoding]::UTF8.GetBytes($sddl))
    if ($request.action -in @('write','read') -and ($directoryId -cne $request.expectedDirectoryId -or $aclHash -cne $request.expectedAclSha256)) { Fail 'DIRECTORY_CHANGED' }
    $result = [ordered]@{schemaVersion=1;status='ok';fileSystem='NTFS';ownerVerified=$true;allowedPrincipalCount=3;directoryId=$directoryId;aclSha256=$aclHash}
    if ($request.action -in @('write','read')) {
        if ($request.filename -isnot [string] -or $request.filename -cnotmatch '^[a-f0-9]{64}\.(intent|delivery|readback|provider-advance-intent|provider-advance-result|caller-attempt|recovery-attempt)\.json$') { Fail 'FILE_REJECTED' }
        $file = [IO.Path]::Combine($directory, $request.filename)
        if ($request.action -eq 'write') {
            if ($request.payloadJson -isnot [string]) { Fail 'RECORD_REJECTED' }
            $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($request.payloadJson)
            if ($bytes.Length -lt 1 -or $bytes.Length -gt $MAX_BYTES -or (Hash $bytes) -cne $request.payloadSha256) { Fail 'RECORD_REJECTED' }
            ValidateRecord $request.filename $request.payloadJson
            try {
                $stream = [IO.FileStream]::new($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
            } catch {
                $cause = $_.Exception
                while ($cause.InnerException) { $cause = $cause.InnerException }
                if ($cause -is [IO.IOException] -and ($cause.HResult -band 0xFFFF) -in @(80,183)) { Fail 'ALREADY_RESERVED' }
                Fail 'NATIVE_FAILED'
            }
            $stream.Write($bytes, 0, $bytes.Length)
            try { $stream.Flush($true) } catch { Fail 'FLUSH_FAILED' }
        } else {
            if (-not [IO.File]::Exists($file)) { Fail 'FILE_REQUIRED' }
            if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'FILE_REJECTED' }
            $stream = [IO.FileStream]::new($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        }
        $fileInfo = [ClockJournalNative]::Inspect($stream.SafeFileHandle)
        if ($fileInfo.Links -ne 1 -or ($fileInfo.Attributes -band 0x400) -ne 0 -or ($fileInfo.Attributes -band 0x10) -ne 0) { Fail 'FILE_REJECTED' }
        $null = RestrictedAcl ([IO.FileInfo]::new($file)) $false
        $observedBytes = ReadBytes $stream
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($observedBytes)
        ValidateRecord $request.filename $text
        $payloadHash = Hash $observedBytes
        if ($request.action -eq 'write' -and ($payloadHash -cne $request.payloadSha256 -or $text -cne $request.payloadJson)) { Fail 'FLUSH_FAILED' }
        $result.filename = $request.filename
        $result.payloadSha256 = $payloadHash
        $result.byteLength = $observedBytes.Length
        $result.fileAclVerified = $true
        if ($request.action -eq 'write') {
            $result.writeThrough = $true
            $result.flushToDisk = $true
            $result.exclusiveCreate = $true
        } else { $result.payloadJson = $text }
    }
    $result | ConvertTo-Json -Compress -Depth 15
    exit 0
} catch {
    $code = $_.Exception.Message
    if ($code -cnotmatch '^CLOCK_JOURNAL_STORE_[A-Z_]+$') { $code = 'CLOCK_JOURNAL_STORE_NATIVE_FAILED' }
    [ordered]@{status='rejected';code=$code} | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($stream) { $stream.Dispose() }
    for ($i = $ancestorHandles.Count - 1; $i -ge 0; $i--) { $ancestorHandles[$i].Dispose() }
}
