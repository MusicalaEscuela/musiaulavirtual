@echo off
title MusiAula Virtual - Servidor local
cd /d "%~dp0"

echo.
echo ==========================================
echo   MusiAula Virtual - Prototipo local
echo ==========================================
echo.
echo Abre en este computador:
echo   http://localhost:8080
echo.
echo Para otro dispositivo en la misma WiFi, busca tu IPv4:
echo.

ipconfig | findstr /i "IPv4"

echo.
echo Luego abre:
echo   http://TU-IP:8080
echo.
echo Si Windows pregunta por permisos de red, permite acceso privado.
echo Cierra esta ventana para detener el servidor.
echo.

python -m http.server 8080
if errorlevel 1 (
  echo.
  echo Intentando con el lanzador py...
  py -m http.server 8080
)

pause
