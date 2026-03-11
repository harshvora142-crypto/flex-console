@echo off
echo ==========================================
echo    FLEX CONSOLE - CONNECTION FIXER
echo ==========================================
echo.
echo [1/3] Adding Firewall Rule for Port 3000...
netsh advfirewall firewall add rule name="FLEX CONSOLE Server (Port 3000)" dir=in action=allow protocol=TCP localport=3000
echo.
echo [2/3] Adding Firewall Rule for Port 24678 (Vite HMR)...
netsh advfirewall firewall add rule name="FLEX CONSOLE Vite (Port 24678)" dir=in action=allow protocol=TCP localport=24678
echo.
echo [3/3] Restarting Server...
echo.
echo DONE! Please REFRESH your TV screen now.
echo ==========================================
pause
