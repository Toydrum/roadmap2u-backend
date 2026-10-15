# Only an empty, freshly-created synthetic test directory may be protected here.
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath([Console]::In.ReadToEnd())
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $target.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($target) -notmatch '^roadmap-clock-durable-[A-Za-z0-9_-]+$' -or
    -not [IO.Directory]::Exists($target) -or @([IO.Directory]::EnumerateFileSystemEntries($target)).Count -ne 0 -or
    ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'UNSAFE_TEST_PARENT' }
$actor = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($actor)
foreach ($sid in @($actor.Value,'S-1-5-18','S-1-5-32-544')) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
}
$privateChild = [IO.Path]::Combine($target, 'protected')
if ([IO.Directory]::Exists($privateChild)) { throw 'PRESERVE_TEST_PARENT' }
[IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($privateChild), $security)
