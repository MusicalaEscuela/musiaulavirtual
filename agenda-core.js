/* Cálculo de horarios de clase.

   Todo se mide en la hora de Colombia, NO en la del dispositivo: el celular
   de un estudiante puede estar en otra zona horaria o con la hora corrida, y
   la clase es a las 3:00 de Bogotá pase lo que pase. Colombia no tiene
   horario de verano, así que el desfase es fijo, pero igual se resuelve con
   Intl para no dejarlo escrito a mano.

   Una clase es:
     - "semanal": se repite el mismo día y hora cada semana (weekday 0=domingo)
     - "unica":   una sola fecha (reprogramaciones, clases sueltas)
   Una clase semanal puede tener fechas canceladas en `skip`.
*/

export const ZONA = "America/Bogota";

// Minutos antes del inicio en que se abre el aula. Corto a propósito: el aula
// no es una sala de reuniones abierta todo el día.
export const ABRE_ANTES_MIN = 5;

// Margen después del final, para que una clase que se alarga no eche a nadie.
export const CIERRA_DESPUES_MIN = 10;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function nombreDia(weekday) {
  return DIAS[weekday] || "";
}

// Partes de la fecha/hora de Bogotá para un instante dado.
export function partesBogota(ms) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, weekday: "short"
  });
  const p = {};
  for (const part of fmt.formatToParts(ms)) p[part.type] = part.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    // "24" aparece a medianoche en algunos motores; se normaliza a 0.
    hora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    weekday: weekdayMap[p.weekday]
  };
}

// Convierte una fecha y hora de Bogotá ("2026-09-15", "15:00") al instante
// absoluto correspondiente. Se calcula el desfase real de la zona en esa
// fecha en vez de asumir -05:00.
export function instanteBogota(fecha, horaHHMM) {
  const [y, m, d] = String(fecha).split("-").map(Number);
  const [hh, mm] = String(horaHHMM).split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;

  // Primer intento: tratar los números como si fueran UTC.
  const tentativo = Date.UTC(y, m - 1, d, hh, mm, 0);
  // Cuánto se desvía ese instante al leerlo en Bogotá, y se corrige.
  const leido = partesBogota(tentativo);
  const leidoUTC = Date.UTC(
    ...leido.fecha.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))),
    leido.hora, leido.minuto, 0
  );
  return tentativo + (tentativo - leidoUTC);
}

// Instante de inicio de la próxima ocurrencia de una clase (o la de hoy si
// aún no ha terminado). Devuelve null si la clase ya no tiene ocurrencias.
export function proximaOcurrencia(clase, ahoraMs) {
  if (!clase || clase.active === false) return null;
  const dur = Number(clase.duration) || 45;

  if (clase.type === "unica") {
    const inicio = instanteBogota(clase.date, clase.start);
    if (!Number.isFinite(inicio)) return null;
    // Ya pasada del todo: no cuenta.
    if (ahoraMs > inicio + (dur + CIERRA_DESPUES_MIN) * 60000) return null;
    return inicio;
  }

  if (clase.type !== "semanal") return null;
  const weekday = Number(clase.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;

  const hoy = partesBogota(ahoraMs);
  // Se revisan hoy y los próximos 7 días: el primero que sirva es el bueno.
  for (let salto = 0; salto <= 7; salto++) {
    const dia = sumarDias(hoy.fecha, salto);
    if (diaSemanaDe(dia) !== weekday) continue;
    if (Array.isArray(clase.skip) && clase.skip.includes(dia)) continue;

    const inicio = instanteBogota(dia, clase.start);
    if (!Number.isFinite(inicio)) continue;
    if (ahoraMs <= inicio + (dur + CIERRA_DESPUES_MIN) * 60000) return inicio;
  }
  return null;
}

export function sumarDias(fecha, dias) {
  const [y, m, d] = fecha.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + dias * 86400000;
  const dt = new Date(t);
  const p = n => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export function diaSemanaDe(fecha) {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/* ¿Se puede entrar ahora mismo a esta sala?
   Devuelve { abierto, clase, inicio, motivo, faltanMs }. */
export function estadoDeSala(clases, ahoraMs) {
  const lista = Object.entries(clases || {})
    .map(([id, c]) => ({ id, ...c }))
    .filter(c => c && c.active !== false);

  if (!lista.length) return { abierto: false, motivo: "sin-agenda" };

  let mejor = null;
  for (const clase of lista) {
    const inicio = proximaOcurrencia(clase, ahoraMs);
    if (inicio === null) continue;
    if (!mejor || inicio < mejor.inicio) mejor = { clase, inicio };
  }

  if (!mejor) return { abierto: false, motivo: "sin-proximas" };

  const dur = Number(mejor.clase.duration) || 45;
  const abre = mejor.inicio - ABRE_ANTES_MIN * 60000;
  const cierra = mejor.inicio + (dur + CIERRA_DESPUES_MIN) * 60000;

  if (ahoraMs >= abre && ahoraMs <= cierra) {
    return { abierto: true, clase: mejor.clase, inicio: mejor.inicio, motivo: "en-horario" };
  }
  return {
    abierto: false,
    clase: mejor.clase,
    inicio: mejor.inicio,
    motivo: "fuera-de-horario",
    faltanMs: abre - ahoraMs
  };
}

// "martes 3:00 p. m." para mostrarle al estudiante cuándo es su clase.
export function textoCuando(inicioMs) {
  if (!Number.isFinite(inicioMs)) return "";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: ZONA, weekday: "long", hour: "numeric", minute: "2-digit", hour12: true
  }).format(inicioMs);
}
