@echo off
rem Starts Financial Monitoring for the office.
rem
rem The service itself only ever listens on the loopback address. Caddy (on the office
rem network) and the Cloudflare tunnel (from outside) are what the browsers actually reach,
rem and both forward to it here.

cd /d "%~dp0.."

rem The address staff type. Set this to the name you want treated as canonical.
if "%FR_ORIGIN%"=="" set FR_ORIGIN=https://finance-pc

rem Every other name the same server answers to, comma separated. A browser treats each name
rem as a separate origin, so any name in use must be listed or its forms will be refused.
if "%FR_EXTRA_ORIGINS%"=="" set FR_EXTRA_ORIGINS=https://192.168.1.10

rem Caddy and the Cloudflare tunnel both sit in front, so the real client address arrives in a
rem header. Without this every visitor would share one login-attempt bucket.
set FR_TRUST_PROXY=1

set FR_HOST=127.0.0.1
set FR_PORT=3403

rem A second copy of every backup, off this machine. A backup on the same disk as the
rem database does not survive that disk. Point this at OneDrive, a network share or a USB
rem drive, then uncomment it.
rem set FR_BACKUP_COPY_TO=D:\Backups\FinancialMonitoring

echo Starting Financial Monitoring
echo   canonical address : %FR_ORIGIN%
echo   also answering to : %FR_EXTRA_ORIGINS%
echo.

node src\server.mjs
