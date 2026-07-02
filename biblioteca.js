// Biblioteca de recursos Musicala: lectura de la colección "recursos" del
// proyecto Firebase de la biblioteca (independiente del proyecto del aula).
// Las reglas de Firestore de ese proyecto permiten lectura pública; solo los
// admins escriben desde el Manager de la biblioteca.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Config pública del proyecto de la biblioteca (la seguridad son sus reglas).
const bibliotecaConfig = {
  apiKey: "AIzaSyD8p1Ges94PMBPE-wuFVjeE5uGzeUQYBS0",
  authDomain: "biblioteca-guitarra-fa182.firebaseapp.com",
  projectId: "biblioteca-guitarra-fa182",
  storageBucket: "biblioteca-guitarra-fa182.firebasestorage.app",
  messagingSenderId: "803045423554",
  appId: "1:803045423554:web:9bd5bda0d45f9e33f07e5b",
};

const CACHE_KEY = "musiaula_biblioteca_v1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

let firestoreDb = null;

function db() {
  if (!firestoreDb) {
    // Nombre propio para no chocar con la app Firebase del aula.
    firestoreDb = getFirestore(initializeApp(bibliotecaConfig, "biblioteca"));
  }
  return firestoreDb;
}

// Versión recortada de cada recurso: suficiente para buscar, mostrar y
// proyectar, y lo bastante liviana para caber en localStorage.
function trimItem(id, data) {
  return {
    id,
    titulo: data.titulo || "(sin título)",
    descripcion: String(data.descripcion || "").slice(0, 400),
    area: data.area || "",
    tema: data.tema || "",
    tipo: data.tipo || "",
    disciplina: data.disciplina || "",
    especialidad: data.especialidad || "",
    categoria: data.categoria || "",
    nivel: data.nivel || "",
    etiquetas: Array.isArray(data.etiquetas) ? data.etiquetas.slice(0, 10) : [],
    enlaces: (Array.isArray(data.enlaces) ? data.enlaces : [])
      .filter(l => l && l.url)
      .map(l => ({
        titulo: l.titulo || "",
        url: l.url,
        tipo: l.tipo || "",
        thumbnail: l.thumbnail || ""
      }))
  };
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items) || !parsed.at) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(items, at) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at, items }));
  } catch (error) {
    // localStorage lleno: la biblioteca funciona igual, solo sin caché.
    console.warn("No se pudo guardar la biblioteca en caché", error);
  }
}

// Descarga (o recupera de caché) todos los recursos publicados.
// Devuelve { items, fromCache, at }.
export async function loadBiblioteca({ force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { items: cached.items, fromCache: true, at: cached.at };
    }
  }

  const snap = await getDocs(
    query(collection(db(), "recursos"), where("estado", "==", "publicado"))
  );
  const items = snap.docs
    .map(docSnap => trimItem(docSnap.id, docSnap.data()))
    .sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));

  const at = Date.now();
  writeCache(items, at);
  return { items, fromCache: false, at };
}
