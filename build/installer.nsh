; Senko Assistant: дополнения к установщику (electron-builder подключает этот файл через nsis.include).
;
; До версии 2.2.0 программа ставилась в «%LOCALAPPDATA%\Programs\boston-pamyatka».
; Установщик берёт старый путь из реестра, поэтому без этого блока обновление осталось бы в старой папке.
; Здесь путь меняется на «...\Programs\Senko Assistant»; старую папку удаляет деинсталлятор прежней версии,
; который установщик запускает сам. Ярлыки создаются заново и указывают на новое место.
!macro customInit
  StrCpy $R8 $INSTDIR "" -16
  ${if} $R8 == "\boston-pamyatka"
    StrCpy $R9 $INSTDIR -16
    StrCpy $INSTDIR "$R9\${APP_FILENAME}"
  ${endif}
!macroend
