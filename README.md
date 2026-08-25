# MusiAula Virtual - Prototipo con Firebase + WebRTC

Prototipo web para probar una **clase virtual Musicala 1 a 1** con:

- videollamada propia (WebRTC, sin Jitsi ni iframes externos);
- escenario interactivo controlado por el docente: nota gigante, secuencia animada, juego "¿qué nota sigue?" y celebración;
- sala compartida por nombre;
- recursos activables;
- ejercicio de secuencia de notas naturales;
- respuestas rápidas del estudiante (le llegan al docente en vivo);
- metrónomo sincronizado entre todos los dispositivos (reloj del servidor);
- sincronización en tiempo real con **Firebase Realtime Database** (estado del aula + señalización del video).

---

## Configuración de Firebase (una sola vez)

1. En la [consola de Firebase](https://console.firebase.google.com) abre el proyecto `musiaula-virtual`.
2. **Compilación → Realtime Database → Crear base de datos** (si no existe). Copia la URL que aparece (algo como `https://musiaula-virtual-default-rtdb.firebaseio.com`) y verifica que coincida con `databaseURL` en `firebase-config.js`.
3. En la pestaña **Reglas**, pega el contenido de `database.rules.json` (exigen sesión iniciada: `auth != null`).

4. Publica las reglas.

---

## Cómo abrirlo

### En Windows

1. Doble clic en `iniciar-windows.bat`.
2. Abre `http://localhost:8080`.

### En Mac / Linux

```bash
chmod +x iniciar-mac-linux.sh
./iniciar-mac-linux.sh
```

> 📷 **Importante para el video:** `getUserMedia` (cámara/micrófono) solo funciona en `localhost` o en HTTPS. Para probar con un celular en la misma red WiFi (`http://TU-IP:8080`) el navegador bloqueará la cámara por ser HTTP. Lo más fácil para probar entre dispositivos: subir la carpeta a un hosting con HTTPS (Firebase Hosting, Netlify, Vercel — gratis) o usar un túnel como `ngrok`.

---

## Cómo probar con dos dispositivos

1. En el primer dispositivo entra como `Docente`.
2. Clic en **Copiar enlace** y ábrelo en el segundo dispositivo como `Estudiante`.
3. Acepta los permisos de cámara/micrófono en ambos.
4. El docente conecta el video (es quien "llama"); si no conecta, botón **↻** sobre el video.
5. Prueba desde la pestaña **Escenario**: nota gigante, secuencia animada, juego y celebración — todo aparece en la pantalla del estudiante al instante.

El estudiante solo ve el aula y el escenario: no tiene controles de edición.

---

## Limitaciones de esta versión

- Pensada para clases **1 a 1** (un docente + un estudiante). Más participantes requieren un SFU (LiveKit, etc.).
- TURN de respaldo activo (Metered, plan gratuito de 0,5 GB/mes): si se agota la cuota, las redes muy restrictivas vuelven a fallar.
- El rol se elige en el lobby; solo el rol docente se valida contra el Hub de docentes.

---

## Siguiente fase recomendada

- Firebase Auth con roles reales (docente/estudiante/acudiente);
- Firestore para clases y recursos persistentes;
- Storage para PDFs, imágenes y audios;
- salas creadas desde agenda y acceso por clase/usuario;
- seguimiento conectado al ecosistema Musicala.
