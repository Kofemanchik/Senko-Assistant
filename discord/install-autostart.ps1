# Senko Assistant · автозапуск Discord-бота при входе в Windows (запустить один раз в PowerShell).
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Удалить автозапуск: Unregister-ScheduledTask -TaskName "Senko Discord Bot" -Confirm:$false
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $dir "run-forever.bat"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Senko Discord Bot" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "Senko Discord Bot"
Write-Host "Готово: бот запущен и будет стартовать при каждом входе в Windows. Лог: $dir\bot.log"
