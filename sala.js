// Nombre del aula personal de un docente.
// Vive en su propio módulo porque lo usan DOS lados: el aula (app.js) y el
// panel de agenda. Si cada uno lo calculara por su cuenta, un cambio en uno
// mandaría a los estudiantes a una sala distinta de la agendada.

// Slug propio: a diferencia de normalizeRoom() del aula, un vacío aquí tiene
// que seguir siendo vacío. Aquel inventa un nombre aleatorio, y eso rompería
// en silencio la promesa de que el aula es siempre la misma.
export function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Misma entrada, misma salida, siempre y en cualquier dispositivo: no se
// guarda en ninguna parte, se deriva del correo.
export function personalRoomFor(email, hubData) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return "";

  // Si coordinación le asignó un nombre en el Hub, ese manda.
  const assigned = slug(hubData?.salaSlug || hubData?.slug);
  if (assigned) return assigned;

  const base = slug(normalized.split("@")[0]) || "docente";

  // Huella corta y estable del correo completo, para que dos personas con el
  // mismo usuario en dominios distintos no caigan en la misma aula.
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `${base}-${hash.toString(36).slice(0, 4)}`;
}

// Correos que pueden agendar clases. Es una lista corta y explícita a
// propósito: el panel la usa para mostrarse y las reglas de la base de datos
// la repiten para hacerla cumplir de verdad.
export const ADMIN_EMAILS = [
  "adminmusicala@gmail.com",
  "musicalaasesor@gmail.com",
  "alekcaballeromusic@gmail.com",
  "catalina.medina.leal@gmail.com"
];

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || "").trim().toLowerCase());
}
