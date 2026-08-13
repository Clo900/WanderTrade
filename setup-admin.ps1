# ============================================================
# Register URL ACL for LAN access (requires Admin)
# Run once: powershell -File setup-admin.ps1
# ============================================================
param([int]$Port = 8080)
$netSh = "$env:SystemRoot\System32\netsh.exe"
Start-Process -FilePath $netSh -ArgumentList "http add urlacl url=http://+:$Port/ user=everyone" -Verb RunAs -Wait
Write-Host "URL ACL registered for port $Port. You can now run server.ps1."
