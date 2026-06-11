# MusiAula Virtual - Prototipo sin Firebase

Prototipo web estático para probar una **clase virtual Musicala** con:

- videollamada integrada por Jitsi Meet;
- sala compartida por nombre;
- panel de objetivo de clase;
- recursos activables;
- ejercicio de secuencia de notas naturales;
- respuestas rápidas del estudiante;
- metrónomo local;
- bitácora local exportable;
- sincronización básica entre participantes usando el canal de datos de Jitsi.

No usa Firebase, base de datos ni backend propio. La consecuencia obvia, porque la realidad tiene pésimo UX: **lo persistente queda en `localStorage` del navegador** y la sincronización ocurre mientras los participantes están conectados a la misma sala.

---

## Cómo abrirlo rápido

### Opción 1: abrir el archivo directamente

1. Descomprime el ZIP.
2. Abre `index.html` en Chrome, Edge o Firefox.
3. Escribe tu nombre.
4. Copia el enlace de la sala y ábrelo en otro dispositivo.

Esta opción puede funcionar, pero algunos navegadores se ponen delicados con permisos.

---

## Opción recomendada: servidor local

### En Windows

1. Descomprime el ZIP.
2. Haz doble clic en `iniciar-windows.bat`.
3. Abre en el computador:

```txt
http://localhost:8080
```

4. Para abrirlo en otro celular o computador de la misma red WiFi:
   - mira la IP local que muestra la consola;
   - abre algo como:

```txt
http://TU-IP-LOCAL:8080
```

Ejemplo:

```txt
http://192.168.1.34:8080
```

### En Mac / Linux

1. Abre terminal en esta carpeta.
2. Ejecuta:

```bash
chmod +x iniciar-mac-linux.sh
./iniciar-mac-linux.sh
```

3. Abre:

```txt
http://localhost:8080
```

---

## Cómo probar con dos dispositivos

1. En el primer dispositivo entra como `Docente`.
2. Dale clic a **Copiar enlace para otro dispositivo**.
3. Abre ese enlace en el segundo dispositivo.
4. Entra como estudiante, o cambia el rol si quieres.
5. Prueba:
   - publicar objetivo;
   - activar recurso;
   - lanzar ejercicio;
   - enviar respuesta rápida;
   - guardar bitácora;
   - copiar/exportar datos.

---

## Limitaciones normales de esta versión

- No hay usuarios reales ni permisos.
- No hay base de datos compartida.
- No hay historial centralizado.
- La bitácora queda local.
- La sincronización depende de que Jitsi cargue bien y abra su canal de datos.
- El metrónomo no queda sincronizado entre dispositivos.
- Para producción habría que pasar a Firebase, Supabase o backend propio.

---

## Siguiente fase recomendada

Cuando esta prueba valide la experiencia, la versión seria debería tener:

- Firebase Auth con roles;
- Firestore para clases, recursos y bitácoras;
- Storage para PDFs, imágenes y audios;
- salas creadas desde agenda;
- acceso por clase y por usuario;
- panel docente/estudiante/acudiente;
- seguimiento conectado al ecosistema Musicala.

Esta versión es para probar la idea, no para matricular medio Bogotá en producción. Todavía.
