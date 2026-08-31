# ============================================================
# Open Windows Firewall port for LAN access (requires Admin)
# Run once: powershell -File setup-admin.ps1 [-Port 8080]
#
# Node.js 服务端不再需要 HttpListener 的 URL ACL 注册（任何端口
# 均可直接绑定，无需管理员）。局域网联机只需放行防火墙入站规则。
# ============================================================
param([int]$Port = 8080)
$netSh = "$env:SystemRoot\System32\netsh.exe"
$ruleName = "AierxiyaTrade-$Port"
Start-Process -FilePath $netSh -ArgumentList "advfirewall firewall add rule name=$ruleName dir=in action=allow protocol=TCP localport=$Port" -Verb RunAs -Wait
Write-Host "Firewall rule '$ruleName' added for port $Port (TCP)."
Write-Host "You can now run: node server\index.mjs -Lan"
