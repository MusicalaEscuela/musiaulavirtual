// Panel de coordinación: agendar las clases que abren las aulas.
// Solo entran los cuatro correos de ADMIN_EMAILS; la lista se repite en las
// reglas de la base de datos, que son las que de verdad lo impiden.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, get, set, remove, push } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { personalRoomFor, isAdminEmail, ADMIN_EMAILS } from "./sala.js?v=1";
import { nombreDia, textoCuando, proximaOcurrencia } from "./agenda-core.js?v=1";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const $ = id => document.getElementById(id);
let clases = []; // { room, id, ...datos }

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3600);
}

/* ===== Entrada ===== */

$("googleLogin").addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch(error => {
    $("gateMsg").textContent = "No se pudo entrar: " + (error?.code || error);
  });
});

$("logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, user => {
  if (!user) {
    $("gate").classList.remove("hidden");
    $("panel").classList.add("hidden");
    return;
  }
  if (!isAdminEmail(user.email)) {
    $("gateMsg").textContent =
      `${user.email} no está autorizado para agendar. Autorizados: ${ADMIN_EMAILS.join(", ")}`;
    $("panel").classList.add("hidden");
    $("gate").classList.remove("hidden");
    signOut(auth);
    return;
  }
  $("gate").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("whoami").textContent = user.email;
  cargar();
});

/* ===== Formulario ===== */

// El aula se muestra en vivo para que quien agenda vea a dónde va a mandar
// al estudiante antes de guardar.
$("teacherEmail").addEventListener("input", () => {
  const room = personalRoomFor($("teacherEmail").value);
  $("roomPreview").textContent = room || "—";
});

$("type").addEventListener("change", () => {
  const esUnica = $("type").value === "unica";
  $("weekdayLabel").classList.toggle("hidden", esUnica);
  $("dateLabel").classList.toggle("hidden", !esUnica);
  $("date").required = esUnica;
});

$("classForm").addEventListener("submit", async event => {
  event.preventDefault();

  const email = $("teacherEmail").value.trim().toLowerCase();
  const room = personalRoomFor(email);
  if (!room) return toast("Falta el correo del docente.");

  const tipo = $("type").value;
  const clase = {
    type: tipo,
    teacherEmail: email,
    studentName: $("studentName").value.trim(),
    start: $("start").value,
    duration: Number($("duration").value) || 45,
    active: true,
    createdBy: auth.currentUser?.email || "",
    createdAt: Date.now()
  };
  if (tipo === "semanal") {
    clase.weekday = Number($("weekday").value);
  } else {
    if (!$("date").value) return toast("Elige la fecha de la clase.");
    clase.date = $("date").value;
  }

  try {
    const nodo = push(ref(db, `agenda/${room}`));
    await set(nodo, clase);
    toast("Clase agendada. El aula se abrirá 5 minutos antes.");
    $("studentName").value = "";
    cargar();
  } catch (error) {
    console.error(error);
    toast("No se pudo guardar: " + (error?.code || error));
  }
});

$("refresh").addEventListener("click", cargar);
$("filter").addEventListener("input", pintar);

/* ===== Listado ===== */

async function cargar() {
  $("list").textContent = "Cargando…";
  try {
    const snap = await get(ref(db, "agenda"));
    const data = snap.val() || {};
    clases = [];
    for (const [room, porSala] of Object.entries(data)) {
      for (const [id, clase] of Object.entries(porSala || {})) {
        if (clase) clases.push({ room, id, ...clase });
      }
    }
    pintar();
  } catch (error) {
    console.error(error);
    $("list").textContent = "No se pudo leer la agenda: " + (error?.code || error);
  }
}

function enlaceEstudiante(room) {
  const url = new URL("./index.html", location.href);
  url.searchParams.set("room", room);
  url.searchParams.set("role", "estudiante");
  return url.toString();
}

function pintar() {
  const filtro = $("filter").value.trim().toLowerCase();
  const visibles = clases.filter(c =>
    !filtro ||
    (c.teacherEmail || "").toLowerCase().includes(filtro) ||
    (c.studentName || "").toLowerCase().includes(filtro)
  );

  if (!visibles.length) {
    $("list").textContent = clases.length
      ? "Ninguna clase coincide con el filtro."
      : "Todavía no hay clases agendadas.";
    return;
  }

  const ahora = Date.now();
  visibles.sort((a, b) => (a.teacherEmail || "").localeCompare(b.teacherEmail || ""));

  $("list").innerHTML = visibles.map(c => {
    const cuando = c.type === "semanal"
      ? `Cada ${nombreDia(c.weekday)} a las ${c.start}`
      : `${c.date} a las ${c.start}`;
    const proxima = proximaOcurrencia(c, ahora);
    const siguiente = proxima ? `Próxima: ${textoCuando(proxima)}` : "Sin próximas fechas";
    return `
      <article class="agenda-item">
        <div>
          <strong>${escapeHtml(c.studentName || "Sin nombre")}</strong>
          <span class="agenda-chip">${escapeHtml(c.teacherEmail || "")}</span>
        </div>
        <p class="hint">${escapeHtml(cuando)} · ${c.duration} min · ${escapeHtml(siguiente)}</p>
        <p class="hint">Aula: <code>${escapeHtml(c.room)}</code></p>
        <div class="actions wrap">
          <button class="secondary tiny" data-link="${escapeHtml(c.room)}">Copiar enlace del estudiante</button>
          <button class="danger tiny" data-del="${escapeHtml(c.room)}|${escapeHtml(c.id)}">Eliminar</button>
        </div>
      </article>
    `;
  }).join("");

  $("list").querySelectorAll("[data-link]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const link = enlaceEstudiante(btn.dataset.link);
      try {
        await navigator.clipboard.writeText(link);
        toast("Enlace copiado. Sirve para todas las clases con ese docente.");
      } catch {
        prompt("Enlace para el estudiante:", link);
      }
    });
  });

  $("list").querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const [room, id] = btn.dataset.del.split("|");
      if (!confirm("¿Eliminar esta clase de la agenda?")) return;
      try {
        await remove(ref(db, `agenda/${room}/${id}`));
        toast("Clase eliminada.");
        cargar();
      } catch (error) {
        toast("No se pudo eliminar: " + (error?.code || error));
      }
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
