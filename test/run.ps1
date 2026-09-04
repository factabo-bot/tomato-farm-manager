# 養液設計まわりのテストを headless Chrome でまとめて実行する。
#
#   .\test\run.ps1              全部
#   .\test\run.ps1 -Only engine 計算エンジンだけ（速い）
#   .\test\run.ps1 -Verbose     失敗した行だけでなく全出力を見る
#
# frontend をそのままテストすると config.js の GAS_URL が本番を向いていて、
# テストが本番のスプレッドシートに書きに行ってしまう。
# _work/ にコピーして GAS_URL を空にし（＝お試しモード）、そこを対象にする。

param(
  [ValidateSet("all", "engine", "ui")]
  [string]$Only = "all",
  [switch]$ShowAll
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$test = Join-Path $root "test"
$work = Join-Path $test "_work"

$chrome = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error "Chrome が見つかりません"; exit 1 }

# --- frontend を _work にコピーし、GAS_URL を空にする ---
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item (Join-Path $root "frontend\*") $work -Recurse -Force
@'
const CONFIG = { GAS_URL: "", APP_TOKEN: "" };
'@ | Out-File (Join-Path $work "config.js") -Encoding utf8

function Get-Result([string]$html, [string]$id) {
  if ($html -match "(?s)<pre id=`"$id`">(.*?)</pre>") {
    return ($matches[1] -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&' -replace '&quot;','"')
  }
  return $null
}

$total = 0; $failed = 0; $files = 0

# --- 計算エンジン（DOM不要・単体で開く） ---
if ($Only -eq "all" -or $Only -eq "engine") {
  Write-Output "=== 計算エンジン ==="
  $base = "file:///" + ((Join-Path $test "engine") -replace '\\','/')
  Get-ChildItem (Join-Path $test "engine\*.html") | Sort-Object Name | ForEach-Object {
    $out = & $chrome --headless --disable-gpu --no-sandbox --virtual-time-budget=30000 --dump-dom "$base/$($_.Name)" 2>$null | Out-String
    $body = Get-Result $out "out"
    $files++
    if (-not $body) { Write-Output ("  {0,-26} 出力なし" -f $_.Name); $failed++; return }
    $lines = $body -split "`n"
    $summary = (($lines | Where-Object { $_ -match 'PASS \d+ / FAIL|passed,' }) -join "").Trim()
    if ($summary -match '(\d+)') { $total += [int]$matches[1] }
    $ng = $lines | Where-Object { $_ -match '^\s*(FAIL|NG) |エラー' }
    $failed += $ng.Count
    Write-Output ("  {0,-26} {1}" -f $_.Name, $summary)
    if ($ShowAll) { $lines | ForEach-Object { Write-Output ("      " + $_) } }
    elseif ($ng) { $ng | ForEach-Object { Write-Output ("      " + $_.Trim()) } }
  }
}

# --- 画面（iframe で本体を読む） ---
# seed ページで localStorage に状態を作ってから本体を開くので、
# 同じ --user-data-dir で2回起動する必要がある。
# iframe の中を読むので --allow-file-access-from-files も要る
if ($Only -eq "all" -or $Only -eq "ui") {
  Write-Output "=== 画面 ==="
  $base = "file:///" + ((Join-Path $test "ui") -replace '\\','/')
  $pairs = @(
    @{ seed = "seed.html";  test = "tank-split-test.html" },
    @{ seed = "seedR.html"; test = "recipe-test.html" },
    @{ seed = "seedS.html"; test = "solve-test.html" },
    @{ seed = "seedC.html"; test = "cost-ui-test.html" },
    @{ seed = "seed.html";  test = "eval-ui-test.html" },
    @{ seed = "seed.html";  test = "mode-ui-test.html" },
    @{ seed = "seed.html";  test = "dilution-test.html" },
    @{ seed = "seed.html";  test = "feed-log-test.html" }
  )
  $n = 0
  foreach ($p in $pairs) {
    $n++
    $profile = Join-Path $work "_chrome$n"
    & $chrome --headless --disable-gpu --no-sandbox --user-data-dir="$profile" `
      --virtual-time-budget=3000 --dump-dom "$base/$($p.seed)" 2>$null | Out-Null
    $out = & $chrome --headless --disable-gpu --no-sandbox --user-data-dir="$profile" `
      --allow-file-access-from-files --virtual-time-budget=40000 --dump-dom "$base/$($p.test)" 2>$null | Out-String
    $body = Get-Result $out "debug"
    $files++
    if (-not $body) { Write-Output ("  {0,-26} 出力なし" -f $p.test); $failed++; continue }
    $lines = $body -split "`n"
    $summary = (($lines | Where-Object { $_ -match 'PASS \d+ / FAIL' }) -join "").Trim()
    if ($summary -match 'PASS (\d+)') { $total += [int]$matches[1] }
    $ng = $lines | Where-Object { $_ -match '^\s*NG ' }
    $failed += $ng.Count
    Write-Output ("  {0,-26} {1}" -f $p.test, $summary)
    if ($ShowAll) { $lines | ForEach-Object { Write-Output ("      " + $_) } }
    elseif ($ng) { $ng | ForEach-Object { Write-Output ("      " + $_.Trim()) } }
  }
}

Write-Output "------------------------------------"
if ($failed -eq 0) {
  Write-Output "  $files ファイル / $total 項目すべてパス"
} else {
  Write-Output "  $files ファイル / $total 項目中 $failed 件が失敗"
}
exit ($(if ($failed -eq 0) { 0 } else { 1 }))
