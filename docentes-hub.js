// Autorización de docentes contra el proyecto "musicala-docentes-hub".
// MusiAula sigue en su propio proyecto Firebase (Realtime Database + login
// anónimo para estudiantes), pero solo puede entrar como DOCENTE quien esté
// registrado en el directorio del Hub (teacherDirectory, lectura pública).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

// Config pública del Hub (la seguridad son sus reglas de Firestore).
const hubConfig = {
  apiKey: "AIzaSyC06dLl2Lig3-kD4OVmh4C9LpFW9AeTyOc",
  authDomain: "musicala-docentes-hub.firebaseapp.com",
  projectId: "musicala-docentes-hub",
  storageBucket: "musicala-docentes-hub.firebasestorage.app",
  messagingSenderId: "936379833270",
  appId: "1:936379833270:web:512519cf318c919e3abf17"
};

let hubDb = null;

function db() {
  if (!hubDb) {
    // Nombre propio para no chocar con las apps Firebase del aula y la biblioteca.
    hubDb = getFirestore(initializeApp(hubConfig, "docentes-hub"));
  }
  return hubDb;
}

const CACHE_KEY = "musiaula_docente_autorizado_v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas: evita esperar al Hub en cada entrada

// ¿Este correo está autorizado como docente en el Hub?
// Devuelve { ok, reason }. Si el Hub no responde (sin red, reglas cambiadas),
// deja pasar con aviso: una clase no se puede caer por el verificador.
export async function isAuthorizedTeacher(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return { ok: false, reason: "sin-email" };

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached?.email === normalized && Date.now() - cached.at < CACHE_TTL_MS && cached.ok) {
      return { ok: true, reason: "cache", data: cached.data || null };
    }
  } catch {}

  try {
    const snap = await getDoc(doc(db(), "teacherDirectory", normalized));
    const data = snap.exists() ? snap.data() : null;
    const ok = snap.exists() && data?.enabled !== false;
    if (ok) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ email: normalized, ok: true, at: Date.now(), data })); } catch {}
    }
    return { ok, reason: ok ? "directorio" : "no-registrado", data };
  } catch (error) {
    console.warn("No se pudo verificar el docente contra el Hub", error);
    return { ok: true, reason: "sin-verificar", data: null };
  }
}


/* ===== Administración del directorio de docentes =====
   Las reglas del Hub ya permiten escribir teacherDirectory a los cuatro
   correos de coordinación (isAdminReader), así que aquí no hace falta tocar
   ninguna regla: solo faltaba la interfaz.

   Ojo: el Hub es otro proyecto Firebase. La sesión de MusiAula no sirve
   allá, hay que iniciar sesión también en el Hub para que sus reglas vean
   el correo de quien escribe. */

let hubAuthInstance = null;

export function hubAuth() {
  if (!hubAuthInstance) {
    hubAuthInstance = getAuth(initializeApp(hubConfig, "docentes-hub"));
  }
  return hubAuthInstance;
}

export function onHubUser(callback) {
  return onAuthStateChanged(hubAuth(), callback);
}

export async function signInHub() {
  const provider = new GoogleAuthProvider();
  // Fuerza el selector de cuenta: quien administra suele tener varias.
  provider.setCustomParameters({ prompt: "select_account" });
  const cred = await signInWithPopup(hubAuth(), provider);
  return cred.user;
}

export async function listTeachers() {
  const snap = await getDocs(collection(db(), "teacherDirectory"));
  return snap.docs.map(d => ({ email: d.id, ...d.data() }));
}

export async function saveTeacher(email, data) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw new Error("Falta el correo");
  await setDoc(doc(db(), "teacherDirectory", normalized), data, { merge: true });
  // El aula cachea la autorización 6 horas; al cambiar algo se limpia para
  // que el docente no tenga que esperar a que venza.
  try { localStorage.removeItem(CACHE_KEY); } catch {}
  return normalized;
}

export async function removeTeacher(email) {
  const normalized = String(email || "").trim().toLowerCase();
  await deleteDoc(doc(db(), "teacherDirectory", normalized));
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

/* ===== Sugerencias de correo en el inicio de sesión =====
   Escribir el correo completo en el celular es lo más molesto de entrar.
   El campo de correo ofrece ahora la lista del directorio del Hub (correo y
   nombre) y, además, recuerda los correos que ya entraron en este equipo,
   por si el Hub no responde o alguien todavía no está en el directorio. */

const DIR_CACHE_KEY = "musiaula_directorio_docentes_v1";
const DIR_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const RECIENTES_KEY = "musiaula_correos_recientes_v1";
const MAX_RECIENTES = 8;

function leer(clave, porDefecto) {
  try { return JSON.parse(localStorage.getItem(clave) || "null") ?? porDefecto; }
  catch { return porDefecto; }
}

function correosRecientes() {
  const lista = leer(RECIENTES_KEY, []);
  return Array.isArray(lista) ? lista : [];
}

// Guarda un correo que sí entró, para ofrecerlo la próxima vez.
export function recordarCorreo(email, name) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return;
  const resto = correosRecientes().filter(d => d.email !== normalized);
  const lista = [{ email: normalized, name: name || "" }, ...resto].slice(0, MAX_RECIENTES);
  try { localStorage.setItem(RECIENTES_KEY, JSON.stringify(lista)); } catch {}
}

// Devuelve [{ email, name }] mezclando directorio del Hub y recordados aquí.
// Nunca lanza: si el Hub no contesta, quedan al menos los de este equipo.
export async function sugerenciasDeCorreo() {
  let directorio = [];
  const cache = leer(DIR_CACHE_KEY, null);
  if (cache && Date.now() - cache.at < DIR_TTL_MS && Array.isArray(cache.lista)) {
    directorio = cache.lista;
  } else {
    try {
      directorio = (await listTeachers())
        .filter(d => d.enabled !== false)
        .map(d => ({ email: d.email, name: d.name || "" }));
      try {
        localStorage.setItem(DIR_CACHE_KEY, JSON.stringify({ at: Date.now(), lista: directorio }));
      } catch {}
    } catch (error) {
      console.warn("No se pudo leer el directorio de docentes", error);
      directorio = Array.isArray(cache?.lista) ? cache.lista : [];
    }
  }

  const porCorreo = new Map();
  [...directorio, ...correosRecientes()].forEach(d => {
    const email = String(d?.email || "").trim().toLowerCase();
    if (!email) return;
    const previo = porCorreo.get(email);
    porCorreo.set(email, { email, name: d.name || previo?.name || "" });
  });
  return [...porCorreo.values()].sort((a, b) =>
    (a.name || a.email).localeCompare(b.name || b.email, "es"));
}
