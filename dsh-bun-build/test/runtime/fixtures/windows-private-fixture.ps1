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
# Explicit A/B controls retain the original slow statement and isolate the same CLR constructor.
# They do not create objects on disk or count toward the 15-case native acceptance suite.
if ($Action -eq 'constructor-cmdlet' -or $Action -eq 'constructor-direct') {
    Trace-Stage 'constructor-control-before'
    if ($Action -eq 'constructor-cmdlet') {
        $control = New-Object System.Security.AccessControl.DirectorySecurity
    } else {
        $control = [System.Security.AccessControl.DirectorySecurity]::new()
    }
    Trace-Stage 'constructor-control-after'
    Trace-Stage 'exit'
    exit 0
}
# Load only trusted modules shipped beside this fixed Windows PowerShell executable.
# No host profile/user module discovery, execution-policy change or alternate runtime fallback.
foreach ($module in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    $manifest = "$PSHOME\Modules\$module\$module.psd1"
    Trace-Stage "module-import-before:$module"
    if (-not [System.IO.File]::Exists($manifest)) { throw "Required system PowerShell module missing: $module" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -ErrorAction Stop
    Trace-Stage "module-import-after:$module"
}
function PrivateDirectory([string]$name) {
    Trace-Stage 'directory-constructor-before'
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    Trace-Stage 'directory-constructor-after'
    $acl.SetOwner($user)
    Trace-Stage 'directory-owner-after'
    $acl.SetAccessRuleProtection($true, $false)
    Trace-Stage 'directory-protection-after'
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, $full, $inherit, $none, $allow)
    Trace-Stage 'directory-rule-constructor-after'
    $acl.AddAccessRule($rule)
    Trace-Stage 'directory-security-ready'
    $null = [System.IO.Directory]::CreateDirectory($name, $acl)
    Trace-Stage 'directory-created'
}
switch ($Action) {
    'constructor-loaded' {
        # C: explicit trusted imports, then the original cmdlet constructor and successor cmdlets.
        Trace-Stage 'loaded-new-object-before'
        $control = Microsoft.PowerShell.Utility\New-Object System.Security.AccessControl.DirectorySecurity
        Trace-Stage 'loaded-new-object-after'
        PrivateDirectory $Path
        Trace-Stage 'loaded-get-acl-before'
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'loaded-get-acl-after'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'loaded-set-acl-after'
        Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'public class NativeFixtureModuleControl { public static int Value() { return 1; } }'
        Trace-Stage 'loaded-add-type-after'
        @{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; user = $user.Value; protected = $acl.AreAccessRulesProtected } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
        Trace-Stage 'loaded-json-after'
    }
    'directory' { PrivateDirectory $Path }
    'file' {
        # Explicit owner at exclusive creation; DACL inherits from already-private parent.
        Trace-Stage 'file-constructor-before'
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        Trace-Stage 'file-constructor-after'
        $acl.SetOwner($user)
        Trace-Stage 'file-owner-after'
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, $full, $allow)
        Trace-Stage 'file-rule-constructor-after'
        $acl.AddAccessRule($rule)
        Trace-Stage 'file-security-ready'
        $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::CreateNew, $full, [System.IO.FileShare]'ReadWrite, Delete', 4096, [System.IO.FileOptions]::None, $acl)
        Trace-Stage 'file-created'
        $stream.Dispose()
        Trace-Stage 'file-closed'
    }
    'everyone' {
        Trace-Stage 'get-acl-before'
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::Read, $allow))
        Trace-Stage 'everyone-rule-ready'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'inherit-everyone' {
        Trace-Stage 'get-acl-before'
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::Read, $inherit, $none, $allow))
        Trace-Stage 'inherited-everyone-rule-ready'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'unprotect' {
        Trace-Stage 'get-acl-before'
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.SetAccessRuleProtection($false, $true)
        Trace-Stage 'unprotect-ready'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'no-inherit' {
        Trace-Stage 'get-acl-before'
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, $full, $allow))
        Trace-Stage 'no-inherit-rule-ready'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'owner' {
        Trace-Stage 'get-acl-before'
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        Trace-Stage 'foreign-owner-ready'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        Trace-Stage 'set-acl-after'
    }
    'null-dacl' {
        Trace-Stage 'add-type-before'
        Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
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
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        Trace-Stage 'get-acl-after'
        @{ user = $user.Value; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected;
            rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Microsoft.PowerShell.Core\ForEach-Object {
                @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString(); inheritance = $_.InheritanceFlags.ToString() }
            }) } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 4
        Trace-Stage 'inspect-json-after'
    }
    default { throw "Unknown fixture action" }
}
Trace-Stage 'exit'
