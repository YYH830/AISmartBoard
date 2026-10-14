<#
  AI智能看板 —— 本地数据服务（零依赖，只需 Windows 自带的 PowerShell）
  作用：
    1. 提供界面访问（http://localhost:端口/）
    2. 通过 /api/data 读取、写入「data」文件夹下的 tasks.md
  说明：仅监听 localhost，仅本机可访问，不会对外暴露。
        本脚本位于「app」文件夹，静态文件从这里提供，台账数据存放在上级的「data」文件夹。
#>
param(
  [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root      = $PSScriptRoot                                  # 程序目录（index.html 等静态文件）
$LedgerDir = Join-Path (Split-Path $Root -Parent) 'data'      # 台账数据目录
$DataFile  = Join-Path $LedgerDir 'tasks.md'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 台账目录不存在则创建
if (-not (Test-Path $LedgerDir)) {
  New-Item -ItemType Directory -Force -Path $LedgerDir | Out-Null
}

# 数据文件不存在则初始化一份空白台账
if (-not (Test-Path $DataFile)) {
  $init = "# AI智能看板`r`n`r`n> 本文件由「AI智能看板」自动读写，可手工编辑；保存后看板会自动刷新。`r`n`r`n## 一、任务池`r`n`r`n| 编号 | 任务 | 状态 | 预估人天 | 备注 |`r`n| :--- | :--- | :--- | ---: | :--- |`r`n`r`n## 二、排期`r`n`r`n| 编号 | 开始 | 结束 |`r`n| :--- | :--- | :--- |`r`n"
  [IO.File]::WriteAllText($DataFile, $init, $Utf8NoBom)
}

# 端口被占用时自动顺延
$Listener = $null
while (-not $Listener) {
  try {
    $Listener = New-Object System.Net.HttpListener
    $Listener.Prefixes.Add("http://localhost:$Port/")
    $Listener.Start()
  } catch {
    $Listener = $null
    $Port++
    if ($Port -gt 8785) { throw "8765-8785 端口都被占用，请先关闭占用程序后重试。" }
  }
}

$Url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  AI智能看板已启动" -ForegroundColor Cyan
Write-Host "  界面地址：$Url" -ForegroundColor White
Write-Host "  台账目录：$LedgerDir" -ForegroundColor DarkGray
Write-Host "  关闭本窗口即停止服务（记录已实时写入 MD，不会丢失）" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  提示：本模式（PowerShell 服务）不支持多台账。安装 Node.js 后使用 launchers/open-board.vbs 可获得完整功能。" -ForegroundColor DarkYellow
Write-Host ""

Start-Process $Url | Out-Null

# ---------- 工具函数 ----------
function Send-Text($ctx, $text, $contentType, $code = 200) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $ctx.Response.StatusCode    = $code
  $ctx.Response.ContentType   = $contentType
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.OutputStream.Close()
}

# 手工转义，避免 ConvertTo-Json 对中文/换行处理不一致
function Json-Escape([string]$s) {
  if ($null -eq $s) { return '' }
  $s = $s.Replace('\', '\\').Replace('"', '\"')
  $s = $s -replace "`r", '\r' -replace "`n", '\n' -replace "`t", '\t'
  return $s
}

function Read-Data {
  if (-not (Test-Path $DataFile)) { return '' }
  return [IO.File]::ReadAllText($DataFile, [System.Text.Encoding]::UTF8)
}

function Get-MTime {
  $t = (Get-Item $DataFile).LastWriteTimeUtc
  return [long](($t - [datetime]'1970-01-01').TotalMilliseconds)
}

function Send-DataJson($ctx) {
  $content = Read-Data
  $json = '{"ok":true,"mtime":' + (Get-MTime) + ',"path":"' + (Json-Escape $DataFile) + '","content":"' + (Json-Escape $content) + '"}'
  Send-Text $ctx $json 'application/json; charset=utf-8'
}

# ---------- 请求循环 ----------
while ($Listener.IsListening) {
  $ctx = $null
  try { $ctx = $Listener.GetContext() } catch { break }

  try {
    $req    = $ctx.Request
    $path   = [Uri]::UnescapeDataString($req.Url.LocalPath)
    $method = $req.HttpMethod

    if ($path -eq '/api/data') {
      if ($method -eq 'GET') {
        Send-DataJson $ctx
      }
      elseif ($method -eq 'PUT' -or $method -eq 'POST') {
        $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        $reader.Close()
        # 原子写入：先写临时文件再替换，避免写入过程中界面读到半截内容
        $tmp = "$DataFile.tmp"
        [IO.File]::WriteAllText($tmp, $body, $Utf8NoBom)
        Move-Item -Force -Path $tmp -Destination $DataFile
        $json = '{"ok":true,"mtime":' + (Get-MTime) + ',"time":"' + (Get-Date -Format 'HH:mm:ss') + '"}'
        Send-Text $ctx $json 'application/json; charset=utf-8'
      }
      else { Send-Text $ctx '{"ok":false,"error":"method not allowed"}' 'application/json; charset=utf-8' 405 }
      continue
    }

    # 静态文件
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $Root ($path.TrimStart('/').Replace('/', '\'))
    $full = [IO.Path]::GetFullPath($file)
    if (-not $full.StartsWith([IO.Path]::GetFullPath($Root))) {
      Send-Text $ctx 'forbidden' 'text/plain; charset=utf-8' 403
      continue
    }
    if (Test-Path $full -PathType Leaf) {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8';
                  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8';
                  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon';
                  '.md' = 'text/markdown; charset=utf-8' }
      $ctype = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      Send-Text $ctx ([IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)) $ctype
    } else {
      Send-Text $ctx 'not found' 'text/plain; charset=utf-8' 404
    }
  }
  catch {
    try { Send-Text $ctx ("server error: " + $_.Exception.Message) 'text/plain; charset=utf-8' 500 } catch {}
  }
}

try { $Listener.Stop() } catch {}
