// Panel de coordinación: agendar las clases que abren las aulas.
// Solo entran los cuatro correos de ADMIN_EMAILS; la lista se repite en las
// reglas de la base de datos, que son las que de verdad lo impiden.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, get, set, remove, push } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { personalRoomFor, isAdminEmail, ADMIN_EMAILS } from "./sala.js?v=1";
import { nombreDia, textoCuando, proximaOcurrencia } from "./agenda-core.js?v=1";
import {
  hubAuth, onHubUser, signInHub, listTeachers, saveTeacher, removeTeacher
} from "./docentes-hub.js?v=4";

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

  const contador = $("classCount");
  if (contador) contador.textContent = String(clases.length);

  if (!visibles.length) {
    $("list").innerHTML = clases.length
      ? `<div class="agenda-empty"><span>🔍</span><p>Ninguna clase coincide con «${escapeHtml($("filter").value.trim())}».</p></div>`
      : `<div class="agenda-empty"><span>🗓️</span><p><strong>Todavía no hay clases agendadas.</strong></p>
         <p class="hint">Llena el formulario de la izquierda. Recuerda: un aula sin clases agendadas está cerrada, así que sin esto nadie puede entrar.</p></div>`;
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
    const activa = proxima !== null;
    return `
      <article class="agenda-item${activa ? "" : " inactiva"}">
        <header class="agenda-item-head">
          <div>
            <strong class="agenda-student">${escapeHtml(c.studentName || "Sin nombre")}</strong>
            <p class="agenda-when">${escapeHtml(cuando)} · ${c.duration} min</p>
          </div>
          <span class="agenda-next ${activa ? "on" : ""}">${escapeHtml(siguiente)}</span>
        </header>
        <dl class="agenda-meta">
          <div><dt>Docente</dt><dd>${escapeHtml(c.teacherEmail || "—")}</dd></div>
          <div><dt>Aula</dt><dd><code>${escapeHtml(c.room)}</code></dd></div>
        </dl>
        <div class="actions wrap">
          <button class="secondary tiny" data-observe="${escapeHtml(c.room)}">👁️ Observar</button>
          <button class="secondary tiny" data-link="${escapeHtml(c.room)}">🔗 Copiar enlace</button>
          <button class="danger tiny" data-del="${escapeHtml(c.room)}|${escapeHtml(c.id)}">Eliminar</button>
        </div>
      </article>
    `;
  }).join("");

  // Entrar a mirar la clase sin cámara ni micrófono, en otra pestaña para no
  // perder el panel.
  $("list").querySelectorAll("[data-observe]").forEach(btn => {
    btn.addEventListener("click", () => {
      const url = new URL("./index.html", location.href);
      url.searchParams.set("room", btn.dataset.observe);
      url.searchParams.set("role", "observador");
      window.open(url.toString(), "_blank", "noopener");
    });
  });

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


/* ===== Pestañas del panel ===== */

document.querySelectorAll(".agenda-tabs .tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".agenda-tabs .tab").forEach(t => t.classList.toggle("active", t === tab));
    $("panelClases").classList.toggle("hidden", tab.dataset.panel !== "panelClases");
    $("panelDocentes").classList.toggle("hidden", tab.dataset.panel !== "panelDocentes");
    if (tab.dataset.panel === "panelDocentes") cargarDocentes();
  });
});

/* ===== Docentes autorizados =====
   Viven en el Hub de Docentes, que es OTRO proyecto Firebase: la sesión de
   MusiAula no vale allá. Sus reglas ya permiten escribir teacherDirectory a
   los mismos cuatro correos, así que solo hay que iniciar sesión también
   en el Hub. */

let hubListo = false;

onHubUser(user => {
  hubListo = !!user && isAdminEmail(user.email);
  $("hubGate").classList.toggle("hidden", hubListo);
  $("teacherForm").classList.toggle("hidden", !hubListo);
  if (hubListo) cargarDocentes();
});

$("hubLogin").addEventListener("click", async () => {
  try {
    const user = await signInHub();
    if (!isAdminEmail(user.email)) {
      toast(`${user.email} no puede administrar docentes.`);
      return;
    }
    toast("Conectado al Hub.");
  } catch (error) {
    toast("No se pudo conectar al Hub: " + (error?.code || error));
  }
});

$("newTeacherEmail").addEventListener("input", pintarAulaNueva);
$("newTeacherSlug").addEventListener("input", pintarAulaNueva);

function pintarAulaNueva() {
  const slug = $("newTeacherSlug").value.trim();
  const room = personalRoomFor($("newTeacherEmail").value, slug ? { salaSlug: slug } : null);
  $("newTeacherRoom").textContent = room || "—";
}

$("teacherForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("newTeacherEmail").value.trim().toLowerCase();
  if (!email) return;

  const datos = { enabled: true, updatedBy: hubAuth().currentUser?.email || "", updatedAt: Date.now() };
  const nombre = $("newTeacherName").value.trim();
  const slug = $("newTeacherSlug").value.trim();
  if (nombre) datos.name = nombre;
  if (slug) datos.salaSlug = slug;

  try {
    await saveTeacher(email, datos);
    toast(`${email} ya puede entrar como docente.`);
    $("newTeacherEmail").value = "";
    $("newTeacherName").value = "";
    $("newTeacherSlug").value = "";
    pintarAulaNueva();
    cargarDocentes();
  } catch (error) {
    console.error(error);
    toast("No se pudo guardar: " + (error?.code || error));
  }
});

async function cargarDocentes() {
  const cont = $("teacherList");
  cont.textContent = "Cargando…";
  try {
    const docentes = await listTeachers();
    if (!docentes.length) {
      cont.textContent = "Todavía no hay docentes autorizados.";
      return;
    }
    docentes.sort((a, b) => a.email.localeCompare(b.email));
    cont.innerHTML = docentes.map(d => {
      const activo = d.enabled !== false;
      const room = personalRoomFor(d.email, d);
      return `
        <article class="agenda-item">
          <div>
            <strong>${escapeHtml(d.name || d.email)}</strong>
            <span class="agenda-chip">${activo ? "Activo" : "Inhabilitado"}</span>
          </div>
          <p class="hint">${escapeHtml(d.email)}</p>
          <p class="hint">Aula: <code>${escapeHtml(room)}</code></p>
          <div class="actions wrap">
            <button class="secondary tiny" data-toggle="${escapeHtml(d.email)}" data-next="${activo ? "0" : "1"}">
              ${activo ? "Inhabilitar" : "Reactivar"}
            </button>
            <button class="danger tiny" data-remove="${escapeHtml(d.email)}">Quitar</button>
          </div>
        </article>
      `;
    }).join("");

    cont.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await saveTeacher(btn.dataset.toggle, { enabled: btn.dataset.next === "1" });
          toast("Listo.");
          cargarDocentes();
        } catch (error) {
          toast("No se pudo cambiar: " + (error?.code || error));
        }
      });
    });

    cont.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`¿Quitar a ${btn.dataset.remove} del directorio de docentes?`)) return;
        try {
          await removeTeacher(btn.dataset.remove);
          toast("Docente retirado.");
          cargarDocentes();
        } catch (error) {
          toast("No se pudo quitar: " + (error?.code || error));
        }
      });
    });
  } catch (error) {
    console.error(error);
    cont.textContent = "No se pudo leer el directorio: " + (error?.code || error);
  }
}
