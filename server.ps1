# ============================================================
# Aierxiya Trade - Internal Test HTTP Server v4
#   Server-runs-world: auto-creates world from default-world.json
#   Stocks: per-player, refilled every 30 REAL minutes together;
#           future: set stockMode=shared in world.json for shared pool
#   GM: /api/admin (timescale / setday / givegold / giveitem / broadcast
#                   / starfall start|end|next|status / mail) [v9.10]
#   Starfall ops log: console + starfall_log.txt (Write-SfLog)  [v9.10]
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
#   GET  /api/starfall/activity?user= -> starfall activity snapshot      [v9.9]
#   POST /api/starfall/contribute     -> {user,items:[{item,qty}]}       [v9.9]
#   GET  /api/mail?user=         -> player mailbox                       [v9.9]
#   POST /api/mail/{read|readAll|delete|deleteRead|claim} -> mailbox ops [v9.9]
#
# Start:  powershell -File server.ps1
# LAN:    run setup-admin.ps1 as Administrator first, then:
#         powershell -File server.ps1 -Lan
# Bind:   powershell -File server.ps1 -Bind 127.0.0.1  (custom listen host)
# Stop:   Ctrl+C
# NOTE:   keep this file ASCII-only (Windows PowerShell 5.1 reads no-BOM
#         files as ANSI, which would garble non-ASCII comments)
# ============================================================
param([int]$Port = 8080, [switch]$Lan, [string]$Bind = 'localhost')

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientRoot = Join-Path $root 'Online-Client'
$playersDir = Join-Path $root 'players'
$worldFile = Join-Path $root 'world.json'
$defaultWorldFile = Join-Path $root 'default-world.json'
$chatFile = Join-Path $root 'chat.json'
$sfFile = Join-Path $root 'starfall_activity.json'   # v9.9: starfall city activity state
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
# v9.10.3：聊天发送者档案——昵称（缺省回退用户名）+ 当前装备称号（可能为 null）
function Get-ChatSender($user){
  $pf = Join-Path $playersDir ($user + '.json')
  $nick = $user; $title = $null
  if(Test-Path $pf){
    try{
      $rec = Get-Content -Raw $pf | ConvertFrom-Json
      if($rec.nickname){ $nick = [string]$rec.nickname }
      if($rec.gs -and $rec.gs.titles -and $rec.gs.titles.equipped){ $title = [string]$rec.gs.titles.equipped }
    }catch{}
  }
  return @($nick, $title)
}
function AddChat($user,$loc,$msg){
  $c = LoadChat
  $sender = Get-ChatSender $user
  $m = [pscustomobject]@{ id=[int]$c.nextId; user=$user; nickname=$sender[0]; title=$sender[1]; loc=$loc; msg=$msg; ts=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
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

# ============================================================
# Starfall city activity (v9.9) + Mailbox (v9.9) server logic
#   activity state: starfall_activity.json（惰性轮转，复刻客户端 rotateLocal）
#   时间基准：固定 UTC+8 2026-01-01 08:00（与客户端 Date.UTC 对齐，避免本地时区差异）
#   确定性抽选：mulberry32(period*1000003+7)，物资池来自 default-world.json itemCategories
# ============================================================
$script:SfGoal = [int64]200000
$script:SfRunMs = [int64]86400000     # 建设期默认 24h（可由 world.json starfallConfig 覆盖，v9.10.2）
$script:SfInterMs = [int64]172800000  # 间隙期默认 48h
$script:SfCycleMs = $script:SfRunMs + $script:SfInterMs  # 周期 = 建设期 + 间隙期（自动推导）
# v9.10.2：周期参数化——从 world.json starfallConfig{runHours,interHours} 读取并刷新脚本变量；
#   已在 LoadWorld 兜底默认值；GM 可用 /api/admin starfall cycle <runH> <interH> 热改（下一阶段切换生效）
function Refresh-SfConfig($w){
  try{
    if($w -and $w.starfallConfig){
      $r = [double]$w.starfallConfig.runHours
      $i = [double]$w.starfallConfig.interHours
      if($r -ge 1 -and $r -le 168 -and $i -ge 1 -and $i -le 168){
        $script:SfRunMs = [int64]($r * 3600000.0)
        $script:SfInterMs = [int64]($i * 3600000.0)
        $script:SfCycleMs = $script:SfRunMs + $script:SfInterMs
      }
    }
  }catch{
    Write-Host ('  WARN: Refresh-SfConfig failed: ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}
$script:SfCap = 50                    # 邮箱容量
$script:SfTiers = @(
  @{ max=[int64]1;    gold=[int64]100000; alloy=[int64]10 },
  @{ max=[int64]2;    gold=[int64]60000;  alloy=[int64]7 },
  @{ max=[int64]3;    gold=[int64]40000;  alloy=[int64]5 },
  @{ max=[int64]15;   gold=[int64]20000;  alloy=[int64]3 },
  @{ max=[int64]50;   gold=[int64]10000;  alloy=[int64]2 },
  @{ max=[int64]100;  gold=[int64]5000;   alloy=[int64]1 },
  @{ max=[int64]9223372036854775807; gold=[int64]1000; alloy=[int64]1 }
)
$script:sfCats = $null
# 星陨城运维日志（内测/运营排障；控制台输出 + 追加写入 starfall_log.txt）
$script:SfLogFile = Join-Path $root 'starfall_log.txt'
function Write-SfLog([string]$msg){
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Write-Host $line
  try{ Add-Content -Path $script:SfLogFile -Value $line -Encoding UTF8 }catch{}
}

function Get-UtcNowMs{ return [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Get-SfEpoch{ return [DateTimeOffset]::new(2026,1,1,0,0,0,[TimeSpan]::FromHours(8)).ToUnixTimeMilliseconds() }

# mulberry32 复刻（与客户端 starfall.js rng 逐位一致）
#   PS 5.1 的 0xFFFFFFFF 字面量按 Int32 溢出回绕为 -1，-band 无法截断，统一改用 % 2^32
function Invoke-SfImul([uint32]$x,[uint32]$y){
  $prod = [decimal]$x * [decimal]$y
  return [uint32]($prod % 4294967296)
}
function Get-SfRand{
  param([ref]$s)
  $a = [uint32]$s.Value
  $a = [uint32](([uint64]$a + 0x6D2B79F5) % 4294967296)
  $t1 = Invoke-SfImul ($a -bxor ($a -shr 15)) ([uint32](1 -bor $a))
  $t2 = [uint32](([uint64]$t1 + [uint64](Invoke-SfImul ($t1 -bxor ($t1 -shr 7)) ([uint32](61 -bor $t1)))) % 4294967296) -bxor $t1
  $s.Value = $a
  return ([double]([uint32]($t2 -bxor ($t2 -shr 14)))) / 4294967296.0
}

# 物资分类池：default-world.json itemCategories（与客户端 data.js ITEMS 同步导出，ordinal 排序复刻 JS sort()）
function Get-SfItemCategories{
  if($script:sfCats){ return $script:sfCats }
  $specials = @(); $basics = @()
  try{
    if(Test-Path $defaultWorldFile){
      $d = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json
      if($d.itemCategories){
        $specials = @($d.itemCategories.special)
        $basics = @($d.itemCategories.basic)
      }
    }
  }catch{}
  if(!$specials.Count -or !$basics.Count){ throw 'itemCategories missing in default-world.json' }
  [Array]::Sort($specials, [System.StringComparer]::Ordinal)
  [Array]::Sort($basics, [System.StringComparer]::Ordinal)
  $script:sfCats = [pscustomobject]@{ special=$specials; basic=$basics }
  return $script:sfCats
}
# 确定性抽选：每期 1 特产 + 3 普通（与客户端 pickGoods 一致：1 次随机取特产 + 不放回抽 3 普通）
function Get-SfPickGoods([int64]$period){
  $cats = Get-SfItemCategories
  $s = [uint32](($period * 1000003 + 7) % 4294967296)
  $r = Get-SfRand ([ref]$s)
  $sp = $cats.special[[int][math]::Floor($r * $cats.special.Count)]
  $pool = New-Object System.Collections.Generic.List[string]
  foreach($b in $cats.basic){ $pool.Add([string]$b) }
  $normals = @()
  while($normals.Count -lt 3 -and $pool.Count -gt 0){
    $rv = Get-SfRand ([ref]$s)
    $idx = [int][math]::Floor($rv * $pool.Count)
    $normals += $pool[$idx]
    $pool.RemoveAt($idx)
  }
  return [pscustomobject]@{ special=$sp; normal=@($normals) }
}

# ---- 活动状态机 ----
function New-SfActivity{
  $now = Get-UtcNowMs
  $ep = Get-SfEpoch
  $p = [int64]([math]::Floor(($now - $ep) / [double]$script:SfCycleMs) + 1)
  $pStart = $ep + ($p - 1) * $script:SfCycleMs
  $running = $now -lt ($pStart + $script:SfRunMs)
  return [pscustomobject]@{
    period = $p
    phase = $(if($running){'running'}else{'intermission'})
    phaseStartedAt = [int64]$(if($running){$pStart}else{$pStart + $script:SfRunMs})
    phaseEndsAt = [int64]$(if($running){$pStart + $script:SfRunMs}else{$pStart + $script:SfCycleMs})
    target = $script:SfGoal
    required = (Get-SfPickGoods $p)
    totalProgress = [int64]0
    scores = [pscustomobject]@{}
    firstOrder = [pscustomobject]@{}
    settled = $false
    history = @()
  }
}
function LoadStarfall{
  $act = $null
  if(Test-Path $sfFile){ try{ $act = Get-Content -Raw $sfFile | ConvertFrom-Json }catch{ $act = $null } }
  if(!$act){ $act = New-SfActivity; SaveStarfall $act }
  return $act
}
function SaveStarfall($act){ $act | ConvertTo-Json -Depth 30 -Compress | Set-Content -Path $sfFile -Encoding UTF8 }
# 全服公告：写入 world.json lastBroadcast（客户端在线轮询后以跑马灯横幅展示）
function PublishBroadcast($w,[string]$msg){
  $bc = [pscustomobject]@{ ts=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); msg=$msg }
  if(!($w.PSObject.Properties.Name -contains 'lastBroadcast')){ $w | Add-Member -MemberType NoteProperty -Name lastBroadcast -Value $bc -Force }
  else{ $w.lastBroadcast = $bc }
  SaveWorld $w
}

function Get-SfTier([int64]$rank){
  foreach($t in $script:SfTiers){ if($rank -le [int64]$t.max){ return $t } }
  return $script:SfTiers[-1]
}
# 将 required.normal 转成逗号分隔字符串（空集合在 PS5.1 下 @() 展开会报错，做兜底）
function Get-SfNormalStr($req){
  try{
    $a = @($req.normal)
    if($a.Count -eq 0){ return '' }
    return (@($a | ForEach-Object { [string]$_ }) -join ',')
  }catch{ return '' }
}
# 结算：排名（贡献降序，同分按 firstOrder 时间升序）→ 进度折算向下取整 → 逐玩家投递奖励邮件 → 归档冠军（保留 7 期）
function Invoke-SettleStarfall($act){
  if($act.settled){ return }
  $act.settled = $true
  $arr = @()
  if($act.scores){
    foreach($u in $act.scores.PSObject.Properties){
      $ts = [int64]0
      if($act.firstOrder){
        try{ $v = $act.firstOrder.$($u.Name); if($null -ne $v){ $ts = [int64]$v } }catch{}
      }
      $arr += [pscustomobject]@{ user=[string]$u.Name; score=[int64]$u.Value; ts=$ts }
    }
  }
  $arr = @($arr | Sort-Object @{Expression={[int64]$_.score};Descending=$true}, @{Expression={[int64]$_.ts};Ascending=$true})
  $ratio = [math]::Min(1.0, [double]$act.totalProgress / [double]$script:SfGoal)
  $pct = [int64][math]::Floor($ratio * 100)
  Write-SfLog ('[Settle] 第 ' + [int64]$act.period + ' 期结算开始：参与 ' + $arr.Count + ' 人，建设度 ' + $pct + '%（' + [int64]$act.totalProgress + '/' + [int64]$script:SfGoal + '）')
  for($i=0;$i -lt $arr.Count;$i++){
    $t = Get-SfTier ($i+1)
    $gold = [int64][math]::Floor([double]$t.gold * $ratio)
    $alloy = [int64][math]::Floor([double]$t.alloy * $ratio)
    $mats = [pscustomobject]@{}
    if($alloy -gt 0){ $mats | Add-Member -MemberType NoteProperty -Name staralloy -Value $alloy -Force }
    $body = ('本期建设圆满结束，感谢你对星陨城的贡献。' + [char]10 +
      '你的排名：第 ' + ($i+1) + ' 名 · 累计贡献 ' + [int64]$arr[$i].score +
      ' · 全服建设度 ' + $pct + '%')
    if($ratio -lt 1.0){ $body += '（未达标，奖励按比例折算）' }
    # v9.10.3：按排名档位发放活动称号（客户端 titles.js 渲染，邮箱领取时入称号栏）
    $rank = ($i+1)
    $titleId = 'sf_participant'
    if($rank -eq 1){ $titleId = 'sf_champion' }
    elseif($rank -le 3){ $titleId = 'sf_top3' }
    elseif($rank -le 10){ $titleId = 'sf_top10' }
    try{
      DeliverMail $arr[$i].user ([pscustomobject]@{
        title = '星陨城第 ' + [int64]$act.period + ' 期建设奖励'
        from = '边境城建指挥部'
        body = $body
        attachments = [pscustomobject]@{ gold=$gold; mats=$mats; title=$titleId }
      })
    }catch{
      # 单玩家投递失败不中断整体结算（如该玩家档损坏/不存在）
      Write-SfLog ('[Settle] ⚠ 第 ' + [int64]$act.period + ' 期奖励投递失败 user=' + [string]$arr[$i].user + ' rank=' + ($i+1) + ' err=' + $_.Exception.Message)
    }
  }
  $hist = @($act.history)
  $first = if($arr.Count){ [string]$arr[0].user } else { $null }
  $newH = [pscustomobject]@{ period=[int64]$act.period; first=$first; progress=[int64]$act.totalProgress; target=$script:SfGoal }
  $hist = @($newH) + @($hist)
  if($hist.Count -gt 7){ $hist = @($hist | Select-Object -First 7) }
  $act.history = $hist
  Write-SfLog ('[Settle] 第 ' + [int64]$act.period + ' 期结算完成：冠军=' + $(if($first){$first}else{'(无人上榜)'}) + '，奖励邮件 ' + $arr.Count + ' 封')
}
# 惰性轮转：running 到期先结算再进间隙期；间隙期到期开新一期（重新抽选）
function Invoke-MaybeSfRotate($act){
  if(!$act){ return $false }
  $now = Get-UtcNowMs
  $changed = $false
  while($now -ge [int64]$act.phaseEndsAt){
    if($act.phase -eq 'running'){
      Invoke-SettleStarfall $act
      $act.phase = 'intermission'
      $act.phaseStartedAt = [int64]$act.phaseEndsAt
      $act.phaseEndsAt = [int64]$act.phaseEndsAt + $script:SfInterMs
      Write-SfLog ('[Rotate] 第 ' + [int64]$act.period + ' 期建设到期，自动进入间隙期')
    }else{
      $act.period = [int64]$act.period + 1
      $act.required = Get-SfPickGoods $act.period
      $act.totalProgress = [int64]0
      $act.scores = [pscustomobject]@{}
      $act.firstOrder = [pscustomobject]@{}
      $act.settled = $false
      $act.phase = 'running'
      $act.phaseStartedAt = [int64]$act.phaseEndsAt
      $act.phaseEndsAt = [int64]$act.phaseEndsAt + $script:SfRunMs
      Write-SfLog ('[Rotate] 第 ' + [int64]$act.period + ' 期建设自动开始：special=' + [string]$act.required.special + ' normal=' + (Get-SfNormalStr $act.required))
    }
    $changed = $true
    try{ SaveStarfall $act }catch{ Write-SfLog ('[Rotate] ⚠ SaveStarfall 失败：' + $_.Exception.Message) }
  }
  return $changed
}
# 排行榜快照：top10 不含请求者（避免客户端 rankHtml 重复渲染"我"），myRank/myScore 随行返回
function Get-SfSnapshot($act,[string]$user){
  $arr = @()
  if($act.scores){
    foreach($u in $act.scores.PSObject.Properties){
      $ts = [int64]0
      if($act.firstOrder){
        try{ $v = $act.firstOrder.$($u.Name); if($null -ne $v){ $ts = [int64]$v } }catch{}
      }
      $arr += [pscustomobject]@{ user=[string]$u.Name; score=[int64]$u.Value; ts=$ts }
    }
  }
  $arr = @($arr | Sort-Object @{Expression={[int64]$_.score};Descending=$true}, @{Expression={[int64]$_.ts};Ascending=$true})
  $myRank = [int]0; $myScore = [int64]0
  for($i=0;$i -lt $arr.Count;$i++){ if([string]$arr[$i].user -eq $user){ $myRank = $i+1; $myScore = [int64]$arr[$i].score } }
  $top10 = New-Object System.Collections.ArrayList
  foreach($r in $arr){
    if($top10.Count -ge 10){ break }
    if([string]$r.user -eq $user){ continue }
    [void]$top10.Add([pscustomobject]@{ user=$r.user; score=[int64]$r.score })
  }
  return [pscustomobject]@{ rows=@($top10); myRank=$myRank; myScore=$myScore }
}

# ---- Mailbox（在线投递/操作在服务端完成；客户端上传剔除 mailbox，投递无需 bump __savedAt） ----
function Test-MailHasAtt($m){
  if(!$m -or !$m.attachments){ return $false }
  $a = $m.attachments
  try{ if([int64]$a.gold -gt 0){ return $true } }catch{}
  if($a.mats){
    foreach($p in $a.mats.PSObject.Properties){
      try{ if([int64]$p.Value -gt 0){ return $true } }catch{}
    }
  }
  if($a.title -and [string]$a.title){ return $true } # v9.10.3：称号附件（titleId）
  return $false
}
function Test-MailUnclaimed($m){ return (Test-MailHasAtt $m) -and !$m.claimed }
# 满仓清理：① 最旧「已读且（已领取或无附件）」 ② 最旧已读 ③ 最旧未读（与客户端 makeRoom 一致）
function Invoke-MailMakeRoom($box){
  for($i=0;$i -lt $box.Count;$i++){ if($box[$i].read -and !(Test-MailUnclaimed $box[$i])){ return $i } }
  for($i=0;$i -lt $box.Count;$i++){ if($box[$i].read){ return $i } }
  return 0
}
function DeliverMail($user,$mail){
  EnsurePlayersDir
  $pf = Join-Path $playersDir ($user + '.json')
  $rec = $null
  if(Test-Path $pf){ try{ $rec = Get-Content -Raw $pf | ConvertFrom-Json }catch{} }
  if(!$rec){ $rec = [pscustomobject]@{ user=$user; salt=''; passHash=''; gs=$null } }
  if(!$rec.gs){
    $rec.gs = [pscustomobject]@{
      gold=[int64]0; day=1; location='greentown'; vehicle=$null; cargo=@{}; buyPrice=@{}; lots=@{}; visitStamp=@{}
      cityStocks=$null; lastStockRefill=0; timeScale=1; warehouses=@{}; reputation=@{}
      materials=@{gear=0;repair_kit=0;fuel_tank=0;engine=0;staralloy=0}
      tasks=@{board=@();active=@()}; traveling=$null; pendingEvent=$null; repairDisc=$null
      intel=@{unlocked=@{};log=@()}; knownEvents=@{}; gameStartTime=0; justArrived=$false; tutorial=$null
      stats=@{bought=0;sold=0;tasks=0;travels=0;distance=0;visits=0;income=0;upgrades=0;reps=0}
      achievements=@{}; visitedCities=@(); mailbox=@(); __savedAt=0; __loaded=$true
    }
  }
  if(!$rec.gs.mailbox){ $rec.gs | Add-Member -MemberType NoteProperty -Name mailbox -Value @() -Force }
  $box = New-Object System.Collections.ArrayList
  foreach($m in @($rec.gs.mailbox)){ [void]$box.Add($m) }
  $now = Get-UtcNowMs
  # 包装为完整邮件（PSCustomObject 不可直接赋新属性，统一在此补全 id/ts/read/claimed）
  $newMail = [pscustomobject]@{
    id = 'm' + $now + '_' + (Get-Random -Maximum 1000000)
    title = $mail.title
    from = $mail.from
    body = $mail.body
    attachments = $mail.attachments
    read = $false
    claimed = $false
    ts = $now
  }
  if($box.Count -ge $script:SfCap){
    $ri = Invoke-MailMakeRoom $box
    $box.RemoveAt($ri)
  }
  [void]$box.Add($newMail)
  $rec.gs.mailbox = @($box)
  $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
  return $newMail
}
function Get-Mailbox($user){
  EnsurePlayersDir
  $pf = Join-Path $playersDir ($user + '.json')
  if(!(Test-Path $pf)){ return ,@() }
  try{
    $rec = Get-Content -Raw $pf | ConvertFrom-Json
    if($rec.gs -and $rec.gs.mailbox){ return ,@($rec.gs.mailbox) }
  }catch{}
  return ,@()
}
function Find-Mail($rec,[string]$id){
  foreach($m in @($rec.gs.mailbox)){ if([string]$m.id -eq $id){ return $m } }
  return $null
}

$mime = @{
  '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'
  '.js'='text/javascript; charset=utf-8'; '.md'='text/plain; charset=utf-8'
  '.png'='image/png'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
  '.json'='application/json; charset=utf-8'
}
$prefix = if($Lan){"http://+:$Port/"}else{"http://${Bind}:$Port/"}

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
      # v9.10.2：星陨城活动周期配置 starfallConfig{runHours,interHours}，缺省从 default-world.json 兜底（默认 24/48），不触发世界重建
      if(!$w.starfallConfig){
        $d0 = $null
        try{ if(Test-Path $defaultWorldFile){ $d0 = Get-Content -Raw $defaultWorldFile | ConvertFrom-Json } }catch{}
        if($d0 -and $d0.starfallConfig){ $w | Add-Member -MemberType NoteProperty -Name starfallConfig -Value $d0.starfallConfig -Force }
        else{ $w | Add-Member -MemberType NoteProperty -Name starfallConfig -Value ([pscustomobject]@{runHours=[int]24; interHours=[int]48}) -Force }
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
        starfallConfig=$(if($d.starfallConfig){$d.starfallConfig}else{[pscustomobject]@{runHours=[int]24; interHours=[int]48}})
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
  Refresh-SfConfig $w0 # v9.10.2：周期参数化——启动时从 world.json starfallConfig 刷新
  $cityCount = @($w0.basePrices.PSObject.Properties).Count
  Write-Host ("  World:  ready (stockMode=" + $w0.stockMode + ", cities=" + $cityCount + ")") -ForegroundColor Green
}else{
  Write-Host '  World:  NOT READY (default-world.json missing)' -ForegroundColor Red
}
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -notmatch '^127\.|^169\.254\.'} | Select-Object -ExpandProperty IPAddress)
if($Lan){
  foreach($ip in $ips){ Write-Host "  LAN:    http://${ip}:${Port}/" -ForegroundColor Green }
}else{
  Write-Host "  URL:    http://${Bind}:${Port}/" -ForegroundColor Green
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
        $user=[string]$b.user; $nick=[string]$b.nickname; $pass=[string]$b.pass
        if(!$user -or $user -notmatch '^[A-Za-z0-9_]{3,12}$'){ SendJson @{ok=$false; err='用户名需 3~12 位英文/数字/下划线'}; continue }
        if([string]::IsNullOrEmpty($nick) -or $nick.Length -lt 1 -or $nick.Length -gt 20){ SendJson @{ok=$false; err='昵称需 1~20 个字符（可含中文）'}; continue }
        if(!$pass -or $pass.Length -lt 4){ SendJson @{ok=$false; err='password too short'}; continue }
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(Test-Path $pf){ SendJson @{ok=$false; err='username taken'} }
        else{
          # v9.10.3：昵称全服唯一（遍历玩家档校验）
          $nickTaken = $false
          Get-ChildItem $playersDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
            if($nickTaken){ return }
            try{
              $r = Get-Content -Raw $_.FullName | ConvertFrom-Json
              if($r.nickname -and [string]$r.nickname -eq [string]$nick){ $nickTaken = $true }
            }catch{}
          }
          if($nickTaken){ SendJson @{ok=$false; err='昵称已被使用，请换一个'}; continue }
          $salt = NewSalt
          $rec = @{user=$user; salt=$salt; passHash=(HashPass $salt $pass); nickname=[string]$nick; gs=$null}
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
          if($rec.passHash -eq (HashPass $rec.salt $pass)){ SendJson @{ok=$true; nickname=$rec.nickname} }
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
          # v9.10.3：返回昵称（缺省回退用户名）
          $nick = $user; if($rec.nickname){ $nick = [string]$rec.nickname }
          SendJson @{ok=$true; nickname=$nick; gs=$rec.gs}
        }
      }
      elseif($action -eq 'profile' -and $method -eq 'POST'){
        # v9.10.3：修改昵称（全服唯一校验），同时回写 gs.nickname
        $b = ReadBody
        $user=[string]$b.user; $nick=[string]$b.nickname
        if(!$user){ SendJson @{ok=$false; err='bad payload'}; continue }
        if([string]::IsNullOrEmpty($nick) -or $nick.Length -lt 1 -or $nick.Length -gt 20){ SendJson @{ok=$false; err='昵称需 1~20 个字符（可含中文）'}; continue }
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
        $nickTaken = $false
        Get-ChildItem $playersDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
          if($nickTaken){ return }
          if($_.Name -eq ($user + '.json')){ return }
          try{
            $r = Get-Content -Raw $_.FullName | ConvertFrom-Json
            if($r.nickname -and [string]$r.nickname -eq [string]$nick){ $nickTaken = $true }
          }catch{}
        }
        if($nickTaken){ SendJson @{ok=$false; err='昵称已被使用，请换一个'}; continue }
        $rec = Get-Content -Raw $pf | ConvertFrom-Json
        $rec.nickname = [string]$nick
        if($rec.gs){ if($rec.gs.nickname -eq $null){ $rec.gs | Add-Member -MemberType NoteProperty -Name nickname -Value ([string]$nick) -Force } else { $rec.gs.nickname = [string]$nick } }
        $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
        SendJson @{ok=$true; nickname=[string]$nick}
      }
      elseif($action -eq 'passwd' -and $method -eq 'POST'){
        # v9.10.3：修改密码（需旧密码）
        $b = ReadBody
        $user=$b.user; $old=$b.old; $new=$b.new
        if(!$user -or !$old -or !$new){ SendJson @{ok=$false; err='bad payload'}; continue }
        if($new.Length -lt 4){ SendJson @{ok=$false; err='新密码至少 4 位'}; continue }
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
        $rec = Get-Content -Raw $pf | ConvertFrom-Json
        if($rec.passHash -ne (HashPass $rec.salt $old)){ SendJson @{ok=$false; err='旧密码错误'}; continue }
        $rec.passHash = HashPass $rec.salt $new
        $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
        SendJson @{ok=$true}
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
            # v9.10.1：邮箱由服务端权威投递（客户端上传时不含 mailbox），保存时保留服务端 mailbox，
            # 避免结算奖励等邮件被客户端自动保存覆盖
            $incomingGs = $b.gs
            if($rec.gs -and $null -ne $rec.gs.mailbox){
              if($null -eq $incomingGs.mailbox){ $incomingGs | Add-Member -MemberType NoteProperty -Name mailbox -Value $rec.gs.mailbox -Force }
            }
            $rec.gs = $incomingGs
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
            # v9.10.3：显示昵称（缺省回退用户名）
            $nick = $rec.user; if($rec.nickname){ $nick = [string]$rec.nickname }
            $rows += [pscustomobject]@{user=$rec.user; nickname=$nick; gold=[long]$rec.gs.gold; day=[int]$rec.gs.day; distance=$distance; tasks=$tasks; visits=$visits; rep=$rep}
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
        SendJson @{ok=$true; id=$m.id; nickname=$m.nickname; title=$m.title} # v9.10.3：回传昵称/称号供客户端即时渲染
      }
      elseif($action -eq 'chat' -and $method -eq 'GET'){
        $since = $request.QueryString['since']
        $msgs = GetChatSince $since
        SendJson @{ok=$true; msgs=@($msgs)}
      }
      elseif($action -eq 'starfall' -and $seg.Length -gt 2 -and $seg[2] -eq 'activity' -and $method -eq 'GET'){
        $user = [System.Uri]::UnescapeDataString([string]$request.QueryString['user'])
        $act = LoadStarfall
        Invoke-MaybeSfRotate $act | Out-Null
        $snap = Get-SfSnapshot $act $user
        SendJson @{ ok=$true; activity=[pscustomobject]@{
          period=$act.period; phase=$act.phase; phaseStartedAt=$act.phaseStartedAt; phaseEndsAt=$act.phaseEndsAt
          target=$act.target; required=$act.required; totalProgress=$act.totalProgress
          top10=$snap.rows; myRank=$snap.myRank; myScore=$snap.myScore; history=$act.history
          sfConfig=[pscustomobject]@{ runMs=[int64]$script:SfRunMs; interMs=[int64]$script:SfInterMs }  # v9.10.2：周期参数化，客户端据此对齐
        } }
      }
      elseif($action -eq 'starfall' -and $seg.Length -gt 2 -and $seg[2] -eq 'contribute' -and $method -eq 'POST'){
        $b = ReadBody
        $user = [string]$b.user
        if(!$user){ SendJson @{ok=$false; err='bad payload'}; continue }
        $act = LoadStarfall
        Invoke-MaybeSfRotate $act | Out-Null
        if($act.phase -ne 'running'){ SendJson @{ok=$false; err='当前不在建设期'}; continue }
        $items = @($b.items)
        if(!$items -or !$items.Count){ SendJson @{ok=$false; err='bad payload'}; continue }
        $req = $act.required
        # v9.9.3：放开提交范围——物资全集（itemCategories special+basic）内均可提交；贡献率：当期特产100 / 当期普通20 / 其他1
        $cats = Get-SfItemCategories
        $allItems = @{}
        foreach($s in $cats.special){ $allItems[[string]$s] = $true }
        foreach($b in $cats.basic){ $allItems[[string]$b] = $true }
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
        $rec = Get-Content -Raw $pf | ConvertFrom-Json
        if(!$rec.gs){ SendJson @{ok=$false; err='player never saved'}; continue }
        $gained = [int64]0
        foreach($it in $items){
          $iid=[string]$it.item; $q=[int]$it.qty
          if(!$iid -or $q -le 0){ SendJson @{ok=$false; err='bad item'}; continue 2 }
          if(!$allItems.ContainsKey($iid)){ SendJson @{ok=$false; err='未知物资'}; continue 2 }
          $held = [int]0
          try{ if($rec.gs.cargo){ $held = [int]$rec.gs.cargo.$iid } }catch{}
          if($held -lt $q){ SendJson @{ok=$false; err='cargo shortage'; item=$iid; held=$held}; continue 2 }
          if($iid -eq [string]$req.special){ $rate = [int64]100 }
          elseif(@($req.normal) -contains $iid){ $rate = [int64]20 }
          else{ $rate = [int64]1 }
          $gained += [int64]$q * $rate
        }
        if(!$rec.gs.cargo){ $rec.gs | Add-Member -MemberType NoteProperty -Name cargo -Value ([pscustomobject]@{}) -Force }
        foreach($it in $items){
          $iid=[string]$it.item; $q=[int]$it.qty
          $left = [int]$rec.gs.cargo.$iid - $q
          if($left -le 0){ $rec.gs.cargo.PSObject.Properties.Remove($iid) }
          else{ $rec.gs.cargo.$iid = $left }
        }
        $act.totalProgress = [int64]$act.totalProgress + $gained
        if(!($act.scores.PSObject.Properties.Name -contains $user)){
          $act.scores | Add-Member -MemberType NoteProperty -Name $user -Value ([int64]0) -Force
          $act.firstOrder | Add-Member -MemberType NoteProperty -Name $user -Value ([int64]0) -Force
        }
        $act.scores.$user = [int64]$act.scores.$user + $gained
        $now = Get-UtcNowMs
        $act.firstOrder.$user = $now
        # bump __savedAt（与 tradeBatch 一致）：防客户端旧档自动保存覆盖本次扣货
        $rec.gs.__savedAt = $now
        SaveStarfall $act
        $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
        $snap = Get-SfSnapshot $act $user
        SendJson @{ ok=$true; cargo=$rec.gs.cargo; totalProgress=$act.totalProgress; myScore=$snap.myScore; myRank=$snap.myRank; top10=$snap.rows; gained=$gained; serverAt=$now }
      }
      elseif($action -eq 'mail' -and $method -eq 'GET'){
        $user = [System.Uri]::UnescapeDataString([string]$request.QueryString['user'])
        SendJson @{ ok=$true; mailbox=(Get-Mailbox $user) }
      }
      elseif($action -eq 'mail' -and $seg.Length -gt 2 -and $method -eq 'POST'){
        $op = [string]$seg[2]
        $b = ReadBody
        $user = [string]$b.user
        if(!$user){ SendJson @{ok=$false; err='bad payload'}; continue }
        EnsurePlayersDir
        $pf = Join-Path $playersDir ($user + '.json')
        if(!(Test-Path $pf)){ SendJson @{ok=$false; err='user not found'}; continue }
        $rec = Get-Content -Raw $pf | ConvertFrom-Json
        if(!$rec.gs){ SendJson @{ok=$false; err='player never saved'}; continue }
        if(!$rec.gs.mailbox){ $rec.gs | Add-Member -MemberType NoteProperty -Name mailbox -Value @() -Force }
        $ok = $true; $err = ''
        if($op -eq 'read'){
          $m = Find-Mail $rec ([string]$b.id)
          if($m -and !$m.read){ $m.read = $true }
        }elseif($op -eq 'readAll'){
          foreach($m in @($rec.gs.mailbox)){ $m.read = $true }
        }elseif($op -eq 'delete'){
          $m = Find-Mail $rec ([string]$b.id)
          if(!$m){ $ok=$false; $err='邮件不存在' }
          elseif(Test-MailUnclaimed $m){ $ok=$false; $err='附件未领取，不可删除' }
          else{
            $keep = New-Object System.Collections.ArrayList
            foreach($x in @($rec.gs.mailbox)){ if([string]$x.id -ne [string]$b.id){ [void]$keep.Add($x) } }
            $rec.gs.mailbox = @($keep)
          }
        }elseif($op -eq 'deleteRead'){
          $keep = New-Object System.Collections.ArrayList
          foreach($m in @($rec.gs.mailbox)){
            if($m.read -and !(Test-MailUnclaimed $m)){ continue }
            [void]$keep.Add($m)
          }
          $rec.gs.mailbox = @($keep)
        }elseif($op -eq 'claim'){
          $m = Find-Mail $rec ([string]$b.id)
          if(!$m){ $ok=$false; $err='邮件不存在' }
          elseif(!(Test-MailHasAtt $m) -or $m.claimed){ $ok=$false; $err='无附件可领取' }
          else{
            $a = $m.attachments
            try{
              if($a.gold -and [int64]$a.gold -gt 0){ $rec.gs.gold = [int64]$rec.gs.gold + [int64]$a.gold }
            }catch{}
            if($a.mats){
              if(!$rec.gs.materials){
                $rec.gs | Add-Member -MemberType NoteProperty -Name materials -Value ([pscustomobject]@{gear=0;repair_kit=0;fuel_tank=0;engine=0;staralloy=0}) -Force
              }
              foreach($p in $a.mats.PSObject.Properties){
                if([int64]$p.Value -gt 0){
                  if(!($rec.gs.materials.PSObject.Properties.Name -contains $p.Name)){
                    $rec.gs.materials | Add-Member -MemberType NoteProperty -Name $p.Name -Value ([int64]0) -Force
                  }
                  $rec.gs.materials.$($p.Name) = [int64]$rec.gs.materials.$($p.Name) + [int64]$p.Value
                }
              }
            }
            # v9.10.3：称号附件——写入服务端称号栏（防御性权威；客户端领取后下次存档亦会同步）
            $titleId = $null
            if($a.title -and [string]$a.title){
              $titleId = [string]$a.title
              if(!$rec.gs.titles){
                $rec.gs | Add-Member -MemberType NoteProperty -Name titles -Value ([pscustomobject]@{owned=@{};equipped=$null}) -Force
              }
              if(!$rec.gs.titles.owned){
                $rec.gs.titles | Add-Member -MemberType NoteProperty -Name owned -Value @{} -Force
              }
              if(!($rec.gs.titles.owned.PSObject.Properties.Name -contains $titleId)){
                $rec.gs.titles.owned | Add-Member -MemberType NoteProperty -Name $titleId -Value (Get-UtcNowMs) -Force
              }
            }
            $m.claimed = $true
            $now = Get-UtcNowMs
            $rec.gs.__savedAt = $now
            $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
            SendJson @{ ok=$true; mailbox=@($rec.gs.mailbox); gold=[int64]$rec.gs.gold; materials=$rec.gs.materials; serverAt=$now; title=$titleId }
            continue
          }
        }else{ $ok=$false; $err='unknown mail op' }
        if(!$ok){ SendJson @{ok=$false; err=$err}; continue }
        $rec | ConvertTo-Json -Depth 30 | Set-Content -Path $pf -Encoding UTF8
        SendJson @{ ok=$true; mailbox=@($rec.gs.mailbox) }
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
        elseif($cmd -eq 'starfall'){
          $action=[string]$b.action
          $act = LoadStarfall
          Invoke-MaybeSfRotate $act | Out-Null
          $now = Get-UtcNowMs
          if($action -eq 'status'){
            # v9.10 运维：返回活动状态快照（无需改动活动）
            $pcount = 0
            if($act.scores){ try{ $pcount = @($act.scores.PSObject.Properties).Count }catch{ $pcount = 0 } }
            $hist = @($act.history)
            $top = $null
            if($hist.Count){ try{ $top = [string]$hist[0].first }catch{} }
            $normalArr = New-Object System.Collections.ArrayList
            foreach($n in @($act.required.normal)){ [void]$normalArr.Add([string]$n) }
            SendJson @{ ok=$true; activity=[pscustomobject]@{
              period=[int64]$act.period; phase=[string]$act.phase
              now=$now; phaseEndsAt=[int64]$act.phaseEndsAt
              target=[int64]$act.target; totalProgress=[int64]$act.totalProgress
              special=[string]$act.required.special; normal=@($normalArr)
              players=$pcount; lastChampion=$top
              sfRunMs=[int64]$script:SfRunMs; sfInterMs=[int64]$script:SfInterMs
            } }
            continue
          }
          if($action -eq 'cycle'){
            # v9.10.2：周期参数化——热改建设期/间隙期时长（world.json starfallConfig），下一阶段切换生效
            $runH = [double]$b.runH
            $interH = [double]$b.interH
            if($runH -lt 1 -or $runH -gt 168 -or $interH -lt 1 -or $interH -gt 168){
              SendJson @{ok=$false; err='cycle 参数范围 1~168 小时'}; continue
            }
            if(!($w.PSObject.Properties.Name -contains 'starfallConfig')){
              $w | Add-Member -MemberType NoteProperty -Name starfallConfig -Value ([pscustomobject]@{}) -Force
            }
            $w.starfallConfig.runHours = $runH
            $w.starfallConfig.interHours = $interH
            SaveWorld $w
            Refresh-SfConfig $w
            Write-SfLog ('[Admin] starfall cycle：run=' + $runH + 'h inter=' + $interH + 'h（下一阶段切换生效）')
            SendJson @{ok=$true; msg=('✅ 活动周期已更新：建设期 ' + $runH + 'h / 间隙期 ' + $interH + 'h（已开始的周期不回溯，下一阶段切换生效）')}
            continue
          }
          if($action -eq 'start'){
            if($act.phase -eq 'running'){ SendJson @{ok=$true; msg=('ℹ 已在建设期（第 ' + [int64]$act.period + ' 期）')}; continue }
            $act.period = [int64]$act.period + 1
            $act.required = Get-SfPickGoods $act.period
            $act.totalProgress = [int64]0
            $act.scores = [pscustomobject]@{}
            $act.firstOrder = [pscustomobject]@{}
            $act.settled = $false
            $act.phase = 'running'; $act.phaseStartedAt = $now; $act.phaseEndsAt = $now + $script:SfRunMs
            SaveStarfall $act
            Write-SfLog ('[Admin] starfall start：第 ' + [int64]$act.period + ' 期建设开始，special=' + [string]$act.required.special)
            PublishBroadcast $w ('☄️ 星陨城第 ' + [int64]$act.period + ' 期建设已开始，全服玩家可前往提交物资！')
            SendJson @{ok=$true; msg=('✅ 星陨城第 ' + [int64]$act.period + ' 期建设已开始（24h），所需物资已重新抽选')}
          }elseif($action -eq 'end'){
            if($act.phase -ne 'running'){ SendJson @{ok=$true; msg='ℹ 当前不在建设期'}; continue }
            Invoke-SettleStarfall $act
            $act.phase = 'intermission'; $act.phaseStartedAt = $now; $act.phaseEndsAt = $now + $script:SfInterMs
            SaveStarfall $act
            Write-SfLog ('[Admin] starfall end：第 ' + [int64]$act.period + ' 期结算并进入间隙期')
            PublishBroadcast $w ('☄️ 星陨城第 ' + [int64]$act.period + ' 期建设已结算，奖励已发放至邮箱！')
            SendJson @{ok=$true; msg='✅ 本期建设已结束并结算（奖励已投递邮箱），进入 48h 间隙期'}
          }elseif($action -eq 'next'){
            $msg = ''
            if($act.phase -eq 'running'){
              Invoke-SettleStarfall $act
              $act.phase = 'intermission'; $act.phaseStartedAt = $now; $act.phaseEndsAt = $now + $script:SfInterMs
              Write-SfLog ('[Admin] starfall next：第 ' + [int64]$act.period + ' 期结算，进入间隙期')
              PublishBroadcast $w ('☄️ 星陨城第 ' + [int64]$act.period + ' 期建设已结算，奖励已发放至邮箱！')
              $msg = '✅ 已结束本期并结算，进入间隙期（再执行一次 start 可立即开下期）'
            }else{
              $act.period = [int64]$act.period + 1
              $act.required = Get-SfPickGoods $act.period
              $act.totalProgress = [int64]0
              $act.scores = [pscustomobject]@{}
              $act.firstOrder = [pscustomobject]@{}
              $act.settled = $false
              $act.phase = 'running'; $act.phaseStartedAt = $now; $act.phaseEndsAt = $now + $script:SfRunMs
              Write-SfLog ('[Admin] starfall next：第 ' + [int64]$act.period + ' 期建设开始')
              PublishBroadcast $w ('☄️ 星陨城第 ' + [int64]$act.period + ' 期建设已开始，全服玩家可前往提交物资！')
              $msg = '✅ 已进入第 ' + [int64]$act.period + ' 期建设（24h）'
            }
            SaveStarfall $act
            SendJson @{ok=$true; msg=$msg}
          }else{
            SendJson @{ok=$false; err='用法：starfall start|end|next|status'}
          }
        }
        elseif($cmd -eq 'mail'){
          $user=[string]$b.user
          $gold=[int64]$b.gold; $alloy=[int64]$b.alloy
          # v9.10：可自定义标题/正文（缺省用 GM 默认文案），便于补发带说明的奖励邮件
          $title=[string]$b.title; $body=[string]$b.body
          if(!$user){ SendJson @{ok=$false; err='bad payload'}; continue }
          if(!$title){ $title='后台奖励发放' }
          if(!$body){ $body='GM 发放的奖励，请注意查收。' }
          $mats = [pscustomobject]@{}
          if($alloy -gt 0){ $mats | Add-Member -MemberType NoteProperty -Name staralloy -Value $alloy -Force }
          DeliverMail $user ([pscustomobject]@{
            title=$title; from='GM'
            body=$body
            attachments=[pscustomobject]@{ gold=$gold; mats=$mats }
          })
          Write-SfLog ('[Admin] mail：' + $user + ' gold=' + $gold + ' staralloy=' + $alloy)
          SendJson @{ok=$true; msg=('📮 已向 ' + $user + ' 发放奖励邮件（金币 ' + $gold + '，星陨合金 ' + $alloy + '）')}
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
    try{ Write-Host ('  ERROR: ' + $_.Exception.Message) -ForegroundColor Red }catch{}
    try{ $response.Close() }catch{}
  }
}

$listener.Stop()
$listener.Close()
Write-Host 'Server stopped.' -ForegroundColor Cyan
