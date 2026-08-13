# ============================================================
# Aierxiya Trade - Internal Test HTTP Server v4
#   Server-runs-world: auto-creates world from default-world.json
#   Stocks: per-player, refilled every 30 REAL minutes together;
#           future: set stockMode=shared in world.json for shared pool
#   GM: /api/admin (timescale / setday / givegold / giveitem / broadcast)
# ============================================================
# Static files + API:
#   GET  /api/world              -> world snapshot
#   POST /api/world              -> fallback world creation by client
#   GET  /api/stocks?user=       -> player stocks (perPlayer) or world stocks (shared)
#   POST /api/trade              -> {user,city,item,qty,dir} stock ledger (per-player / shared)
#   POST /api/register           -> {user,pass}
#   POST /api/login              -> {user,pass}
#   GET  /api/player/{user}      -> saved game state
#   POST /api/save               -> {user,gs}
#   POST /api/chat               -> {user,loc,msg} broadcast (chat room)
#   GET  /api/chat?since=        -> new chat messages after id (recent 200 kept)
#
# Start:  powershell -File server.ps1
# LAN:    run setup-admin.ps1 as Administrator first, then:
#         powershell -File server.ps1 -Lan
# Stop:   Ctrl+C
# NOTE:   keep this file ASCII-only (Windows PowerShell 5.1 reads no-BOM
#         files as ANSI, which would garble non-ASCII comments)
# ============================================================
param([int]$Port = 8080, [switch]$Lan)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$playersDir = Join-Path $root 'players'
$worldFile = Join-Path $root 'world.json'
$defaultWorldFile = Join-Path $root 'default-world.json'
$chatFile = Join-Path $root 'chat.json'
if(!(Test-Path $playersDir)){ New-Item -ItemType Directory -Path $playersDir | Out-Null }
$script:chatStore = $null

# ---- Chat room store (chat.json: {nextId, msgs:[{id,user,loc,msg,ts}]}, keep latest 200) ----
function LoadChat{
  if($script:chatStore){ return $script:chatStore }
  $c = $null
  if(Test-Path $chatFile){ try{ $c = Get-Content -Raw $chatFile | ConvertFrom-Json }catch{} }
  if(!$c){ $c = [pscustomobject]@{ nextId=1; msgs=@() } }
  $script:chatStore = $c
  return $c
}
function SaveChat($c){ $c | ConvertTo-Json -Depth 20 -Compress | Set-Content -Path $chatFile -Encoding UTF8 }
function AddChat($user,$loc,$msg){
  $c = LoadChat
  $m = [pscustomobject]@{ id=[int]$c.nextId; user=$user; loc=$loc; msg=$msg; ts=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $c.nextId = [int]$c.nextId + 1
  $arr = @($c.msgs)
  $arr += $m
  if($arr.Count -gt 200){ $arr = @($arr | Select-Object -Last 200) }
  $c.msgs = $arr
  SaveChat $c
  return $m
}
function GetChatSince($sinceId){
  $c = LoadChat
  $since = 0; if($sinceId){ $since = [int]$sinceId }
  return @(@($c.msgs) | Where-Object { [int]$_.id -gt $since })
}

$mime = @{
  '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'
  '.js'='text/javascript; charset=utf-8'; '.md'='text/plain; charset=utf-8'
  '.png'='image/png'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
  '.json'='application/json; charset=utf-8'
}
$prefix = if($Lan){"http://+:$Port/"}else{"http://localhost:$Port/"}

function SendJson($obj){
  $json = $obj | ConvertTo-Json -Depth 30 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $response.ContentType = 'application/json; charset=utf-8'
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}
function ReadBody{
  $sr = New-Object System.IO.StreamReader($request.InputStream)
  $bodyText = $sr.ReadToEnd()
  if([string]::IsNullOrWhiteSpace($bodyText)){ return $null }
  try{ return ($bodyText | ConvertFrom-Json) }catch{ return $null }
}
function SaveWorld($w){ $w | ConvertTo-Json -Depth 30 -Compress | Set-Content -Path $worldFile -Encoding UTF8 }

# Server auto-runs world: create world.json from default-world.json (worldStart=now)
function LoadWorld{
  if(Test-Path $worldFile){
    try{
      $w = Get-Content -Raw $worldFile | ConvertFrom-Json
      # 迁移旧 world.json：补齐新字段
      $dirty = $false
      if(!$w.timeScale){ $w | Add-Member -MemberType NoteProperty -Name timeScale -Value 1 -Force; $dirty=$true }
      if(!$w.lastStockRefill){ $w | Add-Member -MemberType NoteProperty -Name lastStockRefill -Value 0 -Force; $dirty=$true }
      if(!$w.stockMode){ $w | Add-Member -MemberType NoteProperty -Name stockMode -Value 'perPlayer' -Force; $dirty=$true }
      if(!$w.adminPass){
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        $bb = New-Object byte[] 6
        $rng.GetBytes($bb)
        $w | Add-Member -MemberType NoteProperty -Name adminPass -Value (([System.BitConverter]::ToString($bb)).Replace('-','').ToLower()) -Force
        Write-Host ('  ADMIN PASS: ' + $w.adminPass) -ForegroundColor Magenta
        $dirty=$true
      }
      if($dirty){ SaveWorld $w }
      return $w
    }catch{}
  }
  if(Test-Path $defaultWorldFile){
    try{
      $d = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
      $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
      $b = New-Object byte[] 6
      $rng.GetBytes($b)
      $adminPass = ([System.BitConverter]::ToString($b)).Replace('-','').ToLower()
      $w = [pscustomobject]@{
        worldStart=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        basePrices=$d.basePrices
        purchaseLimits=$d.purchaseLimits
        stockMode='perPlayer'
        timeScale=1
        lastStockRefill=0
        adminPass=$adminPass
      }
      SaveWorld $w
      Write-Host ('  ADMIN PASS: ' + $adminPass) -ForegroundColor Magenta
      Write-Host '  (change it in world.json if needed)' -ForegroundColor DarkGray
      return $w
    }catch{ return $null }
  }
  return $null
}
# 1 game day = 10 min / timeScale (formal, GM-adjustable)
function GetWorldDay($w){ return [math]::Max(1, [math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$w.worldStart)/(600000/[math]::Max(0.1,[double]$w.timeScale))) + 1) }

# Refill every player's stocks every 30 real minutes (per-player, simultaneous); shared mode reserved
function RefillAllPlayers($w){
  if($w.stockMode -ne 'perPlayer'){ return }
  Get-ChildItem $playersDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    try{
      $rec = Get-Content -Raw $_.FullName | ConvertFrom-Json
      if($rec.gs -and $rec.gs.cityStocks){
        foreach($cityProp in $w.purchaseLimits.PSObject.Properties){
          $cn = $cityProp.Name
          if(!($rec.gs.cityStocks.PSObject.Properties.Name -contains $cn)){
            $rec.gs.cityStocks | Add-Member -MemberType NoteProperty -Name $cn -Value ([pscustomobject]@{}) -Force
          }
          foreach($itemProp in $cityProp.Value.PSObject.Properties){
            $in = $itemProp.Name
            if(!($rec.gs.cityStocks.$cn.PSObject.Properties.Name -contains $in)){
              $rec.gs.cityStocks.$cn | Add-Member -MemberType NoteProperty -Name $in -Value ([int]$itemProp.Value) -Force
            }
            $rec.gs.cityStocks.$cn.$in = [int]$itemProp.Value
          }
        }
        $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $_.FullName -Encoding UTF8
      }
    }catch{}
  }
}
function MaybeRefill($w){
  if(!$w){ return }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $last = 0
  if($w.lastStockRefill){ $last = [int64]$w.lastStockRefill }
  if($now - $last -lt 1800000){ return }   # 现实 30 分钟补货一次
  $w.lastStockRefill = $now
  if($w.stockMode -eq 'shared' -and $w.stocks){
    # reserved: refill shared world stock pool on game day
    foreach($cityProp in $w.purchaseLimits.PSObject.Properties){
      foreach($itemProp in $cityProp.Value.PSObject.Properties){
        $w.stocks.$($cityProp.Name).$($itemProp.Name) = [int]$itemProp.Value
      }
    }
  }else{
    RefillAllPlayers $w
  }
  SaveWorld $w
}
function HashPass($salt,$pass){
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $data = [System.Text.Encoding]::UTF8.GetBytes("$salt`:$pass")
  $h = $sha.ComputeHash($data)
  return ([System.BitConverter]::ToString($h)).Replace('-','').ToLower()
}
function NewSalt{
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $b = New-Object byte[] 16
  $rng.GetBytes($b)
  return ([System.BitConverter]::ToString($b)).Replace('-','').ToLower()
}
function EnsurePlayersDir{ if(!(Test-Path $playersDir)){ New-Item -ItemType Directory -Path $playersDir | Out-Null } }

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  Aierxiya Trade - World Server v4' -ForegroundColor Yellow
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "  Root:   $root"
Write-Host "  Port:   $Port"
$w0 = LoadWorld
if($w0){
  $cityCount = @($w0.basePrices.PSObject.Properties).Count
  Write-Host ("  World:  ready (stockMode=" + $w0.stockMode + ", cities=" + $cityCount + ")") -ForegroundColor Green
}else{
  Write-Host '  World:  NOT READY (default-world.json missing)' -ForegroundColor Red
}
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -notmatch '^127\.|^169\.254\.'} | Select-Object -ExpandProperty IPAddress)
if($Lan){
  foreach($ip in $ips){ Write-Host "  LAN:    http://${ip}:${Port}/" -ForegroundColor Green }
}else{
  Write-Host "  URL:    http://localhost:${Port}/" -ForegroundColor Green
  if($ips.Count -gt 0){
    Write-Host "  (LAN: run setup-admin.ps1 as Admin, then start with -Lan)" -ForegroundColor DarkGray
  }
}
Write-Host ''
Write-Host '  Press Ctrl+C to stop' -ForegroundColor DarkGray
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try{ $listener.Start() }catch{
  Write-Host "  ERROR: $_" -ForegroundColor Red
  Write-Host "  Try: run setup-admin.ps1 as Administrator first" -ForegroundColor Yellow
  exit 1
}

$running = $true
try{ [Console]::TreatControlCAsInput = $false }catch{}
try{ [Console]::CancelKeyPress += { $running = $false; Write-Host "`nShutting down..." -ForegroundColor Yellow } }catch{}

while($running){
  $ctx = $listener.BeginGetContext($null, $null)
  while($running -and !$ctx.IsCompleted){ Start-Sleep -Milliseconds 200 }
  if(!$running){ break }

  try{
    $context = $listener.EndGetContext($ctx)
    $request = $context.Request
    $response = $context.Response
    $path = $request.Url.AbsolutePath

    if($path.StartsWith('/api/')){
      $seg = $path.TrimStart('/').Split('/')
      $action = if($seg.Length -gt 1){$seg[1]}else{''}
      $method = $request.HttpMethod.ToUpper()

      if($action -eq 'world'){
        if($method -eq 'GET'){
          SendJson @{ok=$true; world=(LoadWorld)}
        }else{
          $b = ReadBody
          $w = LoadWorld
          if($w){ SendJson @{ok=$true; world=$w} }
          elseif($b -and $b.basePrices){
            $new = [pscustomobject]@{
              worldStart=[int64]$b.worldStart; basePrices=$b.basePrices
              purchaseLimits=$b.purchaseLimits; stockMode='perPlayer'; timeScale=1; lastStockRefill=0; adminPass=''
            }
            SaveWorld $new
            SendJson @{ok=$true; world=$new}
          }else{ SendJson @{ok=$false; err='bad world payload'} }
        }
      }
      elseif($action -eq 'stocks'){
        $w = LoadWorld
        if(!$w){ SendJson @{ok=$false; err='world not ready'} }
        else{
          MaybeRefill $w
          if($w.stockMode -eq 'shared'){
            SendJson @{ok=$true; mode='shared'; stocks=$w.stocks}
          }else{
            $user = $request.QueryString['user']
            if(!$user){ SendJson @{ok=$true; mode='perPlayer'; stocks=$null} }
            else{
              EnsurePlayersDir
              $pf = Join-Path $playersDir ($user + '.json')
              if(Test-Path $pf){
                $rec = Get-Content -Raw $pf | ConvertFrom-Json
                SendJson @{ok=$true; mode='perPlayer'; stocks=$rec.gs.cityStocks}
              }else{ SendJson @{ok=$false; err='user not found'} }
            }
          }
        }
      }
      elseif($action -eq 'trade' -and $method -eq 'POST'){
        $b = ReadBody
        $w = LoadWorld
        if(!$w){ SendJson @{ok=$false; err='world not ready'}; continue }
        MaybeRefill $w
        $user=$b.user; $city=$b.city; $item=$b.item; $qty=[int]$b.qty; $dir=$b.dir
        if($w.stockMode -eq 'shared'){
          if(!$w.stocks -or !$w.stocks.$city -or !$w.stocks.$city.$item){ SendJson @{ok=$false; err='unknown city/item'}; continue }
          $stock=[int]$w.stocks.$city.$item
          if($dir -eq 'buy'){
            if($stock -lt $qty){ SendJson @{ok=$false; err='stock shortage'} }
            else{ $w.stocks.$city.$item=$stock-$qty; SaveWorld $w; SendJson @{ok=$true; stock=([int]$w.stocks.$city.$item)} }
          }else{ $w.stocks.$city.$item=$stock+$qty; SaveWorld $w; SendJson @{ok=$true; stock=([int]$w.stocks.$city.$item)} }
        }else{
          EnsurePlayersDir
          $pf = Join-Path $playersDir ($user + '.json')
          if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          if(!$rec.gs -or !$rec.gs.cityStocks -or !$rec.gs.cityStocks.$city -or !$rec.gs.cityStocks.$city.$item){ SendJson @{ok=$false; err='unknown city/item'}; continue }
          $stock=[int]$rec.gs.cityStocks.$city.$item
          if($dir -eq 'buy'){
            if($stock -lt $qty){ SendJson @{ok=$false; err='stock shortage'} }
            else{ $rec.gs.cityStocks.$city.$item=$stock-$qty; $rec | ConvertTo-Json -Depth 30 | Set-Content $pf -Encoding UTF8; SendJson @{ok=$true; stock=([int]$rec.gs.cityStocks.$city.$item)} }
          }else{ $rec.gs.cityStocks.$city.$item=$stock+$qty; $rec | ConvertTo-Json -Depth 30 | Set-Content $pf -Encoding UTF8; SendJson @{ok=$true; stock=([int]$rec.gs.cityStocks.$city.$item)} }
        }
      }
      elseif($action -eq 'register' -and $method -eq 'POST'){
        $b = ReadBody
        $user=$b.user; $pass=$b.pass
        if(!$user -or $user.Length -lt 3 -or $user.Length -gt 12){ SendJson @{ok=$false; err='invalid username'}; continue }
        if(!$pass -or $pass.Length -lt 4){ SendJson @{ok=$false; err='password too short'}; continue }
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(Test-Path $pf){ SendJson @{ok=$false; err='username taken'} }
        else{
          $salt = NewSalt
          $rec = @{user=$user; salt=$salt; passHash=(HashPass $salt $pass); gs=$null}
          $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
          SendJson @{ok=$true}
        }
      }
      elseif($action -eq 'login' -and $method -eq 'POST'){
        $b = ReadBody
        $user=$b.user; $pass=$b.pass
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'} }
        else{
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          if($rec.passHash -eq (HashPass $rec.salt $pass)){ SendJson @{ok=$true} }
          else{ SendJson @{ok=$false; err='wrong password'} }
        }
      }
      elseif($action -eq 'player' -and $method -eq 'GET' -and $seg.Length -gt 2){
        $user = $seg[2]
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'} }
        else{
          $w = LoadWorld
          if($w){ MaybeRefill $w }
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          SendJson @{ok=$true; gs=$rec.gs}
        }
      }
      elseif($action -eq 'save' -and $method -eq 'POST'){
        $b = ReadBody
        $user=$b.user
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'} }
        else{
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          # 并发保护（v7.8）：比较存档时间戳，服务器有新存档（另一设备刚保存）则拒绝覆盖
          $serverSavedAt = 0
          if($rec.gs -and $rec.gs.__savedAt){ $serverSavedAt = [int64]$rec.gs.__savedAt }
          $clientSavedAt = 0
          if($b.clientSaveTime){ $clientSavedAt = [int64]$b.clientSaveTime }
          if($clientSavedAt -gt 0 -and $serverSavedAt -gt 0 -and $clientSavedAt -lt $serverSavedAt){
            SendJson @{ok=$false; conflict=$true}
          }
          else{
            $rec.gs = $b.gs
            # 存档时间戳以客户端提交时间为基准（同一设备的连续保存自然递增，避免时钟偏差误判）
            $now = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $stamp = if($clientSavedAt -gt 0){ $clientSavedAt } else { $now }
            if($rec.gs.__savedAt){ $rec.gs.__savedAt = $stamp }else{ $rec.gs | Add-Member -NotePropertyName __savedAt -NotePropertyValue $stamp -Force }
            $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
            SendJson @{ok=$true}
          }
        }
      }
      elseif($action -eq 'rankings'){
        $type = [string]$request.QueryString['type']
        if(!$type){ $type = 'gold' }
        $rows = @()
        Get-ChildItem $playersDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
          try{
            $rec = Get-Content -Raw $_.FullName | ConvertFrom-Json
            if(!$rec.gs){ return }
            $stats = $rec.gs.stats
            $distance = 0; $tasks = 0; $visits = 0; $rep = 0
            if($stats){
              $distance = [long]$stats.distance; $tasks = [int]$stats.tasks; $visits = [int]$stats.visits
            }
            if($rec.gs.reputation){ foreach($p in $rec.gs.reputation.PSObject.Properties){ $rep += [int]$p.Value.level } }
            $rows += [pscustomobject]@{user=$rec.user; gold=[long]$rec.gs.gold; day=[int]$rec.gs.day; distance=$distance; tasks=$tasks; visits=$visits; rep=$rep}
          }catch{}
        }
        $rows = @($rows | Sort-Object -Property $type -Descending | Select-Object -First 20)
        SendJson @{ok=$true; type=$type; rows=$rows}
      }
      elseif($action -eq 'chat' -and $method -eq 'POST'){
        $b = ReadBody
        $user = [string]$b.user
        $loc = [string]$b.loc
        $msg = [string]$b.msg
        if([string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrWhiteSpace($msg)){ SendJson @{ok=$false; err='bad chat payload'}; continue }
        if($msg.Length -gt 200){ $msg = $msg.Substring(0,200) }
        if($loc.Length -gt 30){ $loc = $loc.Substring(0,30) }
        $m = AddChat $user $loc $msg
        SendJson @{ok=$true; id=$m.id}
      }
      elseif($action -eq 'chat' -and $method -eq 'GET'){
        $since = $request.QueryString['since']
        $msgs = GetChatSince $since
        SendJson @{ok=$true; msgs=@($msgs)}
      }
      elseif($action -eq 'admin' -and $method -eq 'POST'){
        $b = ReadBody
        $w = LoadWorld
        if(!$w){ SendJson @{ok=$false; err='world not ready'}; continue }
        if(!$b.key -or $b.key -ne [string]$w.adminPass){ SendJson @{ok=$false; err='bad admin key'}; continue }
        $cmd = $b.cmd
        if($cmd -eq 'timescale'){
          $x = [double]$b.x
          if($x -lt 0.1 -or $x -gt 100){ SendJson @{ok=$false; err='timescale 0.1~100'}; continue }
          $w.timeScale = $x
          SaveWorld $w
          SendJson @{ok=$true; timeScale=$w.timeScale; msg='timeScale set to x'+$x}
        }
        elseif($cmd -eq 'setday'){
          $n = [math]::Max(1,[int]$b.n)
          $w.worldStart = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64](($n-1)*(600000/[math]::Max(0.1,[double]$w.timeScale)))
          SaveWorld $w
          SendJson @{ok=$true; day=(GetWorldDay $w); msg='world day set to '+$n}
        }
        elseif($cmd -eq 'givegold'){
          $user=$b.user; $amt=[long]$b.amt
          EnsurePlayersDir
          $pf = Join-Path $playersDir ($user + '.json')
          if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          if(!$rec.gs){ $rec.gs = [pscustomobject]@{gold=0; day=1; location='greentown'; vehicle=$null; cargo=@{}; buyPrice=@{}; cityStocks=$null; lastStockRefill=0; timeScale=1; warehouses=@{}; reputation=@{}; materials=@{gear=0;repair_kit=0;fuel_tank=0;engine=0}; tasks=@{board=@();active=@()}; traveling=$null; pendingEvent=$null; repairDisc=$null; intel=@{unlocked=@{};log=@()}; knownEvents=@{}; gameStartTime=$w.worldStart; justArrived=$false; tutorial=$null} }
          $old=[long]$rec.gs.gold
          $rec.gs.gold = [long]$rec.gs.gold + $amt
          $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
          SendJson @{ok=$true; gold=[long]$rec.gs.gold; msg=($user+' gold: '+$old+' -> '+$rec.gs.gold)}
        }
        elseif($cmd -eq 'giveitem'){
          $user=$b.user; $item=$b.item; $qty=[int]$b.qty
          EnsurePlayersDir
          $pf = Join-Path $playersDir ($user + '.json')
          if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          if(!$rec.gs){ SendJson @{ok=$false; err='player never saved'}; continue }
          if(!$rec.gs.cargo){ $rec.gs | Add-Member -MemberType NoteProperty -Name cargo -Value ([pscustomobject]@{}) -Force }
          if(!($rec.gs.cargo.PSObject.Properties.Name -contains $item)){ $rec.gs.cargo | Add-Member -MemberType NoteProperty -Name $item -Value ([int]$qty) -Force }
          else{ $rec.gs.cargo.$item = [int]$rec.gs.cargo.$item + $qty }
          $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
          SendJson @{ok=$true; item=$item; qty=[int]$rec.gs.cargo.$item; msg=($user+' got '+$qty+' x '+$item)}
        }
        elseif($cmd -eq 'broadcast'){
          $msg = [string]$b.msg
          $bc = [pscustomobject]@{ts=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); msg=$msg}
          if(!($w.PSObject.Properties.Name -contains 'lastBroadcast')){ $w | Add-Member -MemberType NoteProperty -Name lastBroadcast -Value $bc -Force }
          else{ $w.lastBroadcast = $bc }
          SaveWorld $w
          SendJson @{ok=$true; msg='broadcast sent'}
        }
        else{ SendJson @{ok=$false; err='unknown admin cmd'} }
      }
      else{ SendJson @{ok=$false; err='unknown api'} }
      continue
    }

    # ---- static file ----
    $url = $path
    if($url -eq '/' -or $url -eq ''){ $url = '/index.html' }
    $filePath = Join-Path $root ($url.TrimStart('/').Replace('/','\'))
    if(Test-Path $filePath -PathType Leaf){
      $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
      $ct = if($mime.ContainsKey($ext)){$mime[$ext]}else{'application/octet-stream'}
      $response.ContentType = $ct
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    }else{
      $response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('404 - Not Found')
      $response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $response.Close()
  }catch{
    try{ $response.Close() }catch{}
  }
}

$listener.Stop()
$listener.Close()
Write-Host 'Server stopped.' -ForegroundColor Cyan
