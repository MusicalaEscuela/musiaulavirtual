#!/usr/bin/env bash
cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "  MusiAula Virtual - Prototipo local"
echo "=========================================="
echo ""
echo "Abre en este computador:"
echo "  http://localhost:8080"
echo ""
echo "Para otro dispositivo en la misma WiFi, busca tu IP local:"
echo "  macOS:   ipconfig getifaddr en0"
echo "  Linux:   hostname -I"
echo ""
echo "Luego abre:"
echo "  http://TU-IP:8080"
echo ""
echo "Ctrl+C detiene el servidor."
echo ""

python3 -m http.server 8080 || python -m http.server 8080
