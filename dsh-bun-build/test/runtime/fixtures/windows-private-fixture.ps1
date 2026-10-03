param([Parameter(Mandatory=$true)][string]$Action, [Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [System.Security.AccessControl.PropagationFlags]::None
function PrivateDirectory([string]$name) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $inherit, $none, $allow)))
    [System.IO.Directory]::CreateDirectory($name, $acl) | Out-Null
}
switch ($Action) {
    'directory' { PrivateDirectory $Path }
    'file' {
        # Explicit owner at exclusive creation; DACL inherits from already-private parent.
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetOwner($user)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $allow)))
        $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::CreateNew, $full, [System.IO.FileShare]'ReadWrite, Delete', 4096, [System.IO.FileOptions]::None, $acl)
        $stream.Dispose()
    }
    'everyone' {
        $acl = Get-Acl -LiteralPath $Path
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), [System.Security.AccessControl.FileSystemRights]::Read, $allow)))
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    'inherit-everyone' {
        $acl = Get-Acl -LiteralPath $Path
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), [System.Security.AccessControl.FileSystemRights]::Read, $inherit, $none, $allow)))
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    'unprotect' {
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetAccessRuleProtection($false, $true)
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    'no-inherit' {
        $acl = Get-Acl -LiteralPath $Path
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $allow)))
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    'owner' {
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    'null-dacl' {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NativeNullDacl {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    public static extern uint SetNamedSecurityInfo(string name, uint type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
}
'@
        $code = [NativeNullDacl]::SetNamedSecurityInfo($Path, 1, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
        if ($code -ne 0) { throw "SetNamedSecurityInfo failed: $code" }
    }
    'inspect' {
        $acl = Get-Acl -LiteralPath $Path
        @{ user = $user.Value; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected;
            rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
                @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString(); inheritance = $_.InheritanceFlags.ToString() }
            }) } | ConvertTo-Json -Compress -Depth 4
    }
    default { throw "Unknown fixture action" }
}
