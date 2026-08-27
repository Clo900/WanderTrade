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
$clientRoot = Join-Path $root 'Online-Client'
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
$script:restoredStart = 0 # v8.26：world.json 解析失败时尽力恢复的 worldStart（世界时间轴不重置）
function LoadWorld{
  if(Test-Path $worldFile){
    try{
      $w = Get-Content -Raw $worldFile | ConvertFrom-Json
      # v9.7.1：世界配置版本检测——default-world.json 的 __schema 递增时自动重建世界配置。
      # 仅刷新 basePrices/purchaseLimits/各经济配置；保留世界时间轴与运行时字段（玩家 Day 不重置）。
      $dSchema = 0
      try{
        if(Test-Path $defaultWorldFile){
          $d0 = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
          if($d0.__schema){ $dSchema = [int]$d0.__schema }
        }
      }catch{ $dSchema = 0 }
      $wSchema = 0
      try{ if($w.__schema){ $wSchema = [int]$w.__schema } }catch{}
      if($dSchema -gt 0 -and $wSchema -lt $dSchema){
        try{
          $d0 = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
          $runtime = @{}
          foreach($rk in @('worldStart','stockMode','timeScale','lastStockRefill','lastRefillDay','lastBroadcast','adminPass')){
            if($null -ne $w.$rk){ $runtime[$rk] = $w.$rk }
          }
          $w = [pscustomobject]@{
            __schema = $dSchema
            tradeRoads = $(if($d0.tradeRoads){$d0.tradeRoads}else{@()})
            sourceConfig = $(if($d0.sourceConfig){$d0.sourceConfig}else{@{}})
            sellExceptions = $(if($d0.sellExceptions){$d0.sellExceptions}else{@{}})
            demandProfile = $(if($d0.demandProfile){$d0.demandProfile}else{@{}})
            basePrices = $d0.basePrices
            purchaseLimits = $d0.purchaseLimits
          }
          foreach($rk in $runtime.Keys){ $w | Add-Member -MemberType NoteProperty -Name $rk -Value $runtime[$rk] -Force }
          SaveWorld $w
          Write-Host ('  INFO: world config schema '+$wSchema+' -> '+$dSchema+' (auto-rebuilt, timeline preserved)') -ForegroundColor Cyan
          return $w
        }catch{
          Write-Host ('  WARN: schema rebuild failed, keep existing world (' + $_.Exception.Message + ')') -ForegroundColor Yellow
        }
      }
      # 迁移旧 world.json：补齐新字段
      $dirty = $false
      if(!$w.worldStart){
        $w | Add-Member -MemberType NoteProperty -Name worldStart -Value ([int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Force
        Write-Host '  WARN: world.json missing worldStart, set to now' -ForegroundColor Yellow
        $dirty=$true
      }
      if(!$w.timeScale){ $w | Add-Member -MemberType NoteProperty -Name timeScale -Value 1 -Force; $dirty=$true }
      if(!$w.lastStockRefill){ $w | Add-Member -MemberType NoteProperty -Name lastStockRefill -Value 0 -Force; $dirty=$true }
      if(!$w.stockMode){ $w | Add-Member -MemberType NoteProperty -Name stockMode -Value 'perPlayer' -Force; $dirty=$true }
      # vNext：经济距离（tradeRoads）与表现路网解耦。缺失时从 default-world.json 补齐。
      if(!$w.tradeRoads){
        try{
          if(Test-Path $defaultWorldFile){
            $d0 = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
            if($d0 -and $d0.tradeRoads){ $w | Add-Member -MemberType NoteProperty -Name tradeRoads -Value $d0.tradeRoads -Force; $dirty=$true }
          }
        }catch{}
        if(!$w.tradeRoads){
          # 最后兜底：保持字段存在，但为空（客户端可自行处理/提示）
          $w | Add-Member -MemberType NoteProperty -Name tradeRoads -Value @() -Force
          $dirty=$true
        }
      }
      # P1/P3：产地买入差异化与卖出封顶/封底。缺失时从 default-world.json 补齐，兜底为空对象。
      foreach($cfgName in @('sourceConfig','sellExceptions','demandProfile')){
        if(!$w.$cfgName){
          try{
            if(Test-Path $defaultWorldFile){
              $d0 = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
              if($d0 -and $d0.$cfgName){ $w | Add-Member -MemberType NoteProperty -Name $cfgName -Value $d0.$cfgName -Force; $dirty=$true }
            }
          }catch{}
          if(!$w.$cfgName){
            $w | Add-Member -MemberType NoteProperty -Name $cfgName -Value @{} -Force
            $dirty=$true
          }
        }
      }
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
    }catch{
      # v8.26：world.json 解析失败时备份损坏文件并尽力恢复 worldStart，避免静默重建导致世界时间轴重置
      try{
        $raw = Get-Content -Raw $worldFile
        if($raw -match '"worldStart"\s*:\s*(\d+)'){ $script:restoredStart = [int64]$Matches[1] }
        Copy-Item $worldFile ($worldFile + '.bak') -Force
        Write-Host ('  WARN: world.json parse failed, backed up to world.json.bak, restoring worldStart=' + $script:restoredStart) -ForegroundColor Yellow
      }catch{}
    }
  }
  if(Test-Path $defaultWorldFile){
    try{
      $d = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
      $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
      $b = New-Object byte[] 6
      $rng.GetBytes($b)
      $adminPass = ([System.BitConverter]::ToString($b)).Replace('-','').ToLower()
      $w = [pscustomobject]@{
        worldStart=$(if($script:restoredStart -gt 0){$script:restoredStart}else{[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()})
        tradeRoads=$(if($d.tradeRoads){$d.tradeRoads}else{@()})
        sourceConfig=$(if($d.sourceConfig){$d.sourceConfig}else{@{} })
        sellExceptions=$(if($d.sellExceptions){$d.sellExceptions}else{@{} })
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
      if($script:restoredStart -gt 0){
        Write-Host ('  INFO: world timeline restored to worldStart=' + $script:restoredStart) -ForegroundColor Green
      }else{
        Write-Host '  WARN: world.json missing/corrupt -> new world created, TIMELINE RESET to now (all players Day=1)' -ForegroundColor Red
        Write-Host '  HINT: to restore, run GM cmd: /gm <adminPass> setday <correct day>' -ForegroundColor Yellow
      }
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
Write-Host "  Client: $clientRoot"
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
          # v9.4：返回服务器当前时间戳（serverNow），客户端据此校准任务时限，防本地改钟作弊
          SendJson @{ok=$true; world=(LoadWorld); serverNow=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
        }else{
          $b = ReadBody
          $w = LoadWorld
          if($w){ SendJson @{ok=$true; world=$w; serverNow=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} }
          elseif($b -and $b.basePrices){
            $new = [pscustomobject]@{
              worldStart=[int64]$b.worldStart; basePrices=$b.basePrices
              purchaseLimits=$b.purchaseLimits; tradeRoads=$b.tradeRoads; stockMode='perPlayer'; timeScale=1; lastStockRefill=0; adminPass=''
              sourceConfig=$(if($b.sourceConfig){$b.sourceConfig}else{@{} }); sellExceptions=$(if($b.sellExceptions){$b.sellExceptions}else{@{} }); demandProfile=$(if($b.demandProfile){$b.demandProfile}else{@{} })
            }
            SaveWorld $new
            SendJson @{ok=$true; world=$new; serverNow=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
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
      elseif($action -eq 'tradeBatch' -and $method -eq 'POST'){
        $b = ReadBody
        $w = LoadWorld
        if(!$w){ SendJson @{ok=$false; err='world not ready'}; continue }
        MaybeRefill $w
        $user=[string]$b.user; $city=[string]$b.city; $dir=[string]$b.dir
        $items=$b.items
        if(!$city -or !$dir -or !$items){ SendJson @{ok=$false; err='bad tradeBatch payload'}; continue }
        if($dir -ne 'buy' -and $dir -ne 'sell'){ SendJson @{ok=$false; err='bad dir'}; continue }

        if($w.stockMode -eq 'shared'){
          if(!$w.stocks -or !$w.stocks.$city){ SendJson @{ok=$false; err='unknown city'}; continue }
          # 先全量校验 buy
          if($dir -eq 'buy'){
            foreach($it in $items){
              $iid=[string]$it.item; $q=[int]$it.qty
              if(!$iid -or $q -le 0){ SendJson @{ok=$false; err='bad item'}; continue 2 }
              if(!$w.stocks.$city.$iid){ SendJson @{ok=$false; err='unknown city/item'}; continue 2 }
              $stock=[int]$w.stocks.$city.$iid
              if($stock -lt $q){ SendJson @{ok=$false; err='stock shortage'; item=$iid; stock=$stock}; continue 2 }
            }
          }
          # 再一次性应用
          foreach($it in $items){
            $iid=[string]$it.item; $q=[int]$it.qty
            if(!$iid -or $q -le 0){ continue }
            $stock=[int]$w.stocks.$city.$iid
            if($dir -eq 'buy'){ $w.stocks.$city.$iid = $stock - $q } else { $w.stocks.$city.$iid = $stock + $q }
          }
          SaveWorld $w
          SendJson @{ok=$true; stocks=$w.stocks.$city}
        }else{
          EnsurePlayersDir
          $pf = Join-Path $playersDir ($user + '.json')
          if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
          $rec = Get-Content -Raw $pf | ConvertFrom-Json
          if(!$rec.gs){
            # 新注册未建立存档时：补一个最小可用 gs（以 purchaseLimits 初始化 cityStocks）
            $rec.gs = [pscustomobject]@{
              gold=10000; day=1; location='greentown'; vehicle=$null; cargo=@{}; buyPrice=@{}; lots=@{}; visitStamp=@{}
              cityStocks=[pscustomobject]@{}; lastStockRefill=0; timeScale=1; warehouses=@{}; reputation=@{}
              materials=@{gear=0;repair_kit=0;fuel_tank=0;engine=0}; tasks=@{board=@();active=@()}; traveling=$null; pendingEvent=$null; repairDisc=$null
              intel=@{unlocked=@{};log=@()}; knownEvents=@{}; gameStartTime=$w.worldStart; justArrived=$false; tutorial=$null
              stats=@{bought=0;sold=0;tasks=0;travels=0;distance=0;visits=1;income=0;upgrades=0;reps=0}; achievements=@{}; visitedCities=@('greentown')
              __savedAt=0; __loaded=$true
            }
            foreach($cityProp in $w.purchaseLimits.PSObject.Properties){
              $cn = $cityProp.Name
              $rec.gs.cityStocks | Add-Member -MemberType NoteProperty -Name $cn -Value ([pscustomobject]@{}) -Force
              foreach($itemProp in $cityProp.Value.PSObject.Properties){
                $rec.gs.cityStocks.$cn | Add-Member -MemberType NoteProperty -Name $itemProp.Name -Value ([int]$itemProp.Value) -Force
              }
            }
          }
          if(!$rec.gs.cityStocks -or !$rec.gs.cityStocks.$city){ SendJson @{ok=$false; err='unknown city'}; continue }
          # v9.7.3(C1)：服务端资金/持仓权威结算——客户端提交 total(buy 应付含税)/net(sell 税后到手)，
          # 服务端校验资源守恒 + 价格范围，记账后返回权威 gold/cargo/stocks 供客户端覆盖（防透支/凭空卖出/极端改价）。
          if($rec.gs.gold -eq $null){ $rec.gs | Add-Member -MemberType NoteProperty -Name gold -Value ([long]10000) -Force }
          if($rec.gs.cargo -eq $null){ $rec.gs | Add-Member -MemberType NoteProperty -Name cargo -Value ([pscustomobject]@{}) -Force }
          $total = [double]$b.total; $net = [double]$b.net
          $amount = if($dir -eq 'buy'){ $total } else { $net }
          if($amount -le 0){ SendJson @{ok=$false; err='bad amount'}; continue }
          # 价格范围校验：amount 与 Σ(basePrices×qty) 比率须在 [0.3,3]，防"1 金买入"式极端改价
          $expected = 0.0
          foreach($it in $items){
            $iid=[string]$it.item; $q=[int]$it.qty
            $bp = $w.basePrices.$city.$iid
            $expected += ([double]($(if($null -ne $bp){$bp}else{100})) * $q)
          }
          if($expected -gt 0){
            $ratio = $amount / $expected
            if($ratio -lt 0.3 -or $ratio -gt 3.0){ SendJson @{ok=$false; err='price mismatch'}; continue }
          }
          # 全量校验（buy=库存+资金；sell=持仓）
          if($dir -eq 'buy'){
            if([double]$rec.gs.gold -lt $total){ SendJson @{ok=$false; err='gold insufficient'; need=[long]$total; gold=[long]$rec.gs.gold}; continue }
            foreach($it in $items){
              $iid=[string]$it.item; $q=[int]$it.qty
              if(!$iid -or $q -le 0){ SendJson @{ok=$false; err='bad item'}; continue 2 }
              if(!($rec.gs.cityStocks.$city.PSObject.Properties.Name -contains $iid)){ SendJson @{ok=$false; err='unknown city/item'}; continue 2 }
              $stock=[int]$rec.gs.cityStocks.$city.$iid
              if($stock -lt $q){ SendJson @{ok=$false; err='stock shortage'; item=$iid; stock=$stock}; continue 2 }
            }
          }else{
            foreach($it in $items){
              $iid=[string]$it.item; $q=[int]$it.qty
              if(!$iid -or $q -le 0){ SendJson @{ok=$false; err='bad item'}; continue 2 }
              $held=[int]$rec.gs.cargo.$iid
              if($held -lt $q){ SendJson @{ok=$false; err='cargo shortage'; item=$iid; held=$held}; continue 2 }
            }
          }
          # 一次性应用（gold / cargo / stocks）
          if($dir -eq 'buy'){ $rec.gs.gold = [long]([double]$rec.gs.gold - $total) }
          else{ $rec.gs.gold = [long]([double]$rec.gs.gold + $net) }
          foreach($it in $items){
            $iid=[string]$it.item; $q=[int]$it.qty
            if(!$iid -or $q -le 0){ continue }
            if($dir -eq 'buy'){
              $rec.gs.cityStocks.$city.$iid = ([int]$rec.gs.cityStocks.$city.$iid) - $q
              $have=[int]$rec.gs.cargo.$iid
              if($have -le 0 -and !($rec.gs.cargo.PSObject.Properties.Name -contains $iid)){ $rec.gs.cargo | Add-Member -MemberType NoteProperty -Name $iid -Value ([int]$q) -Force }
              else{ $rec.gs.cargo.$iid = $have + $q }
            }else{
              $rec.gs.cityStocks.$city.$iid = ([int]$rec.gs.cityStocks.$city.$iid) + $q
              $left=([int]$rec.gs.cargo.$iid) - $q
              if($left -le 0){ $rec.gs.cargo.PSObject.Properties.Remove($iid) }
              else{ $rec.gs.cargo.$iid = $left }
            }
          }
          # 更新服务器版本戳，避免客户端自动保存覆盖本次库存变更
          $now = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          if($rec.gs.__savedAt){ $rec.gs.__savedAt = $now }else{ $rec.gs | Add-Member -NotePropertyName __savedAt -NotePropertyValue $now -Force }
          $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
          SendJson @{ok=$true; gold=[long]$rec.gs.gold; cargo=$rec.gs.cargo; stocks=$rec.gs.cityStocks.$city; serverAt=$now}
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
        # v8.28：Url.AbsolutePath 返回转义路径（中文用户名如 %E4%B9%9D...），必须解码才能匹配 players/ 下的中文文件名
        $user = [System.Uri]::UnescapeDataString($seg[2])
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
          # 并发保护（v7.8 → v8.25 版本号机制）：比较"客户端已知的服务器存档版本(lastServerAt)"与当前服务器版本。
          # 旧机制比较客户端时间戳，跨设备/时钟偏差会误判或漏判导致存档被覆盖。
          $serverSavedAt = 0
          if($rec.gs -and $rec.gs.__savedAt){ $serverSavedAt = [int64]$rec.gs.__savedAt }
          $clientLast = 0
          if($b.lastServerAt){ $clientLast = [int64]$b.lastServerAt }
          $clientSavedAt = 0
          if($b.clientSaveTime){ $clientSavedAt = [int64]$b.clientSaveTime }
          if($clientLast -gt 0 -and $serverSavedAt -gt 0 -and $clientLast -lt $serverSavedAt){
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
    $filePath = Join-Path $clientRoot ($url.TrimStart('/').Replace('/','\'))
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
