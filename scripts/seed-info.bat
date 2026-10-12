@echo off
setlocal
set "PROJECT=C:\Users\Admin\OneDrive\Desktop\Proj\Discord Bot\New folder"
cd /d "%PROJECT%"
if not exist "%PROJECT%\data" mkdir "%PROJECT%\data"
echo [%date% %time%] seed-info start >> "%PROJECT%\data\seed-info.log"
call npm run seed:info >> "%PROJECT%\data\seed-info.log" 2>&1
echo [%date% %time%] seed-info exit %errorlevel% >> "%PROJECT%\data\seed-info.log"
endlocal
