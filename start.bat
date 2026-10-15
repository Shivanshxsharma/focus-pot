@echo off
rem ==========================================================================
rem  Focus Pot launcher (Tauri)
rem  First run: builds the app (a few minutes, needs Rust + VS C++ Build Tools).
rem  After that it just starts the built focuspot.exe instantly.
rem ==========================================================================
setlocal
cd /d "%~dp0"
set "EXE=src-tauri\target\release\focuspot.exe"

if not exist "%EXE%" (
  where cargo >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  Rust is not installed. Install it from https://rustup.rs and the
    echo  "Desktop development with C++" Build Tools, then run this again.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo  First run: building Focus Pot. This takes a few minutes...
  echo.
  pushd src-tauri
  cargo build --release
  if errorlevel 1 (
    popd
    echo.
    echo  The build failed. See the messages above.
    pause
    exit /b 1
  )
  popd
)

start "" "%EXE%"
exit /b 0
