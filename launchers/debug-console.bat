@echo off
chcp 65001 >nul
title AI智能看板 - 排错模式
cd /d "%~dp0"

rem ============================================================
rem  本文件仅用于排查启动问题（会保留日志窗口，方便看报错）。
rem  日常使用请双击 launchers\open-board.vbs，那才是正常的启动方式。
rem
rem  优先使用 Node.js（跨平台，与 Mac 同一套服务代码）
rem ============================================================

where node >nul 2>nul
if errorlevel 1 goto use_powershell

rem --app 表示以「应用模式窗口」打开（无地址栏，像原生软件）
node "%~dp0..\app\server.js" --app --host=127.0.0.1
goto done

:use_powershell
echo.
echo  未检测到 Node.js，改用 Windows 自带的 PowerShell 服务。
echo  注意：该模式只能用普通浏览器标签页打开，且暂不支持多台账。
echo  如需完整功能，可安装 Node.js：https://nodejs.org
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\app\server.ps1"
goto done

:done
if errorlevel 1 pause
