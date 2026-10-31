@echo off
rem Senko Assistant · Discord-бот на Windows: запускает бота и поднимает его заново после сбоя.
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm ci --omit=dev
:loop
echo [%date% %time%] Запуск бота
node bot.js >> bot.log 2>&1
echo [%date% %time%] Бот остановился, перезапуск через 10 секунд >> bot.log
timeout /t 10 /nobreak >nul
goto loop
