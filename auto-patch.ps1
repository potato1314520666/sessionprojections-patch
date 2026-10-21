# auto-patch.ps1 v2 — 全自动打补丁。v1 教训：spawn 式探针弹黑窗被用户回车杀死→误判占用。
# v2：外层进程内探针验证句柄 + node 侧 --skip-lock-check 不再弹窗；taskkill 按映像名杀，不靠 Get-Process。
$ErrorActionPreference = 'Continue'
$dir      = 'C:\Users\38761\Documents\deepseek-harness\default-workspace\sessionprojections-patch'
$log      = Join-Path $dir 'auto-patch.log'
$asar     = 'C:\Users\38761\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'
$exe      = 'C:\Users\38761\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$node     = 'C:\Program Files\nodejs\node.exe'

function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Log '=== auto-patch v2 start ==='
Start-Sleep -Seconds 8   # 给会话端最后一条用户消息留出送达窗口

# 1) 先礼后兵：taskkill 按映像名优雅关闭（不依赖 Get-Process 枚举）
$g = & taskkill /IM 'DeepSeek Harness.exe' 2>&1
Log ("graceful taskkill: " + ($g -join ' | '))
Start-Sleep -Seconds 6

# 2) 强杀全部残留（含托盘退不掉的孤儿），最多 3 轮
for ($round = 1; $round -le 3; $round++) {
  $chk = & tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>&1
  if (-not ($chk -match 'DeepSeek Harness\.exe')) { Log "round ${round}: no DSH process left"; break }
  $k = & taskkill /F /T /IM 'DeepSeek Harness.exe' 2>&1
  Log ("round ${round}: force-kill -> " + ($k -join ' | '))
  Start-Sleep -Seconds 3
}

# 3) 进程内 FileShare.None 探针等句柄释放（不弹任何窗口；最多 90 秒）
$free = $false; $waited = 0
for ($i = 0; $i -lt 90; $i++) {
  $waited = $i
  try { $fs = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None'); $fs.Close(); $free = $true; break }
  catch { if ($i -eq 10) { Log 'still locked at 10s (杀软/索引器短暂占用，继续等)' }; Start-Sleep -Seconds 1 }
}

if (-not $free) {
  Log 'FAIL: asar 句柄 90 秒后仍被占用，放弃打补丁（原版无损，DSH 照常重启）'
} else {
  Log ("asar handle free after {0}s, running patch" -f $waited)
  $out = & $node (Join-Path $dir 'patch-dsh.js') '--skip-lock-check' 2>&1
  $out | ForEach-Object { Log ("patch> " + $_) }
  Log ("patch exit code: {0}" -f $LASTEXITCODE)
}

# 4) 无论成败重启 DSH
Start-Process $exe
Log 'DSH relaunched'

# 5) 自毁任务
Unregister-ScheduledTask -TaskName 'DSHAutoPatch' -Confirm:$false -ErrorAction SilentlyContinue
Log '=== done ==='
