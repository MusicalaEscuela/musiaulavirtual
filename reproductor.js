/* Reproductor de música sincronizado.

   La idea: en vez de compartir pantalla y audio (que come internet, mete la
   música por el micrófono del profe y obliga a ver el video), CADA
   dispositivo reproduce la misma canción por su cuenta y solo se sincroniza
   la POSICIÓN por la base de datos. Es la misma idea del metrónomo: el dato
   viaja, el sonido no.

   Ventajas frente a compartir pantalla:
   - suena con calidad completa en ambos lados, no comprimido por la llamada;
   - no consume internet extra (cada quien lo baja de YouTube);
   - no ocupa la pantalla: puede quedar en un rincón mientras se ve otra cosa;
   - el profe no tiene que poner el celular al lado del micrófono.

   El precio: cada dispositivo debe poder abrir YouTube, y el primer play
   necesita un toque de la persona (los navegadores no dejan sonar solos).
*/

let apiLista = null;

// Carga la API de YouTube una sola vez, aunque la pidan varios sitios.
export function cargarApiYouTube() {
  if (apiLista) return apiLista;

  apiLista = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);

    const previo = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previo?.();
      resolve(window.YT);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("No se pudo cargar YouTube"));
    document.head.appendChild(script);
  });

  return apiLista;
}

// Saca el id del video de cualquier forma de enlace de YouTube.
export function idDeYouTube(texto) {
  const valor = String(texto || "").trim();
  if (/^[\w-]{11}$/.test(valor)) return valor; // ya es un id
  const m = valor.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/* Dónde debería ir la canción en este instante, según el estado compartido.
   Si está sonando, la posición avanza sola con el reloj del servidor; si está
   en pausa, se queda donde la dejaron. */
export function posicionEsperada(estado, ahoraServidorMs) {
  if (!estado) return 0;
  const base = Number(estado.pos) || 0;
  if (!estado.playing) return base;
  const transcurrido = (ahoraServidorMs - (Number(estado.startedAt) || ahoraServidorMs)) / 1000;
  return Math.max(0, base + transcurrido);
}
