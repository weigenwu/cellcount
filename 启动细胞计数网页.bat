@echo off
setlocal
cd /d "%~dp0"
title CellScope 本地细胞计数

if not exist ".venv\Scripts\python.exe" (
  echo [CellScope] 首次运行，正在创建本地环境...
  py -3 -m venv .venv
  if errorlevel 1 (
    echo 无法创建 Python 环境。请安装 Python 3.11 或更高版本。
    pause
    exit /b 1
  )
  echo [CellScope] 正在安装图像分析组件，仅首次需要联网...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重新双击本文件。
    pause
    exit /b 1
  )
)

echo [CellScope] 启动中...
".venv\Scripts\python.exe" -m cell_counter.server
if errorlevel 1 pause

