param([Parameter(Mandatory=$true)][string]$Action, [Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$clock = [System.Diagnostics.Stopwatch]::StartNew()
function Trace-Stage([string]$stage) {
    $line = "NATIVE_FIXTURE_PS_STAGE $Action $PID $($clock.ElapsedMilliseconds)ms $stage"
    [Console]::Error.WriteLine($line)
    # Direct task-owned trace survives subprocess/outer-runner timeout, independent of pipe draining.
    if ($env:DSH_WINDOWS_PRIVATE_IO_TRACE) {
        [System.IO.File]::AppendAllText($env:DSH_WINDOWS_PRIVATE_IO_TRACE, $line + [Environment]::NewLine)
    }
}
Trace-Stage 'enter'
Trace-Stage 'token-user-before'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
Trace-Stage 'token-user-after'
Trace-Stage 'rights-type-before'
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
Trace-Stage 'rights-type-after'
$allow = [System.Security.AccessControl.AccessControlType]::Allow
Trace-Stage 'allow-type-after'
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
Trace-Stage 'inheritance-type-after'
$none = [System.Security.AccessControl.PropagationFlags]::None
Trace-Stage 'propagation-type-after'
function PrivateDirectory([string]$name) {
    Trace-Stage 'directory-new-object-before'
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    Trace-Stage 'directory-new-object-after'
    $acl.SetOwner($user)
    Trace-Stage 'directory-owner-after'
    $acl.SetAccessRuleProtection($true, $false)
    Trace-Stage 'directory-protection-after'
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $inherit, $none, $allow)
    Trace-Stage 'directory-rule-new-object-after'
    $acl.AddAccessRule($rule)
    Trace-Stage 'directory-security-ready'
    [System.IO.Directory]::CreateDirectory($name, $acl) | Out-Null
    Trace-Stage 'directory-created'
}
switch ($Action) {
    'directory' { PrivateDirectory $Path }
    'file' {
        # Explicit owner at exclusive creation; DACL inherits from already-private parent.
        Trace-Stage 'file-new-object-before'
        $acl = New-Object System.Security.AccessControl.FileSecurity
        Trace-Stage 'file-new-object-after'
        $acl.SetOwner($user)
        Trace-Stage 'file-owner-after'
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $allow)
        Trace-Stage 'file-rule-new-object-after'
        $acl.AddAccessRule($rule)
        Trace-Stage 'file-security-ready'
        $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::CreateNew, $full, [System.IO.FileShare]'ReadWrite, Delete', 4096, [System.IO.FileOptions]::None, $acl)
        Trace-Stage 'file-created'
        $stream.Dispose()
        Trace-Stage 'file-closed'
    }
    'everyone' {
        Trace-Stage 'get-acl-before'
        $acl = Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), [System.Security.AccessControl.FileSystemRights]::Read, $allow)))
        Trace-Stage 'everyone-rule-ready'
        Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'inherit-everyone' {
        Trace-Stage 'get-acl-before'
        $acl = Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), [System.Security.AccessControl.FileSystemRights]::Read, $inherit, $none, $allow)))
        Trace-Stage 'inherited-everyone-rule-ready'
        Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'unprotect' {
        Trace-Stage 'get-acl-before'
        $acl = Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.SetAccessRuleProtection($false, $true)
        Trace-Stage 'unprotect-ready'
        Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'no-inherit' {
        Trace-Stage 'get-acl-before'
        $acl = Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $allow)))
        Trace-Stage 'no-inherit-rule-ready'
        Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'owner' {
        Trace-Stage 'get-acl-before'
        $acl = Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
        Trace-Stage 'foreign-owner-ready'
        Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'null-dacl' {
        Trace-Stage 'add-type-before'
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NativeNullDacl {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    public static extern uint SetNamedSecurityInfo(string name, uint type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
}
'@
        Trace-Stage 'add-type-after'
        Trace-Stage 'null-dacl-api-before'
        $code = [NativeNullDacl]::SetNamedSecurityInfo($Path, 1, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
        Trace-Stage 'null-dacl-api-after'
        if ($code -ne 0) { throw "SetNamedSecurityInfo failed: $code" }
    }
    'inspect' {
        Trace-Stage 'get-acl-before'
        $acl = Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        @{ user = $user.Value; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected;
            rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
                @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString(); inheritance = $_.InheritanceFlags.ToString() }
            }) } | ConvertTo-Json -Compress -Depth 4
        Trace-Stage 'inspect-json-after'
    }
    default { throw "Unknown fixture action" }
}
Trace-Stage 'exit'
