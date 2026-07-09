// Autorización de docentes contra el proyecto "musicala-docentes-hub".
// MusiAula sigue en su propio proyecto Firebase (Realtime Database + login
// anónimo para estudiantes), pero solo puede entrar como DOCENTE quien esté
// registrado en el directorio del Hub (teacherDirectory, lectura pública).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

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
      return { ok: true, reason: "cache" };
    }
  } catch {}

  try {
    const snap = await getDoc(doc(db(), "teacherDirectory", normalized));
    const ok = snap.exists() && snap.data()?.enabled !== false;
    if (ok) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ email: normalized, ok: true, at: Date.now() })); } catch {}
    }
    return { ok, reason: ok ? "directorio" : "no-registrado" };
  } catch (error) {
    console.warn("No se pudo verificar el docente contra el Hub", error);
    return { ok: true, reason: "sin-verificar" };
  }
}
