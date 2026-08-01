import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase, ref, set, update, push, remove, get,
  onValue, onChildAdded, onDisconnect, query, limitToLast
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup, signInAnonymously,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { loadBiblioteca } from "./biblioteca.js?v=4";
import { isAuthorizedTeacher } from "./docentes-hub.js?v=1";

const NOTES = ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"];
const STORAGE_KEY = "musiaula_prototipo_v2";

// TURN de respaldo: cuando la red del estudiante (datos móviles, WiFi de
// colegio) bloquea la conexión directa, el audio/video viaja por este relé
// en vez de caerse. Para activarlo: crear cuenta gratis en
// https://dashboard.metered.ca/signup (0,5 GB/mes gratis) o en Cloudflare
// Calls, copiar las URLs y credenciales del panel y pegarlas aquí.
const TURN_SERVER = {
  urls: [
    "turn:standard.relay.metered.ca:80",
    "turn:standard.relay.metered.ca:80?transport=tcp",
    "turn:standard.relay.metered.ca:443",
    "turns:standard.relay.metered.ca:443?transport=tcp"
  ],
  username: "bf961b913a6313d442e27725",
  credential: "lgFN2S3/nYFP5yyb"
};

const RTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    // Solo se incluye el TURN si ya tiene credenciales configuradas.
    ...(TURN_SERVER.urls.length && TURN_SERVER.username ? [TURN_SERVER] : [])
  ],
  // Con más candidatos (directos + relé) el navegador elige el mejor camino.
  iceCandidatePoolSize: 4
};

const defaultResources = [
  {
    id: cryptoId(),
    title: "Mapa de notas naturales",
    desc: "Do → Re → Mi → Fa → Sol → La → Si → Do. Úsalo para ubicar la secuencia circular desde cualquier punto."
  },
  {
    id: cryptoId(),
    title: "Ejercicio vocal hablado",
    desc: "Decir la secuencia primero hablando, luego con pulso, luego cantando. Sí, paso a paso, esa tecnología ancestral."
  },
  {
    id: cryptoId(),
    title: "Reto de cambio de inicio",
    desc: "El profe dice una nota inicial y el estudiante continúa la secuencia hasta volver a la misma nota."
  }
];

const dom = {};
let db = null;
let auth = null;
let currentUser = null;
let firebaseReady = false;
let roomPath = null;
let presenceRef = null;
let participantsCount = 0;
let unsubscribers = [];
let pendingAutoJoin = null;

// Malla WebRTC: una conexión por pareja de participantes.
// clientId -> { pc, name, stream, tile, videoEl, audioNode, pendingCandidates }
let peers = new Map();
let lastParticipants = {}; // último snapshot de presencia, para reconectar
let localStream = null;
let screenStream = null;
let micOn = true;
let camOn = true;
let musicMode = localStorage.getItem("musiaula-music-mode") === "1";
let speakerOn = true; // en móvil el audio debe salir por el altavoz, no por el auricular
let audioOutputs = [];
let audioOutputIndex = 0;
let statsTimer = null;

let audioContext = null;
let stageTimer = null;
let answeredQuizIds = new Set();

// Metrónomo sincronizado: estado compartido + reloj del servidor
let serverTimeOffset = 0;
let metro = null;            // { running, bpm, meter, startAt } (startAt en tiempo de servidor)
let metroSchedulerTimer = null;
let metroNextBeat = 0;       // índice del próximo pulso a agendar
let pulseTapsUnsub = null;

// Identificador único de este dispositivo para ignorar mis propios eventos
// al transmitir lo que toco en los instrumentos.
const CLIENT_ID = cryptoId();
let instrumentPlaySince = 0;

// Biblioteca Musicala (solo lado docente; se carga al abrir la pestaña Recursos)
let biblioItems = [];
let biblioLoading = false;
let biblioLoaded = false;
let biblioVisible = 30; // cuántos resultados filtrados se muestran

let appState = {
  room: "",
  displayName: "",
  role: "docente",
  classMode: "musica", // "musica" | "danza": cambia herramientas y prioridad de audio
  objective: "",
  activeResource: null,
  activeExercise: null,
  stage: null,
  resources: defaultResources,
  responses: [],
  logs: []
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  bindDom();
  loadLocal();

  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    auth = getAuth(app);
    firebaseReady = true;
  } catch (error) {
    console.error("No se pudo inicializar Firebase", error);
    toast("Error al conectar con Firebase. Revisa firebase-config.js.");
  }

  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  const nameParam = params.get("name");
  const roleParam = params.get("role");

  dom.roomName.value = roomParam || makeRoomName();
  dom.displayName.value = nameParam || appState.displayName || "";
  dom.role.value = roleParam || appState.role || "docente";
  dom.classMode.value = appState.classMode === "danza" ? "danza" : "musica";

  setupEvents();
  renderAll();

  if (roomParam) {
    pendingAutoJoin = { room: roomParam, name: nameParam, role: roleParam };
  }

  if (!auth) return;

  onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) {
      dom.authGate.classList.add("hidden");
      dom.userBadge.textContent = `Sesión: ${user.email || user.displayName || "usuario"}`;
      if (!dom.displayName.value && user.displayName) {
        dom.displayName.value = user.displayName;
      }
      // Reloj del servidor para el metrónomo sincronizado
      onValue(ref(db, ".info/serverTimeOffset"), snap => {
        serverTimeOffset = snap.val() || 0;
      });

      if (pendingAutoJoin) {
        const { room, name, role } = pendingAutoJoin;
        pendingAutoJoin = null;
        enterClass({
          room,
          displayName: name || user.displayName || dom.displayName.value || "Estudiante",
          role: role || "estudiante"
        });
      } else if (dom.app.classList.contains("hidden")) {
        dom.lobby.classList.remove("hidden");
      }
    } else if (pendingAutoJoin) {
      // Invitado por enlace: entra sin login con sesión anónima y se conecta de una.
      dom.authGate.classList.add("hidden");
      signInAnonymously(auth).catch(error => {
        console.error("No se pudo iniciar sesión anónima", error);
        dom.authGate.classList.remove("hidden");
        toast("Habilita el acceso anónimo en Firebase (Authentication → Sign-in method → Anónimo).");
      });
    } else {
      dom.authGate.classList.remove("hidden");
      dom.lobby.classList.add("hidden");
      dom.app.classList.add("hidden");
    }
  });
}

/* ===== Autenticación ===== */

const AUTH_ERRORS = {
  "auth/invalid-email": "El correo no es válido.",
  "auth/user-not-found": "No existe una cuenta con ese correo. Usa «Crear cuenta nueva».",
  "auth/wrong-password": "Contraseña incorrecta.",
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/email-already-in-use": "Ya existe una cuenta con ese correo. Inicia sesión.",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "auth/popup-closed-by-user": "Cerraste la ventana de Google antes de terminar.",
  "auth/too-many-requests": "Demasiados intentos. Espera un momento y vuelve a intentar.",
  "auth/operation-not-allowed": "Este método de acceso no está habilitado en Firebase (Authentication → Sign-in method)."
};

function authError(error) {
  console.warn("Auth error", error);
  toast(AUTH_ERRORS[error?.code] || "No se pudo iniciar sesión. Intenta de nuevo.");
}

function setupAuthEvents() {
  dom.googleLogin.addEventListener("click", () => {
    signInWithPopup(auth, new GoogleAuthProvider()).catch(authError);
  });

  dom.emailForm.addEventListener("submit", event => {
    event.preventDefault();
    signInWithEmailAndPassword(auth, dom.authEmail.value.trim(), dom.authPassword.value)
      .catch(authError);
  });

  dom.registerBtn.addEventListener("click", () => {
    const email = dom.authEmail.value.trim();
    const password = dom.authPassword.value;
    if (!email || password.length < 6) {
      toast("Escribe tu correo y una contraseña de mínimo 6 caracteres.");
      return;
    }
    createUserWithEmailAndPassword(auth, email, password)
      .then(() => toast("Cuenta creada. ¡Bienvenido a Musicala! 🎵"))
      .catch(authError);
  });

  dom.resetPassword.addEventListener("click", () => {
    const email = dom.authEmail.value.trim();
    if (!email) {
      toast("Escribe tu correo arriba y vuelve a tocar aquí.");
      return;
    }
    sendPasswordResetEmail(auth, email)
      .then(() => toast("Te enviamos un correo para restablecer la contraseña."))
      .catch(authError);
  });

  dom.logoutBtn.addEventListener("click", () => {
    signOut(auth).then(() => toast("Sesión cerrada."));
  });
}

function bindDom() {
  [
    "toast", "lobby", "app", "joinForm", "displayName", "role", "classMode", "roomName", "randomRoom",
    "btnShareMusic", "danceMusicVol",
    "copyLobbyLink", "roomTitle", "connectionStatus", "copyClassLink",
    "leaveClass", "objectiveInput", "publishObjective", "objectiveView",
    "activeResourceTitle", "activeResourceDesc", "activeExerciseTitle", "activeExerciseBody",
    "responsesList", "resourceList", "addResource", "resourceTitle", "resourceDesc",
    "createResource", "rootNote", "exerciseMode", "scalePreview", "previewScale",
    "launchScale", "bpm", "toggleMetronome", "beatIndicator", "workedOn", "progress",
    "homework", "saveLog", "exportLog", "clearLocal", "classLogList", "sendState",
    "stageArea", "stageNote", "btnStageNote", "btnStageSeq", "btnStageQuiz",
    "btnStagePulse", "btnStageCelebrate", "btnStageClear",
    "btnStagePiano", "btnStageGuitar", "btnStageViolin", "btnStageDrums",
    "btnStageSimon", "btnStageEar", "btnStageMatch", "btnStageCountdown",
    "videoArea", "videoGrid", "remotePlaceholder", "localVideo",
    "toggleMic", "toggleCam", "toggleMusicMode", "toggleSpeaker", "toggleStats", "statsPanel", "reconnectVideo", "reloadClass",
    "shareScreen", "biblioRefresh", "biblioStatus", "biblioSearch", "biblioArea",
    "biblioCategoria", "biblioNivel", "biblioList", "biblioMore",
    "chatForm", "chatInput",
    "authGate", "googleLogin", "emailForm", "authEmail", "authPassword",
    "registerBtn", "resetPassword", "logoutBtn", "userBadge",
    "metroChip", "metroStateText", "beatIndicatorAula", "meter"
  ].forEach(id => dom[id] = document.getElementById(id));

  dom.tabs = Array.from(document.querySelectorAll(".tab"));
  dom.quickResponses = Array.from(document.querySelectorAll("[data-response]"));
}

function setupEvents() {
  setupAuthEvents();

  // El audio (altavoz remoto + metrónomo) necesita un gesto para arrancar en móvil.
  const resumeAudio = () => ensureAudio();
  document.addEventListener("pointerdown", resumeAudio);
  document.addEventListener("touchstart", resumeAudio, { passive: true });

  // Al volver a la pestaña, el sistema ya soltó el wake lock: lo pedimos de nuevo.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && localStream) keepScreenAwake();
  });

  dom.joinForm.addEventListener("submit", event => {
    event.preventDefault();
    enterClass({
      room: normalizeRoom(dom.roomName.value),
      displayName: dom.displayName.value.trim(),
      role: dom.role.value
    });
  });

  dom.randomRoom.addEventListener("click", () => {
    dom.roomName.value = makeRoomName();
    toast("Sala aleatoria creada. Copia el enlace para el otro dispositivo.");
  });

  dom.copyLobbyLink.addEventListener("click", () => copyLink());
  dom.copyClassLink.addEventListener("click", () => copyLink());

  dom.leaveClass.addEventListener("click", leaveClass);

  dom.tabs.forEach(tab => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  dom.publishObjective.addEventListener("click", () => {
    appState.objective = dom.objectiveInput.value.trim();
    saveLocal();
    renderAula();
    syncPatch({ objective: appState.objective });
    toast("Objetivo publicado.");
  });

  dom.sendState.addEventListener("click", () => {
    syncFullState();
    toast("Estado enviado a la sala.");
  });

  dom.addResource.addEventListener("click", () => {
    const demo = {
      id: cryptoId(),
      title: "Recurso demo " + (appState.resources.length + 1),
      desc: "Describe aquí una consigna, enlace o material. Esto queda local y puede activarse en la clase."
    };
    appState.resources.unshift(demo);
    saveLocal();
    renderResources();
    syncPatch({ resources: appState.resources });
  });

  dom.createResource.addEventListener("click", () => {
    const title = dom.resourceTitle.value.trim();
    const desc = dom.resourceDesc.value.trim();

    if (!title) {
      toast("Ponle título al recurso, tampoco le pidamos telepatía al prototipo.");
      return;
    }

    const resource = { id: cryptoId(), title, desc: desc || "Sin descripción." };
    appState.resources.unshift(resource);
    dom.resourceTitle.value = "";
    dom.resourceDesc.value = "";
    saveLocal();
    renderResources();
    syncPatch({ resources: appState.resources });
    toast("Recurso guardado.");
  });

  dom.previewScale.addEventListener("click", renderScalePreview);
  dom.rootNote.addEventListener("change", renderScalePreview);
  dom.exerciseMode.addEventListener("change", renderScalePreview);

  dom.launchScale.addEventListener("click", () => {
    const exercise = buildScaleExercise();
    appState.activeExercise = exercise;
    saveLocal();
    renderAula();
    syncPatch({ activeExercise: exercise });
    toast("Ejercicio lanzado.");
  });

  dom.toggleMetronome.addEventListener("click", () => {
    if (metro?.running) {
      stopSharedMetronome();
    } else {
      startSharedMetronome();
    }
  });

  dom.bpm.addEventListener("change", () => {
    if (metro?.running) startSharedMetronome(); // reinicia con el nuevo BPM
  });

  dom.meter.addEventListener("change", () => {
    if (metro?.running) startSharedMetronome();
  });

  dom.quickResponses.forEach(button => {
    button.addEventListener("click", () => {
      sendResponse(button.dataset.response);
    });
  });

  dom.chatForm.addEventListener("submit", event => {
    event.preventDefault();
    const text = dom.chatInput.value.trim();
    if (!text) return;
    sendResponse(text);
    dom.chatInput.value = "";
    dom.chatInput.focus();
  });

  dom.saveLog.addEventListener("click", () => {
    const log = {
      id: cryptoId(),
      at: new Date().toISOString(),
      room: appState.room,
      workedOn: dom.workedOn.value.trim(),
      progress: dom.progress.value.trim(),
      homework: dom.homework.value.trim()
    };

    if (!log.workedOn && !log.progress && !log.homework) {
      toast("Escribe algo en la bitácora. Una bitácora vacía es básicamente decoración.");
      return;
    }

    appState.logs.unshift(log);
    dom.workedOn.value = "";
    dom.progress.value = "";
    dom.homework.value = "";
    saveLocal();
    renderLogs();
    toast("Entrada guardada localmente.");
  });

  dom.exportLog.addEventListener("click", exportJson);
  dom.clearLocal.addEventListener("click", clearLocalData);

  dom.btnStageNote.addEventListener("click", () => {
    launchStage({ kind: "bigNote", note: dom.stageNote.value });
    toast("Nota gigante en pantalla de todos.");
  });

  dom.btnStageSeq.addEventListener("click", () => {
    const exercise = buildScaleExercise();
    launchStage({
      kind: "sequence",
      title: exercise.title,
      sequence: exercise.sequence,
      bpm: Math.max(40, Math.min(240, Number(dom.bpm.value) || 80))
    });
    toast("Secuencia animada lanzada.");
  });

  dom.btnStageQuiz.addEventListener("click", () => {
    const root = dom.rootNote.value;
    const index = NOTES.indexOf(root);
    const correct = NOTES[(index + 1) % NOTES.length];
    launchStage({
      kind: "quiz",
      question: `¿Qué nota sigue después de ${root}?`,
      options: [...NOTES],
      correct
    });
    toast("Juego lanzado. Espera la respuesta del estudiante.");
  });

  dom.btnStagePulse.addEventListener("click", () => {
    if (!metro?.running) startSharedMetronome();
    launchStage({
      kind: "pulse",
      title: "Marca el pulso 🥁",
      taps: 16
    });
    toast("Juego de pulso lanzado. El estudiante debe tocar al ritmo del metrónomo.");
  });

  dom.btnStageCelebrate.addEventListener("click", () => {
    launchStage({ kind: "celebrate" });
    toast("🎉 Celebración enviada.");
  });

  dom.btnStagePiano.addEventListener("click", () => {
    launchStage({ kind: "instrument", instrument: "piano", title: "Piano 🎹" });
    toast("Piano en pantalla del estudiante. ¡Suena al tocarlo!");
  });

  dom.btnStageGuitar.addEventListener("click", () => {
    launchStage({ kind: "instrument", instrument: "guitar", title: "Guitarra 🎸" });
    toast("Diagrama de guitarra lanzado. Toca las cuerdas y trastes.");
  });

  dom.btnStageViolin.addEventListener("click", () => {
    launchStage({ kind: "instrument", instrument: "violin", title: "Violín 🎻" });
    toast("Diagrama de violín lanzado.");
  });

  dom.btnStageDrums.addEventListener("click", () => {
    launchStage({ kind: "instrument", instrument: "drums", title: "Batería 🥁" });
    toast("Batería en pantalla. ¡Toca los tambores!");
  });

  dom.btnStageSimon.addEventListener("click", () => {
    launchStage({ kind: "simon", title: "Simón dice 🎵" });
    toast("Juego de memoria lanzado. El estudiante repite la secuencia.");
  });

  dom.btnStageEar.addEventListener("click", () => {
    const note = NOTES[Math.floor(Math.random() * NOTES.length)];
    launchStage({ kind: "earQuiz", note, options: [...NOTES] });
    toast("Juego de oído lanzado. El estudiante adivina la nota que suena.");
  });

  dom.btnStageMatch.addEventListener("click", () => {
    launchStage({ kind: "match", title: "Pares musicales 🃏" });
    toast("Juego de memoria de sonidos lanzado.");
  });

  dom.btnStageCountdown.addEventListener("click", () => {
    launchStage({ kind: "countdown", from: 3 });
    toast("Cuenta regresiva en pantalla de todos.");
  });

  dom.btnStageClear.addEventListener("click", () => clearStage());

  dom.toggleMic.addEventListener("click", () => {
    micOn = !micOn;
    localStream?.getAudioTracks().forEach(track => track.enabled = micOn);
    dom.toggleMic.classList.toggle("off", !micOn);
    dom.toggleMic.textContent = micOn ? "🎙️" : "🔇";
  });

  dom.toggleCam.addEventListener("click", () => {
    camOn = !camOn;
    localStream?.getVideoTracks().forEach(track => track.enabled = camOn);
    dom.toggleCam.classList.toggle("off", !camOn);
    dom.toggleCam.textContent = camOn ? "📷" : "🚫";
  });

  dom.toggleMusicMode.addEventListener("click", toggleMusicMode);
  dom.toggleMusicMode.classList.toggle("on", musicMode);
  dom.toggleSpeaker.addEventListener("click", cycleAudioOutput);

  dom.toggleStats.addEventListener("click", () => {
    const show = dom.statsPanel.classList.toggle("hidden") === false;
    dom.toggleStats.classList.toggle("on", show);
    if (show) startStats();
    else stopStats();
  });

  dom.reconnectVideo.addEventListener("click", () => {
    toast("Reiniciando conexiones de video...");
    reconnectAllPeers();
  });

  // Botón de emergencia: recarga la página conservando sala, nombre y rol,
  // así se vuelve a entrar a la clase de una y la conexión arranca limpia.
  dom.reloadClass.addEventListener("click", () => {
    toast("🚑 Reconectando la clase...");
    const url = appState.room ? buildClassUrl(true) : location.href;
    setTimeout(() => location.replace(url), 300);
  });

  dom.shareScreen.addEventListener("click", toggleScreenShare);

  // Modo baile: compartir música usa el mismo flujo de compartir pantalla,
  // pero pidiendo el audio de la pestaña (ver toggleScreenShare).
  dom.btnShareMusic?.addEventListener("click", toggleScreenShare);
  dom.danceMusicVol?.addEventListener("input", () => {
    if (musicMixer) musicMixer.gain.gain.value = Number(dom.danceMusicVol.value);
  });

  dom.biblioRefresh.addEventListener("click", () => initBiblioteca({ force: true }));
  dom.biblioSearch.addEventListener("input", () => { biblioVisible = 30; renderBiblioteca(); });
  [dom.biblioArea, dom.biblioCategoria, dom.biblioNivel].forEach(select => {
    select.addEventListener("change", () => { biblioVisible = 30; renderBiblioteca(); });
  });
  dom.biblioMore.addEventListener("click", () => {
    biblioVisible += 30;
    renderBiblioteca();
  });
}

function launchStage(stage) {
  appState.stage = { id: cryptoId(), at: new Date().toISOString(), ...stage };
  saveLocal();
  renderStage();
  syncPatch({ stage: appState.stage });
}

function clearStage() {
  const stageId = appState.stage?.id;
  appState.stage = null;
  saveLocal();
  renderStage();
  syncPatch({ stage: null });
  // Borra las anotaciones del recurso que se cerró para no dejar basura en RTDB.
  if (stageId && firebaseReady && roomPath) {
    remove(ref(db, `${roomPath}/annot/${stageId}`)).catch(() => {});
  }
  toast("Escenario limpio.");
}

/* ===== Modo de clase: música o baile =====
   "musica": todas las herramientas visuales e instrumentos.
   "danza": prioridad al audio — se ocultan las herramientas de notas y se
   habilita compartir música desde una pestaña, mezclada con la voz. */

function applyClassMode(mode) {
  const m = mode === "danza" ? "danza" : "musica";
  const changed = appState.classMode !== m || !document.body.dataset.modeApplied;
  appState.classMode = m;
  document.body.dataset.modeApplied = "1";
  document.body.classList.toggle("mode-danza", m === "danza");
  if (dom.classMode && dom.classMode.value !== m) dom.classMode.value = m;

  // En baile la música de fondo debe llegar completa: audio sin filtros de
  // voz desde el arranque (equivale a encender el modo música 🎼).
  if (m === "danza" && !musicMode) {
    if (localStream) {
      toggleMusicMode();
    } else {
      musicMode = true;
      dom.toggleMusicMode?.classList.add("on");
      localStorage.setItem("musiaula-music-mode", "1");
    }
    if (changed) toast("💃 Modo baile: audio de alta calidad activado.");
  }
}

/* ===== Mezcla de música (modo baile) =====
   El audio de la pestaña compartida (YouTube, Spotify Web...) se mezcla con
   el micrófono en un solo track (Web Audio) y se envía por la llamada que ya
   existe, sin renegociar. El slider controla solo el volumen de la música. */

let musicMixer = null; // { dest, micSrc, musicSrc, gain, tabTrack }

function startMusicMix(tabTrack) {
  try {
    const ctx = ensureAudio();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = Number(dom.danceMusicVol?.value || 0.8);

    const musicSrc = ctx.createMediaStreamSource(new MediaStream([tabTrack]));
    musicSrc.connect(gain);
    gain.connect(dest);

    let micSrc = null;
    const micTrack = localStream?.getAudioTracks()[0];
    if (micTrack) {
      micSrc = ctx.createMediaStreamSource(new MediaStream([micTrack]));
      micSrc.connect(dest);
    }

    musicMixer = { dest, micSrc, musicSrc, gain, tabTrack };

    const mixedTrack = dest.stream.getAudioTracks()[0];
    forEachSender("audio", sender => sender.replaceTrack(mixedTrack).catch(console.warn));
    toast("🎶 Música compartida: tu voz y la música viajan juntas a la clase.");
  } catch (error) {
    console.warn("No se pudo mezclar la música de la pestaña", error);
    toast("No se pudo mezclar el audio de la pestaña; el video sí se comparte.");
  }
}

function stopMusicMix() {
  if (!musicMixer) return;
  try { musicMixer.musicSrc.disconnect(); } catch {}
  try { musicMixer.micSrc?.disconnect(); } catch {}
  musicMixer = null;

  const micTrack = localStream?.getAudioTracks()[0];
  if (micTrack) forEachSender("audio", sender => sender.replaceTrack(micTrack).catch(console.warn));
}

// Si el micrófono cambia (modo música/voz) mientras hay mezcla activa,
// se reconecta el mic nuevo a la mezcla en lugar de reemplazar el track enviado.
function refreshMixerMic() {
  if (!musicMixer) return;
  try { musicMixer.micSrc?.disconnect(); } catch {}
  const micTrack = localStream?.getAudioTracks()[0];
  if (micTrack) {
    musicMixer.micSrc = ensureAudio().createMediaStreamSource(new MediaStream([micTrack]));
    musicMixer.micSrc.connect(musicMixer.dest);
  }
}

/* ===== Sala: Firebase ===== */

async function enterClass({ room, displayName, role }) {
  if (!displayName) {
    toast("Falta el nombre para entrar.");
    return;
  }

  // Rol docente: solo correos autorizados en el Directorio del Hub de Docentes.
  if ((role || "docente") !== "estudiante") {
    const check = await isAuthorizedTeacher(currentUser?.email);
    if (!check.ok) {
      toast(check.reason === "sin-email"
        ? "Para entrar como docente inicia sesión con tu correo de Musicala."
        : "Tu correo no está autorizado como docente en el Hub. Pide acceso a coordinación o entra como estudiante.");
      dom.lobby.classList.remove("hidden");
      return;
    }
    if (check.reason === "sin-verificar") {
      toast("No se pudo verificar tu acceso con el Hub; entras igual para no frenar la clase.");
    }
  }

  appState.room = normalizeRoom(room);
  appState.displayName = displayName;
  appState.role = role || "docente";
  saveLocal();

  document.body.classList.toggle("role-estudiante", appState.role === "estudiante");
  document.body.classList.toggle("role-docente", appState.role !== "estudiante");

  // El tipo de clase lo decide el docente; el estudiante lo recibe por la sala.
  if (appState.role !== "estudiante") {
    appState.classMode = dom.classMode?.value === "danza" ? "danza" : "musica";
  }
  applyClassMode(appState.classMode);

  const url = buildClassUrl(true);
  history.replaceState(null, "", url);

  dom.roomTitle.textContent = appState.room;
  dom.lobby.classList.add("hidden");
  dom.app.classList.remove("hidden");

  renderAll();
  connectRoom();
}

async function connectRoom() {
  if (!firebaseReady) {
    setStatus("Sin Firebase", false);
    toast("Firebase no está disponible. Revisa la configuración y la consola.");
    return;
  }

  roomPath = `rooms/${appState.room}`;
  setStatus("Conectando", false);

  // Cámara y micrófono primero: así cada conexión nueva ya lleva mis tracks.
  await ensureLocalMedia();

  try {
    // Presencia: aparezco en la sala y desaparezco solo si me desconecto.
    presenceRef = ref(db, `${roomPath}/participants/${CLIENT_ID}`);
    await set(presenceRef, {
      name: appState.displayName,
      role: appState.role,
      joinedAt: new Date().toISOString()
    });
    onDisconnect(presenceRef).remove();
  } catch (error) {
    console.error("No se pudo escribir en Realtime Database", error);
    setStatus("Error de base de datos", false);
    toast("No se pudo conectar a Realtime Database. ¿Creaste la base y las reglas permiten escribir?");
    return;
  }

  // Buzón de señalización propio: aquí me dejan ofertas/respuestas/candidatos.
  listenSignals();

  listen(ref(db, `${roomPath}/participants`), snapshot => {
    lastParticipants = snapshot.val() || {};
    participantsCount = Object.keys(lastParticipants).length;
    renderStatusCount();
    syncPeers();
  });

  // Estado vivo del aula: el docente lo siembra, todos lo escuchan.
  const liveRef = ref(db, `${roomPath}/live`);
  const existing = await get(liveRef).catch(() => null);

  if (appState.role !== "estudiante" && (!existing || !existing.exists())) {
    await set(liveRef, publicState()).catch(console.warn);
  }

  listen(liveRef, snapshot => {
    const value = snapshot.val();
    if (value) mergeState(value);
  });

  // Respuestas: cola compartida, cada una llega una sola vez.
  listen(query(ref(db, `${roomPath}/responses`), limitToLast(30)), null, snap => {
    const response = snap.val();
    if (!response || appState.responses.some(r => r.id === response.id)) return;
    appState.responses.unshift(response);
    saveLocal();
    renderResponses();
    if (response.name !== appState.displayName) {
      toast(`${response.name}: ${response.text}`);
    }
  });

  // Instrumentos en vivo: lo que un lado toca, el otro lo ve y lo escucha.
  instrumentPlaySince = Date.now();
  listen(query(ref(db, `${roomPath}/instrumentPlay`), limitToLast(20)), null, snap => {
    const ev = snap.val();
    if (!ev || ev.by === CLIENT_ID || (ev.at || 0) < instrumentPlaySince) return;
    applyRemotePlay(ev);
  });

  setStatus("En sala", true);
}

function listen(reference, onValueCb, onChildCb) {
  if (onValueCb) unsubscribers.push(onValue(reference, onValueCb));
  if (onChildCb) unsubscribers.push(onChildAdded(reference, onChildCb));
}

function syncPatch(patch) {
  if (!firebaseReady || !roomPath) return;
  update(ref(db, `${roomPath}/live`), patch).catch(error => {
    console.warn("No se pudo sincronizar", error);
    toast("No se pudo sincronizar con la sala.");
  });
}

function syncFullState() {
  if (!firebaseReady || !roomPath) return;
  set(ref(db, `${roomPath}/live`), publicState()).catch(console.warn);
}

function sendResponse(text, extra = {}) {
  const response = {
    id: cryptoId(),
    name: appState.displayName || "Participante",
    role: appState.role,
    text,
    at: new Date().toISOString(),
    ...extra
  };

  if (firebaseReady && roomPath) {
    push(ref(db, `${roomPath}/responses`), response).catch(console.warn);
  } else {
    appState.responses.unshift(response);
    saveLocal();
    renderResponses();
  }
}

function publicState() {
  return {
    room: appState.room,
    classMode: appState.classMode || "musica",
    objective: appState.objective || "",
    activeResource: appState.activeResource,
    activeExercise: appState.activeExercise,
    stage: appState.stage,
    resources: appState.resources,
    metronome: metro
  };
}

function mergeState(incoming) {
  const allowed = ["classMode", "objective", "activeResource", "activeExercise", "stage", "resources"];
  let stageChanged = false;

  allowed.forEach(key => {
    if (!(key in incoming)) {
      // RTDB omite claves con valor null: tratarlas como borradas.
      if (key === "stage" && appState.stage) {
        appState.stage = null;
        stageChanged = true;
      }
      return;
    }
    // Comparar por id (único por lanzamiento): RTDB reordena las claves y un
    // stringify directo re-renderizaría el escenario con el eco de uno mismo.
    if (key === "stage" && incoming.stage?.id !== appState.stage?.id) {
      stageChanged = true;
    }
    appState[key] = incoming[key];
  });

  // Metrónomo compartido: aplicar siempre (null/ausente = apagado)
  applyMetronome(incoming.metronome || null);

  if (!Array.isArray(appState.resources)) appState.resources = [];
  applyClassMode(appState.classMode);
  saveLocal();
  renderAula();
  renderResources();
  if (stageChanged) renderStage();
}

function setStatus(text, online) {
  dom.connectionStatus.textContent = text;
  dom.connectionStatus.className = "status " + (online ? "online" : "offline");
}

function renderStatusCount() {
  if (participantsCount > 1) {
    setStatus(`Sincronizado · ${participantsCount} personas`, true);
  } else if (participantsCount === 1) {
    setStatus("Solo en sala", true);
  }
}

function leaveClass() {
  unsubscribers.forEach(unsub => {
    try { unsub(); } catch {}
  });
  unsubscribers = [];

  if (presenceRef) remove(presenceRef).catch(() => {});
  hangUp();
  stopMetroScheduler();
  stopStats();
  metro = null;
  location.href = location.pathname;
}

/* ===== Video: WebRTC en malla (1 a 1 o grupo pequeño) =====
   Cada pareja de participantes tiene su propia conexión directa. La
   señalización va por RTDB: cada quien tiene un "buzón" en
   rooms/X/signals/<id> donde los demás dejan ofertas, respuestas y
   candidatos. Para evitar choques, en cada pareja siempre inicia la
   conexión el participante con id menor. */

/* ===== Pantalla siempre encendida =====
   Mientras se está en clase pedimos un "wake lock" para que el celular o el
   computador no apaguen la pantalla por inactividad. El sistema lo suelta solo
   si la pestaña pasa a segundo plano, así que lo volvemos a pedir al regresar. */

let wakeLock = null;

async function keepScreenAwake() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (error) {
    // Suele fallar si la batería está muy baja o la pestaña no está visible.
    console.warn("No se pudo mantener la pantalla encendida", error);
  }
}

function releaseScreenAwake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function ensureLocalMedia() {
  keepScreenAwake();
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: audioConstraints()
    });
    tagAudioAsMusic(localStream);
    dom.localVideo.srcObject = localStream;
  } catch (error) {
    console.error("Sin acceso a cámara/micrófono", error);
    toast("No hay acceso a cámara o micrófono. El aula funciona, pero sin enviar video.");
  }
}

function listenSignals() {
  const inbox = ref(db, `${roomPath}/signals/${CLIENT_ID}`);
  remove(inbox).catch(() => {});
  listen(query(inbox, limitToLast(200)), null, snap => {
    const msg = snap.val();
    remove(snap.ref).catch(() => {}); // cada mensaje se procesa una sola vez
    if (msg?.from) handleSignal(msg).catch(error => console.warn("Señal fallida", error));
  });
}

function sendSignal(toId, msg) {
  if (!firebaseReady || !roomPath) return;
  push(ref(db, `${roomPath}/signals/${toId}`), { from: CLIENT_ID, at: Date.now(), ...msg })
    .catch(console.warn);
}

// Alinea las conexiones con la lista de presentes: crea las que faltan
// (cuando me toca iniciar) y cierra las de quienes ya se fueron.
function syncPeers() {
  if (!roomPath) return;
  Object.entries(lastParticipants).forEach(([id, info]) => {
    if (id === CLIENT_ID || peers.has(id)) return;
    if (CLIENT_ID < id) initiatePeer(id, info);
  });
  [...peers.keys()].forEach(id => {
    if (!lastParticipants[id]) removePeer(id);
  });
}

function createPeerFor(id, info = {}) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const entry = {
    id, pc,
    name: info.name || "Participante",
    stream: null, tile: null, videoEl: null, audioNode: null,
    pendingCandidates: []
  };
  peers.set(id, entry);

  localStream?.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Si ya estoy compartiendo pantalla o música, quien entra tarde recibe
  // esos tracks en lugar de la cámara y el micrófono puros.
  const screenTrack = screenStream?.getVideoTracks()[0];
  if (screenTrack) {
    pc.getSenders().find(s => s.track?.kind === "video")?.replaceTrack(screenTrack).catch(() => {});
  }
  const mixedTrack = musicMixer?.dest.stream.getAudioTracks()[0];
  if (mixedTrack) {
    pc.getSenders().find(s => s.track?.kind === "audio")?.replaceTrack(mixedTrack).catch(() => {});
  }

  pc.onicecandidate = event => {
    if (event.candidate) sendSignal(id, { type: "candidate", candidate: event.candidate.toJSON() });
  };

  pc.ontrack = event => {
    const [stream] = event.streams;
    if (stream) attachRemoteStream(entry, stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      renderStatusCount();
      tuneAudioLatency(pc);
      boostAudioBitrate(pc);
    }
    if (["disconnected", "failed"].includes(pc.connectionState)) {
      entry.tile?.classList.add("lost");
      setStatus("Conexión perdida con un participante...", false);
      // El iniciador de la pareja la vuelve a levantar si el otro sigue presente.
      if (pc.connectionState === "failed" && lastParticipants[id] && CLIENT_ID < id) {
        removePeer(id);
        initiatePeer(id, lastParticipants[id]);
      }
    }
  };

  return entry;
}

async function initiatePeer(id, info) {
  const entry = createPeerFor(id, info);
  try {
    const offer = await entry.pc.createOffer();
    offer.sdp = preferHiFiOpus(offer.sdp);
    await entry.pc.setLocalDescription(offer);
    sendSignal(id, { type: "offer", sdp: offer.sdp, name: appState.displayName });
  } catch (error) {
    console.warn("No se pudo iniciar la conexión", error);
  }
}

async function handleSignal(msg) {
  const from = msg.from;
  let entry = peers.get(from);

  if (msg.type === "offer") {
    // Oferta nueva del mismo participante = reinicio de su conexión.
    if (entry) removePeer(from);
    entry = createPeerFor(from, { name: msg.name || lastParticipants[from]?.name });
    await entry.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    await flushCandidates(entry);
    const answer = await entry.pc.createAnswer();
    answer.sdp = preferHiFiOpus(answer.sdp);
    await entry.pc.setLocalDescription(answer);
    sendSignal(from, { type: "answer", sdp: answer.sdp, name: appState.displayName });
    return;
  }

  if (msg.type === "reoffer") {
    // El otro lado pide reiniciar la pareja y a mí me toca iniciar.
    if (CLIENT_ID < from && lastParticipants[from]) {
      removePeer(from);
      initiatePeer(from, lastParticipants[from]);
    }
    return;
  }

  if (!entry) return;

  if (msg.type === "answer") {
    if (msg.name) { entry.name = msg.name; updateTileName(entry); }
    if (entry.pc.signalingState === "have-local-offer") {
      await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      await flushCandidates(entry);
    }
  } else if (msg.type === "candidate" && msg.candidate) {
    if (entry.pc.remoteDescription) {
      await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    } else {
      entry.pendingCandidates.push(msg.candidate);
    }
  }
}

async function flushCandidates(entry) {
  const pending = entry.pendingCandidates.splice(0);
  for (const candidate of pending) {
    await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

function attachRemoteStream(entry, stream) {
  entry.stream = stream;

  if (!entry.tile) {
    entry.tile = document.createElement("div");
    entry.tile.className = "video-tile";
    entry.videoEl = document.createElement("video");
    entry.videoEl.autoplay = true;
    entry.videoEl.playsInline = true;
    const nameTag = document.createElement("span");
    nameTag.className = "tile-name";
    entry.tile.append(entry.videoEl, nameTag);
    dom.videoGrid.appendChild(entry.tile);
  }
  entry.tile.classList.remove("lost");
  updateTileName(entry);
  entry.videoEl.srcObject = stream;
  dom.remotePlaceholder.classList.add("hidden");

  routeEntryAudio(entry);
  applyIosSpeaker();
}

function updateTileName(entry) {
  const tag = entry.tile?.querySelector(".tile-name");
  if (tag) tag.textContent = entry.name || "Participante";
}

function removePeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  try { entry.audioNode?.disconnect(); } catch {}
  try { entry.pc.close(); } catch {}
  entry.tile?.remove();
  peers.delete(id);
  if (!peers.size) dom.remotePlaceholder.classList.remove("hidden");
}

function closeAllPeers() {
  [...peers.keys()].forEach(removePeer);
}

// Botón ↻: tumba todas las conexiones y las vuelve a levantar. A las parejas
// donde inicia el otro se les pide la reconexión con una señal "reoffer".
function reconnectAllPeers() {
  closeAllPeers();
  syncPeers();
  Object.keys(lastParticipants).forEach(id => {
    if (id !== CLIENT_ID && !(CLIENT_ID < id)) sendSignal(id, { type: "reoffer" });
  });
}

// Aplica una función al sender de audio o video de CADA conexión activa.
function forEachSender(kind, fn) {
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === kind);
    if (sender) fn(sender, pc);
  });
}

function hangUp() {
  releaseScreenAwake();
  stopScreenShare(true);
  closeAllPeers();
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  if (firebaseReady && roomPath) {
    remove(ref(db, `${roomPath}/signals/${CLIENT_ID}`)).catch(() => {});
  }
}

/* ===== Compartir pantalla =====
   Reemplaza el track de la cámara por el de la pantalla en la conexión que ya
   existe (replaceTrack), sin renegociar la llamada. Al terminar vuelve a la
   cámara. La cámara sigue viva mientras tanto para poder volver a ella. */

async function toggleScreenShare() {
  if (screenStream) {
    stopScreenShare();
    return;
  }

  // En modo baile se pide también el audio de la pestaña para mandar la música.
  const wantMusic = appState.classMode === "danza";

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // displaySurface "window" sugiere compartir UNA ventana (no toda la
      // pantalla); en baile se sugiere "browser" (pestaña) porque solo las
      // pestañas comparten audio. surfaceSwitching permite cambiar de ventana
      // sin volver a compartir.
      video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, displaySurface: wantMusic ? "browser" : "window" },
      audio: wantMusic
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
      surfaceSwitching: "include",
      selfBrowserSurface: "exclude"
    });
  } catch {
    // El docente canceló el selector o el navegador no lo permite.
    return;
  }

  screenStream = stream;
  const screenTrack = stream.getVideoTracks()[0];

  const tabAudio = stream.getAudioTracks()[0];
  if (tabAudio) {
    startMusicMix(tabAudio);
  } else if (wantMusic) {
    toast("Consejo: elige una PESTAÑA y marca «Compartir audio» para que suene la música.");
  }

  let sent = 0;
  forEachSender("video", sender => {
    sender.replaceTrack(screenTrack).catch(error => console.warn("No se pudo enviar la pantalla", error));
    sent++;
  });

  dom.localVideo.srcObject = screenStream;
  dom.shareScreen.classList.add("on");
  dom.shareScreen.textContent = "⏹";
  // El navegador tiene su propio botón "Dejar de compartir": lo escuchamos.
  screenTrack.onended = () => stopScreenShare();
  toast(sent
    ? "Compartiendo pantalla con la clase."
    : "Compartiendo pantalla. Se enviará cuando alguien se conecte.");
}

function stopScreenShare(silent = false) {
  if (!screenStream) return;
  stopMusicMix();
  screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;

  const cameraTrack = localStream?.getVideoTracks()[0];
  if (cameraTrack) {
    forEachSender("video", sender => sender.replaceTrack(cameraTrack).catch(console.warn));
  }

  if (dom.localVideo) dom.localVideo.srcObject = localStream;
  dom.shareScreen?.classList.remove("on");
  if (dom.shareScreen) dom.shareScreen.textContent = "🖥️";
  if (!silent) toast("Dejaste de compartir pantalla. Cámara de vuelta.");
}

/* ===== Optimización de audio =====
   Prioridad: sonido del instrumento perfecto, baja latencia y salida por altavoz. */

// Ruta del audio remoto. En celular el sistema decide altavoz/auricular según
// CÓMO se reproduce: el elemento de video se trata como video-llamada (altavoz,
// como FaceTime); Web Audio con el micrófono activo suele irse al auricular.
// Por defecto usamos el elemento en móvil y Web Audio en escritorio, y el
// botón 🔊 permite alternar por si algún equipo enruta al revés.
let audioRoute = isMobileDevice() ? "elemento" : "webaudio";

function isMobileDevice() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent)); // iPad con teclado
}

// Enruta el audio de UN participante según la ruta elegida.
function routeEntryAudio(entry) {
  if (!entry.stream || !entry.stream.getAudioTracks().length || !entry.videoEl) return;
  if (entry.audioNode) { try { entry.audioNode.disconnect(); } catch {} entry.audioNode = null; }

  if (audioRoute === "webaudio") {
    try {
      const ctx = ensureAudio();
      entry.audioNode = ctx.createMediaStreamSource(entry.stream);
      entry.audioNode.connect(ctx.destination);
      entry.videoEl.muted = true; // evita doble salida (Web Audio + elemento)
      return;
    } catch (error) {
      console.warn("No se pudo enrutar por Web Audio; uso el elemento de video", error);
    }
  }

  entry.videoEl.muted = false;
  entry.videoEl.play().catch(() => {});
}

function applyAudioRoute() {
  peers.forEach(routeEntryAudio);
}

// Restricciones del micrófono según el modo. Aun en modo voz apagamos la
// supresión de ruido y el control de ganancia: recortan instrumentos y
// dinámica (clases de música/danza). La cancelación de eco sí queda activa
// en modo voz para poder trabajar sin audífonos.
function audioConstraints() {
  return musicMode
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
    : { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 };
}

// Pista de que el contenido es música: el códec evita el modo "voz" (DTX,
// recorte de silencios) y conserva el detalle del instrumento.
function tagAudioAsMusic(stream) {
  stream?.getAudioTracks().forEach(track => {
    try { track.contentHint = "music"; } catch {}
  });
}

/* ===== Salida de audio: altavoz vs auricular ===== */

// iOS (Safari 16.4+): con el micrófono activo el sistema manda el audio al
// auricular del oído. Declarar la sesión como "playback" lo fuerza al altavoz.
function applyIosSpeaker() {
  if (!("audioSession" in navigator)) return;
  try {
    navigator.audioSession.type = speakerOn ? "playback" : "auto";
  } catch (error) {
    console.warn("No se pudo cambiar la sesión de audio", error);
  }
}

// Botón 🔊: en iOS con AudioSession alterna altavoz/auricular; en otros
// celulares alterna la RUTA de reproducción (elemento vs Web Audio), que es
// lo que decide la salida; en escritorio rota entre las salidas con setSinkId.
async function cycleAudioOutput() {
  if ("audioSession" in navigator) {
    speakerOn = !speakerOn;
    applyIosSpeaker();
    dom.toggleSpeaker.textContent = speakerOn ? "🔊" : "📞";
    toast(speakerOn ? "🔊 Sonido por el altavoz." : "📞 Sonido por el auricular.");
    return;
  }

  if (isMobileDevice()) {
    audioRoute = audioRoute === "elemento" ? "webaudio" : "elemento";
    applyAudioRoute();
    dom.toggleSpeaker.textContent = audioRoute === "elemento" ? "🔊" : "📞";
    toast(audioRoute === "elemento"
      ? "🔊 Ruta de altavoz activada."
      : "📞 Ruta alternativa activada. Si no cambió la salida, toca de nuevo.");
    return;
  }

  const canSink = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
  const canSinkVideo = "setSinkId" in HTMLMediaElement.prototype;
  if (!canSink && !canSinkVideo) {
    toast("Este navegador no permite elegir la salida; usa los controles del sistema.");
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioOutputs = devices.filter(d => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "communications");
    if (audioOutputs.length < 2) {
      toast("Solo hay una salida de audio disponible.");
      return;
    }
    audioOutputIndex = (audioOutputIndex + 1) % audioOutputs.length;
    const device = audioOutputs[audioOutputIndex];
    const sinkId = device.deviceId === "default" ? "" : device.deviceId;

    if (canSink) await ensureAudio().setSinkId(sinkId);
    if (canSinkVideo) {
      for (const { videoEl } of peers.values()) {
        if (videoEl) await videoEl.setSinkId(sinkId).catch(() => {});
      }
    }

    toast(`🔊 Salida: ${device.label || "salida " + (audioOutputIndex + 1)}`);
  } catch (error) {
    console.warn("No se pudo cambiar la salida de audio", error);
    toast("No se pudo cambiar la salida de audio.");
  }
}

// Reduce el búfer anti-jitter al mínimo: menos latencia para tocar en tiempo real.
function tuneAudioLatency(pc) {
  if (!pc) return;
  pc.getReceivers().forEach(receiver => {
    if (receiver.track?.kind !== "audio") return;
    try { receiver.jitterBufferTarget = 0; } catch {}
    try { receiver.playoutDelayHint = 0; } catch {} // navegadores antiguos
  });
}

// Sube el bitrate del audio que enviamos para que el instrumento llegue con detalle.
async function boostAudioBitrate(pc) {
  const sender = pc?.getSenders().find(s => s.track?.kind === "audio");
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 256000;
    params.encodings[0].priority = "high";
    await sender.setParameters(params);
  } catch (error) {
    console.warn("No se pudo subir el bitrate de audio", error);
  }
}

// Munge de SDP: Opus estéreo, FEC, sin DTX ni recorte, 48 kHz a buen bitrate.
function preferHiFiOpus(sdp) {
  if (!sdp) return sdp;
  const pt = (sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1];
  if (!pt) return sdp;

  const hifi = "stereo=1;sprop-stereo=1;maxaveragebitrate=256000;maxplaybackrate=48000;useinbandfec=1;usedtx=0;cbr=0";
  const fmtpRe = new RegExp(`a=fmtp:${pt} (.*)`);

  if (fmtpRe.test(sdp)) {
    return sdp.replace(fmtpRe, (m, params) => `a=fmtp:${pt} ${mergeFmtp(params, hifi)}`);
  }
  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt} opus/48000(?:/2)?\r?\n)`),
    `$1a=fmtp:${pt} ${hifi}\r\n`
  );
}

// Combina parámetros fmtp existentes con los nuevos (los nuevos ganan en duplicados).
function mergeFmtp(existing, extra) {
  const map = new Map();
  `${existing};${extra}`.split(";").forEach(pair => {
    const t = pair.trim();
    if (!t) return;
    const [key, value] = t.split("=");
    map.set(key.trim(), value);
  });
  return [...map.entries()].map(([k, v]) => (v == null ? k : `${k}=${v}`)).join(";");
}

/* ===== Síntesis de sonido (Web Audio, sin archivos de audio) ===== */

const NOTE_MIDI = { Do: 60, Re: 62, Mi: 64, Fa: 65, Sol: 67, La: 69, Si: 71 };

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Tono musical con un toque de armónico y envolvente suave (timbre tipo instrumento).
function playTone(freq, { dur = 0.7, type = "triangle", gain = 0.16 } = {}) {
  try {
    const ctx = ensureAudio();
    const t = ctx.currentTime;
    const g = ctx.createGain();
    const osc = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    osc.type = type;
    harmonic.type = "sine";
    osc.frequency.value = freq;
    harmonic.frequency.value = freq * 2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    harmonic.connect(g);
    g.connect(ctx.destination);
    osc.start(t); harmonic.start(t);
    osc.stop(t + dur); harmonic.stop(t + dur);
  } catch {
    /* Si el navegador bloquea audio, los juegos siguen funcionando visualmente. */
  }
}

function playMidi(midi, opts) { playTone(midiToFreq(midi), opts); }
function playNote(name, opts) { playTone(midiToFreq(NOTE_MIDI[name] ?? 60), opts); }

let _noiseBuffer = null;
function noiseBuffer(ctx) {
  if (_noiseBuffer) return _noiseBuffer;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  _noiseBuffer = buffer;
  return buffer;
}

// Percusión sintetizada: bombo, redoblante, hi-hat, toms y platillo.
function playDrum(kind) {
  try {
    const ctx = ensureAudio();
    const t = ctx.currentTime;
    const out = ctx.destination;

    const tone = (f1, f2, dur, peak) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(f1, t);
      osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + dur);
    };
    const noise = (type, freq, dur, peak) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const filter = ctx.createBiquadFilter();
      filter.type = type; filter.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter); filter.connect(g); g.connect(out);
      src.start(t); src.stop(t + dur);
    };

    if (kind === "kick") tone(150, 50, 0.3, 0.9);
    else if (kind === "tom1") tone(220, 110, 0.25, 0.7);
    else if (kind === "tom2") tone(160, 80, 0.28, 0.7);
    else if (kind === "snare") { tone(180, 100, 0.12, 0.4); noise("highpass", 1500, 0.2, 0.6); }
    else if (kind === "hat") noise("highpass", 8000, 0.05, 0.3);
    else if (kind === "crash") noise("highpass", 5000, 0.8, 0.4);
  } catch {
    /* silencio si el navegador bloquea audio */
  }
}

function flashEl(el) {
  if (!el) return;
  el.classList.add("lit");
  setTimeout(() => el.classList.remove("lit"), 180);
}

// Transmite a la sala que toqué algo (tecla, traste o tambor).
function emitPlay(playId, sound) {
  if (!firebaseReady || !roomPath) return;
  push(ref(db, `${roomPath}/instrumentPlay`), {
    playId, sound, by: CLIENT_ID, at: Date.now()
  }).catch(() => {});
}

// Reproduce y resalta lo que tocó el OTRO participante.
function applyRemotePlay(ev) {
  if (ev.sound?.drum) playDrum(ev.sound.drum);
  else if (ev.sound?.midi != null) playMidi(ev.sound.midi, ev.sound.opts);

  // Si tengo el mismo instrumento en pantalla, ilumino el punto que tocó.
  if (ev.playId && dom.stageArea) {
    const el = dom.stageArea.querySelector(`[data-play-id="${ev.playId}"]`);
    if (el) flashEl(el);
  }
}

// Toca local + transmite a la sala en un solo paso.
function playAndEmit(playId, sound, el) {
  if (sound.drum) playDrum(sound.drum);
  else playMidi(sound.midi, sound.opts);
  flashEl(el);
  emitPlay(playId, sound);
}

/* ===== Render ===== */

function renderAll() {
  renderAula();
  renderStage();
  renderResources();
  renderScalePreview();
  renderResponses();
  renderLogs();
}

function renderAula() {
  dom.objectiveInput.value = appState.objective || dom.objectiveInput.value || "";
  dom.objectiveView.textContent = appState.objective || "Sin objetivo publicado todavía";

  if (appState.activeResource) {
    const resource = appState.activeResource;
    const url = safeUrl(resource.url);
    dom.activeResourceTitle.textContent = resource.title;
    dom.activeResourceDesc.innerHTML =
      escapeHtml(resource.desc || "Sin descripción.") +
      (url ? `<br><a class="resource-open" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Abrir recurso ↗</a>` : "");
  } else {
    dom.activeResourceTitle.textContent = "Ninguno";
    dom.activeResourceDesc.textContent = "Activa un recurso desde la pestaña Recursos.";
  }

  if (appState.activeExercise) {
    dom.activeExerciseTitle.textContent = appState.activeExercise.title;
    dom.activeExerciseBody.innerHTML = `
      <p>${escapeHtml(appState.activeExercise.instruction)}</p>
      <div class="scale-preview">${(appState.activeExercise.sequence || []).map(note => `<span class="note-pill">${escapeHtml(note)}</span>`).join("")}</div>
    `;
  } else {
    dom.activeExerciseTitle.textContent = "Sin actividad";
    dom.activeExerciseBody.textContent = "Lanza un ejercicio desde la pestaña Ejercicio.";
  }
}

function renderStage() {
  if (!dom.stageArea) return;

  if (stageTimer) {
    clearInterval(stageTimer);
    stageTimer = null;
  }
  clearGameTimers();
  clearAnnotations();

  const stage = appState.stage;
  if (!stage) {
    setFocusMode(false);
    dom.stageArea.classList.add("hidden");
    dom.stageArea.innerHTML = "";
    return;
  }

  setFocusMode(stage.kind === "resource");
  dom.stageArea.classList.remove("hidden");
  const isTeacher = appState.role !== "estudiante";
  const closeButton = isTeacher
    ? `<button class="stage-close ghost tiny" data-stage-close>✕ Cerrar</button>`
    : "";

  if (stage.kind === "bigNote") {
    dom.stageArea.innerHTML = `
      ${closeButton}
      <p class="label">Atención a esta nota</p>
      <div class="big-note">${escapeHtml(stage.note)}</div>
    `;
  }

  if (stage.kind === "sequence") {
    dom.stageArea.innerHTML = `
      ${closeButton}
      <p class="label">${escapeHtml(stage.title || "Secuencia")}</p>
      <div class="stage-sequence">
        ${(stage.sequence || []).map(note => `<span class="note-pill big">${escapeHtml(note)}</span>`).join("")}
      </div>
    `;
    const pills = Array.from(dom.stageArea.querySelectorAll(".note-pill"));
    let index = 0;
    const interval = 60000 / (stage.bpm || 80);
    const step = () => {
      pills.forEach((pill, i) => pill.classList.toggle("lit", i === index));
      index = (index + 1) % pills.length;
    };
    step();
    stageTimer = setInterval(step, interval);
  }

  if (stage.kind === "quiz") {
    const answered = answeredQuizIds.has(stage.id);
    dom.stageArea.innerHTML = `
      ${closeButton}
      <p class="label">Juego musical</p>
      <h2 class="stage-question">${escapeHtml(stage.question)}</h2>
      <div class="stage-options">
        ${(stage.options || []).map(note => `
          <button class="quiz-option" data-quiz-answer="${escapeHtml(note)}" ${answered ? "disabled" : ""}>${escapeHtml(note)}</button>
        `).join("")}
      </div>
      <p class="hint stage-hint">${isTeacher ? "Vista previa: el estudiante puede tocar las notas." : "Toca la nota correcta 👇"}</p>
    `;

    dom.stageArea.querySelectorAll("[data-quiz-answer]").forEach(button => {
      button.addEventListener("click", () => {
        const answer = button.dataset.quizAnswer;
        const correct = answer === stage.correct;
        answeredQuizIds.add(stage.id);

        dom.stageArea.querySelectorAll("[data-quiz-answer]").forEach(b => {
          b.disabled = true;
          if (b.dataset.quizAnswer === stage.correct) b.classList.add("correct");
        });
        button.classList.add(correct ? "correct" : "wrong");

        const hint = dom.stageArea.querySelector(".stage-hint");
        if (hint) hint.textContent = correct ? "¡Correcto! 🎉" : `Casi... la respuesta era ${stage.correct}.`;

        sendResponse(`${correct ? "✅" : "❌"} Respondió "${answer}" — ${stage.question}`, { quizId: stage.id });
      });
    });
  }

  if (stage.kind === "pulse") {
    renderPulseStage(stage, isTeacher);
  }

  if (stage.kind === "resource") renderResourceStage(stage, isTeacher, closeButton);

  if (stage.kind === "instrument") renderInstrumentStage(stage, isTeacher, closeButton);
  if (stage.kind === "simon") renderSimonStage(stage, isTeacher, closeButton);
  if (stage.kind === "earQuiz") renderEarQuizStage(stage, isTeacher, closeButton);
  if (stage.kind === "match") renderMatchStage(stage, isTeacher, closeButton);
  if (stage.kind === "countdown") renderCountdownStage(stage, closeButton);

  if (stage.kind === "celebrate") {
    const pieces = Array.from({ length: 40 }, () => {
      const left = Math.random() * 100;
      const delay = Math.random() * 1.4;
      const duration = 2.2 + Math.random() * 1.8;
      const emoji = ["🎵", "🎶", "⭐", "🎉", "💜"][Math.floor(Math.random() * 5)];
      return `<span class="confetti" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s">${emoji}</span>`;
    }).join("");

    dom.stageArea.innerHTML = `
      ${closeButton}
      <div class="celebrate-wrap">${pieces}<h2 class="stage-question">¡Muy bien! 🎉</h2></div>
    `;
  }

  const close = dom.stageArea.querySelector("[data-stage-close]");
  if (close) close.addEventListener("click", clearStage);
}

/* ===== Juego de pulso =====
   El estudiante toca el botón en cada clic del metrónomo. Cada toque se
   compara contra el pulso teórico usando el reloj del servidor y se publica
   en RTDB, así el docente ve en vivo qué tan exacto va. */

const PULSE_GOOD_MS = 70; // tolerancia para considerar el toque "en el pulso"

function classifyTap(deltaMs) {
  if (Math.abs(deltaMs) <= PULSE_GOOD_MS) return "good";
  return deltaMs < 0 ? "early" : "late";
}

function renderPulseStage(stage, isTeacher) {
  const closeButton = isTeacher
    ? `<button class="stage-close ghost tiny" data-stage-close>✕ Cerrar</button>`
    : "";
  const total = stage.taps || 16;

  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">${escapeHtml(stage.title || "Marca el pulso")}</p>
    ${isTeacher
      ? `<p class="hint">El estudiante está tocando al ritmo del metrónomo. Verde = en el pulso, amarillo = adelantado, rosa = atrasado.</p>`
      : `<button class="pulse-btn" data-pulse-tap>TOCA<br>al ritmo</button>`}
    <p class="pulse-feedback" data-pulse-feedback></p>
    <div class="pulse-taps" data-pulse-dots>
      ${Array.from({ length: total }, () => `<span class="pulse-dot"></span>`).join("")}
    </div>
    <p class="hint" data-pulse-summary></p>
  `;

  const dots = Array.from(dom.stageArea.querySelectorAll(".pulse-dot"));
  const feedback = dom.stageArea.querySelector("[data-pulse-feedback]");
  const summary = dom.stageArea.querySelector("[data-pulse-summary]");
  const taps = [];

  const FEEDBACK_TEXT = {
    good: "¡En el pulso! ✅",
    early: "Un poco adelantado ⏪",
    late: "Un poco atrasado ⏩"
  };

  const paintTap = tap => {
    if (taps.length >= total) return;
    taps.push(tap);
    const dot = dots[taps.length - 1];
    if (dot) dot.classList.add(tap.cls);
    feedback.className = `pulse-feedback ${tap.cls}`;
    feedback.textContent = `${FEEDBACK_TEXT[tap.cls]} (${tap.deltaMs > 0 ? "+" : ""}${Math.round(tap.deltaMs)} ms)`;

    if (taps.length === total) {
      const good = taps.filter(t => t.cls === "good").length;
      const avg = Math.round(taps.reduce((sum, t) => sum + t.deltaMs, 0) / taps.length);
      const text = `Resultado: ${good}/${total} en el pulso · desfase promedio ${avg > 0 ? "+" : ""}${avg} ms`;
      summary.textContent = text;
      if (!isTeacher) {
        sendResponse(`🥁 ${text}`, { pulseStageId: stage.id });
      }
    }
  };

  // Ambos lados escuchan los toques publicados para este juego
  if (pulseTapsUnsub) {
    try { pulseTapsUnsub(); } catch {}
  }
  if (firebaseReady && roomPath) {
    pulseTapsUnsub = onChildAdded(ref(db, `${roomPath}/pulseTaps/${stage.id}`), snap => {
      const tap = snap.val();
      if (tap) paintTap(tap);
    });
    unsubscribers.push(pulseTapsUnsub);
  }

  const tapButton = dom.stageArea.querySelector("[data-pulse-tap]");
  if (tapButton) {
    tapButton.addEventListener("pointerdown", () => {
      ensureAudio();
      const offset = beatOffset(serverNow());
      if (!offset) {
        feedback.className = "pulse-feedback late";
        feedback.textContent = "El metrónomo está apagado: pídele al profe que lo encienda.";
        return;
      }
      const tap = { deltaMs: Math.round(offset.deltaMs), cls: classifyTap(offset.deltaMs), at: new Date().toISOString() };
      if (firebaseReady && roomPath) {
        push(ref(db, `${roomPath}/pulseTaps/${stage.id}`), tap).catch(console.warn);
      } else {
        paintTap(tap);
      }
    });
  }
}

/* ===== Instrumentos interactivos y juegos =====
   Todos viven dentro del "escenario": el docente los lanza y el estudiante
   los ve, los escucha y juega. El sonido se sintetiza en el navegador. */

const PITCH_NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
function noteNameFromMidi(midi) { return PITCH_NAMES[((midi % 12) + 12) % 12]; }

let gameTimers = [];
function gameTimeout(fn, ms) { const id = setTimeout(fn, ms); gameTimers.push(id); return id; }
function clearGameTimers() { gameTimers.forEach(clearTimeout); gameTimers = []; }

function renderInstrumentStage(stage, isTeacher, closeButton) {
  if (stage.instrument === "piano") return renderPiano(stage, closeButton);
  if (stage.instrument === "drums") return renderDrums(stage, closeButton);
  return renderFretboard(stage, closeButton); // guitarra y violín
}

function renderPiano(stage, closeButton) {
  const whites = [
    { n: "Do", m: 60 }, { n: "Re", m: 62 }, { n: "Mi", m: 64 }, { n: "Fa", m: 65 },
    { n: "Sol", m: 67 }, { n: "La", m: 69 }, { n: "Si", m: 71 }, { n: "Do", m: 72 }
  ];
  const blacks = { 0: 61, 1: 63, 3: 66, 4: 68, 5: 70 };

  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">${escapeHtml(stage.title || "Piano")}</p>
    <p class="hint">Toca las teclas: suenan en este dispositivo. 🎹</p>
    <div class="piano">
      ${whites.map((w, i) => `
        <div class="pkey-wrap">
          <button class="pkey white" data-midi="${w.m}" data-play-id="p${w.m}"><span>${w.n}</span></button>
          ${blacks[i] != null ? `<button class="pkey black" data-midi="${blacks[i]}" data-play-id="p${blacks[i]}"></button>` : ""}
        </div>
      `).join("")}
    </div>
  `;
  dom.stageArea.querySelectorAll(".pkey").forEach(key => {
    key.addEventListener("pointerdown", () => {
      playAndEmit(key.dataset.playId, { midi: Number(key.dataset.midi) }, key);
    });
  });
}

function renderFretboard(stage, closeButton) {
  const guitar = [
    { name: "Mi", midi: 64 }, { name: "Si", midi: 59 }, { name: "Sol", midi: 55 },
    { name: "Re", midi: 50 }, { name: "La", midi: 45 }, { name: "Mi", midi: 40 }
  ];
  const violin = [
    { name: "Mi", midi: 76 }, { name: "La", midi: 69 }, { name: "Re", midi: 62 }, { name: "Sol", midi: 55 }
  ];
  const isViolin = stage.instrument === "violin";
  const strings = isViolin ? violin : guitar;
  const cols = 5; // trastes/posiciones 0..4
  const colLabel = isViolin ? "Posición" : "Traste";

  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">${escapeHtml(stage.title || "Diagrama")}</p>
    <p class="hint">Cada cuerda al aire (${colLabel.toLowerCase()} 0) y sus notas. Toca cualquier punto para escucharlo.</p>
    <div class="fretboard ${isViolin ? "violin" : "guitar"}">
      <div class="fret-head"><span></span>${Array.from({ length: cols }, (_, c) => `<span class="fret-num">${c}</span>`).join("")}</div>
      ${strings.map((str, si) => `
        <div class="fret-row">
          <span class="string-name">${str.name}</span>
          ${Array.from({ length: cols }, (_, c) => {
            const midi = str.midi + c;
            return `<button class="fret-cell${c === 0 ? " open" : ""}" data-midi="${midi}" data-play-id="f${si}-${c}">${noteNameFromMidi(midi)}</button>`;
          }).join("")}
        </div>
      `).join("")}
    </div>
  `;
  const opts = { type: isViolin ? "sawtooth" : "triangle", dur: isViolin ? 1.1 : 0.8 };
  dom.stageArea.querySelectorAll(".fret-cell").forEach(cell => {
    cell.addEventListener("pointerdown", () => {
      playAndEmit(cell.dataset.playId, { midi: Number(cell.dataset.midi), opts }, cell);
    });
  });
}

function renderDrums(stage, closeButton) {
  const pads = [
    { drum: "crash", label: "Crash", cls: "crash" },
    { drum: "hat", label: "Hi-hat", cls: "hat" },
    { drum: "snare", label: "Redoblante", cls: "snare" },
    { drum: "tom1", label: "Tom 1", cls: "tom" },
    { drum: "tom2", label: "Tom 2", cls: "tom" },
    { drum: "kick", label: "Bombo", cls: "kick" }
  ];
  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">${escapeHtml(stage.title || "Batería")}</p>
    <p class="hint">Toca los tambores y platillos. 🥁</p>
    <div class="drumkit">
      ${pads.map(p => `<button class="drum-pad ${p.cls}" data-drum="${p.drum}" data-play-id="d${p.drum}">${p.label}</button>`).join("")}
    </div>
  `;
  dom.stageArea.querySelectorAll(".drum-pad").forEach(pad => {
    pad.addEventListener("pointerdown", () => {
      playAndEmit(pad.dataset.playId, { drum: pad.dataset.drum }, pad);
    });
  });
}

/* ===== Simón dice (memoria de secuencia) ===== */
function renderSimonStage(stage, isTeacher, closeButton) {
  const pads = [
    { note: "Do", midi: 60, cls: "green" },
    { note: "Mi", midi: 64, cls: "red" },
    { note: "Sol", midi: 67, cls: "blue" },
    { note: "Do8", midi: 72, cls: "yellow" }
  ];
  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">${escapeHtml(stage.title || "Simón dice")}</p>
    <p class="hint" data-simon-msg>Memoriza la secuencia y repítela. Cada ronda añade una nota.</p>
    <div class="simon">
      ${pads.map((p, i) => `<button class="simon-pad ${p.cls}" data-simon="${i}">${p.note}</button>`).join("")}
    </div>
    <button class="primary" data-simon-start>▶ Empezar</button>
  `;

  const padEls = Array.from(dom.stageArea.querySelectorAll(".simon-pad"));
  const msg = dom.stageArea.querySelector("[data-simon-msg]");
  const startBtn = dom.stageArea.querySelector("[data-simon-start]");
  let sequence = [];
  let input = [];
  let accepting = false;

  const blink = i => { playMidi(pads[i].midi, { dur: 0.4 }); flashEl(padEls[i]); };

  const playSequence = () => {
    accepting = false;
    sequence.forEach((idx, n) => gameTimeout(() => blink(idx), 600 * (n + 1)));
    gameTimeout(() => { accepting = true; msg.textContent = "¡Tu turno! Repite la secuencia."; }, 600 * (sequence.length + 1));
  };

  const nextRound = () => {
    input = [];
    sequence.push(Math.floor(Math.random() * pads.length));
    msg.textContent = `Ronda ${sequence.length}. Observa...`;
    gameTimeout(playSequence, 500);
  };

  padEls.forEach((pad, i) => {
    pad.addEventListener("pointerdown", () => {
      if (!accepting) return;
      blink(i);
      input.push(i);
      const pos = input.length - 1;
      if (input[pos] !== sequence[pos]) {
        accepting = false;
        msg.textContent = `¡Casi! Llegaste a la ronda ${sequence.length - 1}. Toca Empezar para reintentar.`;
        if (!isTeacher) sendResponse(`🎵 Simón dice: llegó a la ronda ${sequence.length - 1}`, { simon: true });
        sequence = [];
        return;
      }
      if (input.length === sequence.length) {
        accepting = false;
        msg.textContent = "¡Bien! Siguiente ronda...";
        gameTimeout(nextRound, 900);
      }
    });
  });

  startBtn.addEventListener("click", () => {
    clearGameTimers();
    sequence = [];
    nextRound();
  });
}

/* ===== Adivina la nota (entrenamiento auditivo) ===== */
function renderEarQuizStage(stage, isTeacher, closeButton) {
  const answered = answeredQuizIds.has(stage.id);
  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">Adivina la nota 👂</p>
    <h2 class="stage-question">¿Qué nota suena?</h2>
    <button class="primary" data-ear-play>🔊 Escuchar</button>
    <div class="stage-options">
      ${(stage.options || []).map(n => `<button class="quiz-option" data-ear-answer="${escapeHtml(n)}" ${answered ? "disabled" : ""}>${escapeHtml(n)}</button>`).join("")}
    </div>
    <p class="hint stage-hint">${isTeacher ? `Vista previa · la nota correcta es ${escapeHtml(stage.note)}.` : "Escucha y elige la nota correcta."}</p>
  `;

  dom.stageArea.querySelector("[data-ear-play]").addEventListener("click", () => playNote(stage.note, { dur: 1 }));

  dom.stageArea.querySelectorAll("[data-ear-answer]").forEach(btn => {
    btn.addEventListener("click", () => {
      const answer = btn.dataset.earAnswer;
      const correct = answer === stage.note;
      answeredQuizIds.add(stage.id);
      dom.stageArea.querySelectorAll("[data-ear-answer]").forEach(b => {
        b.disabled = true;
        if (b.dataset.earAnswer === stage.note) b.classList.add("correct");
      });
      btn.classList.add(correct ? "correct" : "wrong");
      const hint = dom.stageArea.querySelector(".stage-hint");
      if (hint) hint.textContent = correct ? "¡Correcto! 🎉" : `Era ${stage.note}.`;
      playNote(stage.note, { dur: 0.8 });
      if (!isTeacher) sendResponse(`${correct ? "✅" : "❌"} Adivina la nota: respondió "${answer}" (era ${stage.note})`, { earId: stage.id });
    });
  });
}

/* ===== Pares musicales (memoria de sonidos) ===== */
function renderMatchStage(stage, isTeacher, closeButton) {
  const base = ["Do", "Re", "Mi", "Sol"];
  if (!stage.deck) {
    stage.deck = [...base, ...base]
      .map(note => ({ note, key: cryptoId() }))
      .sort(() => Math.random() - 0.5);
  }
  dom.stageArea.innerHTML = `
    ${closeButton}
    <p class="label">${escapeHtml(stage.title || "Pares musicales")}</p>
    <p class="hint" data-match-msg>Encuentra las parejas de notas que suenan igual.</p>
    <div class="match-grid">
      ${stage.deck.map((card, i) => `<button class="match-card" data-match="${i}" data-note="${card.note}"><span class="match-face">?</span></button>`).join("")}
    </div>
  `;

  const cards = Array.from(dom.stageArea.querySelectorAll(".match-card"));
  const msg = dom.stageArea.querySelector("[data-match-msg]");
  let first = null;
  let lock = false;
  let matched = 0;

  cards.forEach(card => {
    card.addEventListener("click", () => {
      if (lock || card.classList.contains("revealed") || card.classList.contains("done")) return;
      card.classList.add("revealed");
      card.querySelector(".match-face").textContent = card.dataset.note;
      playNote(card.dataset.note, { dur: 0.6 });

      if (!first) { first = card; return; }

      if (first.dataset.note === card.dataset.note && first !== card) {
        first.classList.add("done"); card.classList.add("done");
        matched += 2; first = null;
        if (matched === cards.length) {
          msg.textContent = "¡Todas las parejas! 🎉";
          if (!isTeacher) sendResponse("🃏 Pares musicales: ¡completó el juego!", { matchId: stage.id });
        }
      } else {
        lock = true;
        const a = first, b = card; first = null;
        gameTimeout(() => {
          [a, b].forEach(c => { c.classList.remove("revealed"); c.querySelector(".match-face").textContent = "?"; });
          lock = false;
        }, 800);
      }
    });
  });
}

/* ===== Cuenta regresiva (capta la atención antes de empezar) ===== */
function renderCountdownStage(stage, closeButton) {
  let n = stage.from || 3;
  dom.stageArea.innerHTML = `${closeButton}<div class="countdown" data-count>${n}</div>`;
  const el = dom.stageArea.querySelector("[data-count]");
  playMidi(72, { dur: 0.25 });
  stageTimer = setInterval(() => {
    n--;
    if (n > 0) {
      el.textContent = n;
      el.classList.remove("go");
      void el.offsetWidth; // reinicia la animación
      el.classList.add("pop");
      playMidi(72, { dur: 0.25 });
    } else {
      el.textContent = "¡Ya! 🎉";
      el.classList.add("go");
      playMidi(84, { dur: 0.6 });
      clearInterval(stageTimer);
      stageTimer = null;
    }
  }, 1000);
}

function renderResources() {
  if (!appState.resources.length) {
    dom.resourceList.innerHTML = `<div class="log-list empty">No hay recursos todavía.</div>`;
    return;
  }

  dom.resourceList.innerHTML = appState.resources.map(resource => {
    const url = safeUrl((String(resource.desc || "").match(/https?:\/\/[^\s]+/) || [])[0]);
    return `
    <article class="resource-card">
      <h3>${escapeHtml(resource.title)}</h3>
      <p>${linkify(escapeHtml(resource.desc || "Sin descripción."))}</p>
      <div class="actions wrap">
        <button class="primary tiny" data-activate-resource="${resource.id}">Activar</button>
        ${url ? `<button class="secondary tiny" data-project-resource="${resource.id}">▶ Proyectar</button>` : ""}
        <button class="ghost tiny" data-delete-resource="${resource.id}">Eliminar</button>
      </div>
    </article>
  `;
  }).join("");

  dom.resourceList.querySelectorAll("[data-project-resource]").forEach(button => {
    button.addEventListener("click", () => {
      const resource = appState.resources.find(item => item.id === button.dataset.projectResource);
      const url = (String(resource?.desc || "").match(/https?:\/\/[^\s]+/) || [])[0];
      if (!resource || !url) return;
      projectResource(resource.title, url);
    });
  });

  dom.resourceList.querySelectorAll("[data-activate-resource]").forEach(button => {
    button.addEventListener("click", () => {
      const resource = appState.resources.find(item => item.id === button.dataset.activateResource);
      if (!resource) return;
      appState.activeResource = resource;
      saveLocal();
      renderAula();
      syncPatch({ activeResource: resource });
      toast("Recurso activado.");
    });
  });

  dom.resourceList.querySelectorAll("[data-delete-resource]").forEach(button => {
    button.addEventListener("click", () => {
      appState.resources = appState.resources.filter(item => item.id !== button.dataset.deleteResource);
      if (appState.activeResource?.id === button.dataset.deleteResource) {
        appState.activeResource = null;
      }
      saveLocal();
      renderResources();
      renderAula();
      syncPatch({ resources: appState.resources, activeResource: appState.activeResource });
    });
  });
}

/* ===== Biblioteca Musicala =====
   Lee los recursos publicados de la biblioteca central (Firestore, solo
   lectura) para que el docente los busque, los proyecte en el escenario o
   se los envíe al estudiante como recurso activo. */

async function initBiblioteca({ force = false } = {}) {
  if (biblioLoading) return;
  biblioLoading = true;
  dom.biblioStatus.textContent = force
    ? "Actualizando la biblioteca..."
    : "Abriendo la biblioteca...";

  try {
    const { items, fromCache, at } = await loadBiblioteca({ force });
    biblioItems = items;
    biblioLoaded = true;
    biblioVisible = 30;
    buildBiblioFilters();
    renderBiblioteca();
    const when = formatDate(new Date(at).toISOString());
    dom.biblioStatus.textContent = `${items.length} recursos disponibles · ${fromCache ? "guardados el" : "actualizados el"} ${when}`;
  } catch (error) {
    console.error("No se pudo cargar la biblioteca", error);
    dom.biblioStatus.textContent = "No se pudo cargar la biblioteca. Revisa tu conexión y toca «Actualizar».";
  } finally {
    biblioLoading = false;
  }
}

// Llena los selectores de filtro con los valores que realmente existen.
function buildBiblioFilters() {
  const fill = (select, values, emptyLabel) => {
    const current = select.value;
    const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
    select.innerHTML = `<option value="">${emptyLabel}</option>` +
      options.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (options.includes(current)) select.value = current;
  };

  fill(dom.biblioArea, biblioItems.map(item => item.especialidad || item.area), "Todas las áreas");
  fill(dom.biblioCategoria, biblioItems.map(item => item.categoria), "Todas las categorías");
  fill(dom.biblioNivel, biblioItems.map(item => item.nivel), "Todos los niveles");
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function filterBiblioteca() {
  const text = normalizeText(dom.biblioSearch.value.trim());
  const area = dom.biblioArea.value;
  const categoria = dom.biblioCategoria.value;
  const nivel = dom.biblioNivel.value;

  return biblioItems.filter(item => {
    if (area && (item.especialidad || item.area) !== area) return false;
    if (categoria && item.categoria !== categoria) return false;
    if (nivel && item.nivel !== nivel) return false;
    if (!text) return true;
    const haystack = normalizeText(
      [item.titulo, item.descripcion, item.tema, item.area, item.especialidad, ...(item.etiquetas || [])].join(" ")
    );
    return text.split(/\s+/).every(word => haystack.includes(word));
  });
}

function renderBiblioteca() {
  if (!biblioLoaded) return;

  const matches = filterBiblioteca();
  const shown = matches.slice(0, biblioVisible);

  if (!matches.length) {
    dom.biblioList.innerHTML = `<div class="log-list empty">Nada por aquí. Prueba con otra palabra o quita filtros.</div>`;
  } else {
    dom.biblioList.innerHTML = shown.map(item => {
      const chips = [item.especialidad || item.area, item.categoria || item.tema, item.nivel]
        .filter(Boolean)
        .map(chip => `<span class="biblio-chip">${escapeHtml(chip)}</span>`)
        .join("");

      const links = item.enlaces
        .map((enlace, index) => ({ enlace, index }))
        .filter(({ enlace }) => safeUrl(enlace.url))
        .map(({ enlace, index }) => `
          <div class="biblio-link">
            <span class="biblio-link-name" title="${escapeHtml(enlace.url)}">${escapeHtml(enlace.titulo || linkHost(enlace.url))}</span>
            <button class="primary tiny" data-biblio-project="${escapeHtml(item.id)}" data-link-index="${index}" title="Se abre en grande para los dos al mismo tiempo">📺 Ver juntos</button>
          </div>
        `).join("");

      return `
        <article class="resource-card biblio-card">
          <h3>${escapeHtml(item.titulo)}</h3>
          ${chips ? `<p class="biblio-meta">${chips}</p>` : ""}
          ${item.descripcion ? `<p>${escapeHtml(shorten(item.descripcion, 180))}</p>` : ""}
          ${links}
        </article>
      `;
    }).join("");
  }

  dom.biblioMore.classList.toggle("hidden", matches.length <= biblioVisible);
  if (biblioLoaded && biblioItems.length) {
    dom.biblioStatus.textContent = `${matches.length} de ${biblioItems.length} recursos`;
  }

  dom.biblioList.querySelectorAll("[data-biblio-project]").forEach(button => {
    button.addEventListener("click", () => {
      const item = biblioItems.find(i => i.id === button.dataset.biblioProject);
      const enlace = item?.enlaces[Number(button.dataset.linkIndex)];
      if (!item || !enlace) return;
      projectResource(item.titulo, enlace.url);
    });
  });

}

// Lanza un recurso al escenario de ambos participantes.
function projectResource(title, url) {
  const clean = safeUrl(url);
  if (!clean) {
    toast("Ese enlace no se puede proyectar.");
    return;
  }
  launchStage({
    kind: "resource",
    title,
    url: clean,
    embed: buildResourceEmbed(clean)
  });
  toast("Recurso proyectado en el escenario de ambos.");
}

function shorten(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function linkHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "enlace";
  }
}

// Solo URLs http(s) reales: evita javascript: y similares en atributos.
function safeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

// Decide cómo incrustar un enlace en el escenario.
function buildResourceEmbed(url) {
  let match = url.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,20})/);
  if (match) return { type: "youtube", src: `https://www.youtube.com/embed/${match[1]}?rel=0` };

  match = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (match) return { type: "iframe", src: `https://drive.google.com/file/d/${match[1]}/preview` };

  match = url.match(/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]+)/);
  if (match) return { type: "iframe", src: `https://docs.google.com/${match[1]}/d/${match[2]}/preview` };

  match = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (match) return { type: "iframe", src: `https://player.vimeo.com/video/${match[1]}` };

  match = url.match(/canva\.com\/design\/([\w-]+)/);
  if (match) return { type: "iframe", src: `https://www.canva.com/design/${match[1]}/view?embed` };

  if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url)) return { type: "image", src: url };

  // PDF directo: el visor de Google lo incrusta de forma fiable aunque venga
  // de otro dominio (un <iframe> al PDF crudo suele bloquearse).
  if (/\.pdf(\?|$)/i.test(url)) {
    return { type: "iframe", src: `https://docs.google.com/viewer?embedded=true&url=${encodeURIComponent(url)}` };
  }

  // Resto de páginas: se intenta incrustar; si el sitio lo bloquea, queda
  // el botón de abrir en pestaña nueva.
  return { type: "iframe", src: url };
}

function renderResourceStage(stage, isTeacher, closeButton) {
  const url = safeUrl(stage.url);
  const embed = stage.embed;
  let media = "";

  if (embed?.type === "image" && safeUrl(embed.src)) {
    media = `<img class="stage-img" src="${escapeHtml(embed.src)}" alt="${escapeHtml(stage.title || "Recurso")}" />`;
  } else if (embed?.src && safeUrl(embed.src)) {
    media = `
      <div class="stage-embed">
        <iframe src="${escapeHtml(embed.src)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe>
      </div>
    `;
  }

  const soundNote = embed?.type === "youtube"
    ? " · El video suena en cada dispositivo por separado."
    : "";

  // Páginas genéricas (no YouTube/Drive/Docs/Vimeo/Canva/imagen/PDF): el sitio
  // podría bloquear la incrustación y verse en blanco. Avisamos con un plan B.
  const genericEmbed = embed?.type === "iframe" && embed.src === url;
  const blockNote = genericEmbed
    ? `<p class="stage-hint">¿Se ve en blanco? Este sitio no permite mostrarse aquí. Ábranlo los dos con el botón de abajo. 👇</p>`
    : "";

  const toolsRow = isTeacher && media ? `
    <div class="annot-tools" data-annot-tools>
      <button class="secondary tiny" data-tool="pointer" title="El estudiante ve tu dedo moverse sobre el recurso">👆 Señalar</button>
      <button class="secondary tiny" data-tool="draw" title="Dibuja encima y el estudiante lo ve en vivo">✏️ Dibujar</button>
      <button class="ghost tiny" data-annot-clear>🧽 Limpiar</button>
    </div>
    <p class="hint annot-hint">Con Señalar o Dibujar activo, el documento/video no recibe clics: vuelve a tocar la herramienta para desactivarla.</p>
  ` : "";

  const focusToggle = `<button class="stage-focus-toggle secondary tiny" data-focus-toggle>${focusCollapsed ? "⛶ Pantalla completa" : "⤢ Ver cámaras"}</button>`;

  dom.stageArea.innerHTML = `
    ${closeButton}
    ${focusToggle}
    <p class="label">Recurso de la biblioteca</p>
    <h2 class="stage-resource-title">${escapeHtml(stage.title || "Recurso")}</h2>
    ${media ? `
      <div class="stage-media" data-annot-media>
        ${media}
        <canvas class="annot-canvas" data-annot-canvas></canvas>
        <div class="annot-pointer hidden" data-annot-pointer>👆</div>
      </div>
    ` : ""}
    ${toolsRow}
    ${blockNote}
    ${url ? `<p class="stage-hint"><a class="stage-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Abrir en pestaña nueva ↗</a>${soundNote}</p>` : ""}
    ${!media && !url ? `<p class="stage-hint">Este recurso no tiene enlace para mostrar.</p>` : ""}
  `;

  const focusBtn = dom.stageArea.querySelector("[data-focus-toggle]");
  if (focusBtn) {
    focusBtn.addEventListener("click", () => {
      focusCollapsed = !focusCollapsed;
      applyFocus();
      focusBtn.textContent = focusCollapsed ? "⛶ Pantalla completa" : "⤢ Ver cámaras";
    });
  }

  if (media) setupResourceAnnotations(stage, isTeacher);
}

/* ===== Puntero compartido y anotaciones sobre el recurso =====
   El docente puede señalar (el estudiante ve su dedo moverse) o dibujar
   encima del recurso proyectado. Los trazos viajan por RTDB en coordenadas
   normalizadas (0..1), así se ven bien en pantallas de distinto tamaño. */

let annotUnsubs = [];
let annotStrokes = new Map(); // strokeId -> { pts: [{x,y}, ...] }
let annotTool = null;

/* ===== Modo enfoque =====
   Al proyectar un recurso la sala se concentra en él: se oculta el panel de
   herramientas y las cámaras pasan a un recuadro flotante, así el recurso
   ocupa casi toda la pantalla en ambos participantes. Cada quien puede
   plegarlo localmente (ver las cámaras en grande) sin cerrar el recurso. */
let focusWanted = false;    // el escenario actual pide modo enfoque
let focusCollapsed = false; // este usuario decidió salir del enfoque localmente

function applyFocus() {
  document.body.classList.toggle("focus-mode", focusWanted && !focusCollapsed);
}

function setFocusMode(on) {
  if (!on) focusCollapsed = false; // al cerrar el recurso se reinicia
  focusWanted = on;
  applyFocus();
}

function clearAnnotations() {
  annotUnsubs.forEach(unsub => { try { unsub(); } catch {} });
  annotUnsubs = [];
  annotStrokes = new Map();
  annotTool = null;
}

function setupResourceAnnotations(stage, isTeacher) {
  const media = dom.stageArea.querySelector("[data-annot-media]");
  const canvas = dom.stageArea.querySelector("[data-annot-canvas]");
  const pointerEl = dom.stageArea.querySelector("[data-annot-pointer]");
  if (!media || !canvas) return;

  const ctx = canvas.getContext("2d");
  const INK = "#e0218a";

  const drawPts = pts => {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x * canvas.width, pts[0].y * canvas.height);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * canvas.width, pts[i].y * canvas.height);
    }
    ctx.stroke();
  };

  const redraw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of annotStrokes.values()) drawPts(s.pts);
  };

  // El bitmap del canvas debe seguir el tamaño real del recurso. No basta con
  // ResizeObserver (no existe en todos los entornos): también se re-verifica
  // al redimensionar la ventana, al cargar la imagen y antes de cada uso.
  const syncSize = () => {
    const rect = media.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      redraw();
    }
  };
  syncSize();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(syncSize);
    observer.observe(media);
    annotUnsubs.push(() => observer.disconnect());
  }
  window.addEventListener("resize", syncSize);
  annotUnsubs.push(() => window.removeEventListener("resize", syncSize));
  media.querySelector("img")?.addEventListener("load", syncSize);

  // Todos escuchan los trazos y el puntero del otro lado.
  if (firebaseReady && roomPath) {
    const eventsRef = ref(db, `${roomPath}/annot/${stage.id}/events`);
    annotUnsubs.push(onChildAdded(eventsRef, snap => {
      const ev = snap.val();
      if (!ev) return;
      if (ev.kind === "clear") {
        annotStrokes = new Map();
        redraw();
        return;
      }
      if (ev.kind === "seg" && ev.by !== CLIENT_ID && Array.isArray(ev.pts)) {
        syncSize();
        const s = annotStrokes.get(ev.strokeId) || { pts: [] };
        // Conecta con el último punto previo para que el trazo sea continuo.
        const joined = s.pts.length ? [s.pts[s.pts.length - 1], ...ev.pts] : ev.pts;
        s.pts = s.pts.concat(ev.pts);
        annotStrokes.set(ev.strokeId, s);
        drawPts(joined);
      }
    }));

    const pointerRef = ref(db, `${roomPath}/annot/${stage.id}/pointer`);
    annotUnsubs.push(onValue(pointerRef, snap => {
      const p = snap.val();
      if (!p || !p.on || p.by === CLIENT_ID) {
        pointerEl.classList.add("hidden");
        return;
      }
      pointerEl.classList.remove("hidden");
      pointerEl.style.left = (p.x * 100) + "%";
      pointerEl.style.top = (p.y * 100) + "%";
    }));
  }

  if (!isTeacher) return;

  /* --- Herramientas del docente --- */
  const tools = dom.stageArea.querySelector("[data-annot-tools]");
  if (!tools) return;

  const sendPointer = pos => {
    if (!firebaseReady || !roomPath) return;
    set(ref(db, `${roomPath}/annot/${stage.id}/pointer`),
      pos ? { ...pos, on: true, by: CLIENT_ID } : { on: false, by: CLIENT_ID }
    ).catch(() => {});
  };

  const setTool = tool => {
    annotTool = annotTool === tool ? null : tool;
    syncSize();
    canvas.classList.toggle("active", !!annotTool);
    canvas.style.cursor = annotTool === "draw" ? "crosshair" : annotTool === "pointer" ? "pointer" : "";
    tools.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === annotTool));
    if (!annotTool) sendPointer(null);
  };
  tools.querySelector('[data-tool="pointer"]').addEventListener("click", () => setTool("pointer"));
  tools.querySelector('[data-tool="draw"]').addEventListener("click", () => setTool("draw"));
  tools.querySelector("[data-annot-clear]").addEventListener("click", () => {
    annotStrokes = new Map();
    redraw();
    if (firebaseReady && roomPath) {
      push(ref(db, `${roomPath}/annot/${stage.id}/events`), { kind: "clear", by: CLIENT_ID }).catch(() => {});
    }
  });

  const norm = e => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * 1000) / 1000,
      y: Math.round(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) * 1000) / 1000
    };
  };

  let stroke = null; // { id, pts, pending }
  let lastPointerSend = 0;

  const flushStroke = () => {
    if (!stroke || !stroke.pending.length) return;
    if (firebaseReady && roomPath) {
      push(ref(db, `${roomPath}/annot/${stage.id}/events`), {
        kind: "seg", strokeId: stroke.id, by: CLIENT_ID, pts: stroke.pending
      }).catch(() => {});
    }
    stroke.pending = [];
  };

  const endStroke = () => {
    if (!stroke) return;
    flushStroke();
    annotStrokes.set(stroke.id, { pts: stroke.pts });
    stroke = null;
  };

  canvas.addEventListener("pointerdown", e => {
    if (annotTool !== "draw") return;
    syncSize();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const p = norm(e);
    stroke = { id: cryptoId(), pts: [p], pending: [p] };
  });

  canvas.addEventListener("pointermove", e => {
    if (annotTool === "pointer") {
      const now = Date.now();
      if (now - lastPointerSend > 60) {
        lastPointerSend = now;
        sendPointer(norm(e));
      }
      return;
    }
    if (annotTool !== "draw" || !stroke) return;
    const prev = stroke.pts[stroke.pts.length - 1];
    const p = norm(e);
    stroke.pts.push(p);
    stroke.pending.push(p);
    drawPts([prev, p]);
    if (stroke.pending.length >= 10) flushStroke(); // el otro lado lo ve casi en vivo
  });

  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", () => {
    if (annotTool === "pointer") sendPointer(null);
  });
}

function buildScaleExercise() {
  const root = dom.rootNote.value;
  const mode = dom.exerciseMode.value;
  let sequence = rotateNotes(root);

  if (mode === "desc") {
    sequence = [...sequence].reverse();
  }

  if (mode === "salteado") {
    sequence = buildSkipPattern(root);
  }

  const titleMap = {
    asc: `Secuencia ascendente desde ${root}`,
    desc: `Secuencia descendente desde ${root}`,
    salteado: `Secuencia salteada desde ${root}`
  };

  return {
    id: cryptoId(),
    type: "note-sequence",
    title: titleMap[mode],
    root,
    mode,
    sequence,
    instruction: `Lee, canta o toca esta secuencia iniciando desde ${root}.`
  };
}

function renderScalePreview() {
  if (!dom.scalePreview) return;

  const exercise = buildScaleExercise();
  dom.scalePreview.innerHTML = exercise.sequence
    .map(note => `<span class="note-pill">${escapeHtml(note)}</span>`)
    .join("");
}

function rotateNotes(root) {
  const index = NOTES.indexOf(root);
  const rotated = [...NOTES.slice(index), ...NOTES.slice(0, index)];
  return [...rotated, root];
}

function buildSkipPattern(root) {
  const sequence = rotateNotes(root).slice(0, 7);
  const result = [];

  for (let i = 0; i < sequence.length; i += 2) result.push(sequence[i]);
  for (let i = 1; i < sequence.length; i += 2) result.push(sequence[i]);

  result.push(root);
  return result;
}

function renderResponses() {
  if (!appState.responses.length) {
    dom.responsesList.className = "log-list empty";
    dom.responsesList.textContent = "Aún no hay mensajes. ¡Escribe el primero!";
    return;
  }

  // Como en cualquier chat: los mensajes más recientes abajo.
  dom.responsesList.className = "log-list chat-list";
  dom.responsesList.innerHTML = appState.responses.slice(0, 30).reverse().map(response => {
    const mine = response.name === appState.displayName;
    return `
    <div class="chat-msg ${mine ? "mine" : "theirs"}">
      ${mine ? "" : `<small class="chat-author">${escapeHtml(response.name)} · ${escapeHtml(labelRole(response.role))}</small>`}
      <p>${escapeHtml(response.text)}</p>
      <small class="chat-time">${formatTime(response.at)}</small>
    </div>
  `;
  }).join("");
  dom.responsesList.scrollTop = dom.responsesList.scrollHeight;
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat("es-CO", { timeStyle: "short" }).format(new Date(value));
  } catch {
    return "";
  }
}

function renderLogs() {
  if (!appState.logs.length) {
    dom.classLogList.className = "log-list empty";
    dom.classLogList.textContent = "Aún no hay registros.";
    return;
  }

  dom.classLogList.className = "log-list";
  dom.classLogList.innerHTML = appState.logs.slice(0, 12).map(log => `
    <article class="log-item">
      <strong>${formatDate(log.at)}</strong>
      ${log.workedOn ? `<p><strong>Trabajado:</strong> ${escapeHtml(log.workedOn)}</p>` : ""}
      ${log.progress ? `<p><strong>Avance:</strong> ${escapeHtml(log.progress)}</p>` : ""}
      ${log.homework ? `<p><strong>Tarea:</strong> ${escapeHtml(log.homework)}</p>` : ""}
    </article>
  `).join("");
}

/* ===== Metrónomo sincronizado =====
   El docente publica { bpm, meter, startAt } con hora del servidor.
   Cada dispositivo agenda los clics localmente con Web Audio usando
   el offset de reloj de Firebase (.info/serverTimeOffset), así ambos
   lados escuchan el mismo pulso sin depender de la latencia de red. */

function serverNow() {
  return Date.now() + serverTimeOffset;
}

function ensureAudio() {
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function startSharedMetronome() {
  const bpm = Math.max(40, Math.min(240, Number(dom.bpm.value) || 80));
  const meter = Number(dom.meter.value) || 0;
  const state = {
    running: true,
    bpm,
    meter,
    startAt: serverNow() + 400 // pequeño margen para que la señal llegue al otro lado
  };
  applyMetronome(state);
  syncPatch({ metronome: state });
}

function stopSharedMetronome() {
  applyMetronome(null);
  syncPatch({ metronome: null });
}

function applyMetronome(state) {
  const changed = JSON.stringify(state) !== JSON.stringify(metro);
  metro = state;
  renderMetronomeUI();
  if (!changed) return;

  stopMetroScheduler();
  if (metro?.running) startMetroScheduler();
}

function startMetroScheduler() {
  const ctx = ensureAudio();
  const intervalMs = 60000 / metro.bpm;

  // Próximo pulso que aún no ha sonado
  metroNextBeat = Math.max(0, Math.ceil((serverNow() - metro.startAt) / intervalMs));

  const LOOKAHEAD_S = 0.15;

  const schedule = () => {
    if (!metro?.running) return;
    const nowServer = serverNow();

    while (true) {
      const beatServerMs = metro.startAt + metroNextBeat * intervalMs;
      const inSeconds = (beatServerMs - nowServer) / 1000;
      if (inSeconds > LOOKAHEAD_S) break;

      const when = ctx.currentTime + Math.max(0, inSeconds);
      const accent = metro.meter > 1 && metroNextBeat % metro.meter === 0;
      clickAt(ctx, when, accent);

      const delayMs = Math.max(0, beatServerMs - nowServer);
      setTimeout(() => flashBeat(accent), delayMs);

      metroNextBeat++;
    }
  };

  schedule();
  metroSchedulerTimer = setInterval(schedule, 50);
}

function stopMetroScheduler() {
  if (metroSchedulerTimer) clearInterval(metroSchedulerTimer);
  metroSchedulerTimer = null;
  dom.beatIndicator?.classList.remove("on");
  dom.beatIndicatorAula?.classList.remove("on");
}

function clickAt(ctx, when, accent) {
  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = accent ? 1320 : 880;
    gain.gain.setValueAtTime(accent ? 0.09 : 0.05, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(when);
    oscillator.stop(when + 0.06);
  } catch {
    // Si el navegador bloquea audio, el indicador visual igual sirve.
  }
}

function flashBeat(accent) {
  [dom.beatIndicator, dom.beatIndicatorAula].forEach(el => {
    if (!el) return;
    el.classList.add("on");
    el.style.background = accent ? "var(--blue)" : "";
    setTimeout(() => el.classList.remove("on"), 90);
  });
}

function renderMetronomeUI() {
  const running = !!metro?.running;
  if (dom.toggleMetronome) dom.toggleMetronome.textContent = running ? "Detener" : "Iniciar";
  if (running && dom.bpm && Number(dom.bpm.value) !== metro.bpm) dom.bpm.value = metro.bpm;

  if (dom.metroChip) {
    dom.metroChip.classList.toggle("hidden", !running);
    dom.metroChip.classList.toggle("playing", running);
    if (running) dom.metroChip.textContent = `♩ ${metro.bpm} BPM`;
  }
  if (dom.metroStateText) {
    dom.metroStateText.textContent = running
      ? `Sonando · ${metro.bpm} BPM${metro.meter > 1 ? ` · ${metro.meter}/4` : ""}`
      : "Apagado";
  }
}

// Distancia de un instante (hora servidor) al pulso más cercano del metrónomo.
// Devuelve { deltaMs, beatIndex } — delta negativo = adelantado, positivo = atrasado.
function beatOffset(tServerMs) {
  if (!metro?.running) return null;
  const intervalMs = 60000 / metro.bpm;
  const beatIndex = Math.round((tServerMs - metro.startAt) / intervalMs);
  return { deltaMs: tServerMs - (metro.startAt + beatIndex * intervalMs), beatIndex };
}

/* ===== Modo música y diagnóstico ===== */

// Audio sin filtros de voz: el procesamiento (cancelación de eco, supresión
// de ruido, control de ganancia) recorta el sonido de los instrumentos.
async function toggleMusicMode() {
  musicMode = !musicMode;
  dom.toggleMusicMode.classList.toggle("on", musicMode);

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
    tagAudioAsMusic(newStream);
    const newTrack = newStream.getAudioTracks()[0];
    newTrack.enabled = micOn;

    const oldTrack = localStream?.getAudioTracks()[0];
    if (oldTrack && localStream) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream?.addTrack(newTrack);

    if (musicMixer) {
      refreshMixerMic(); // la mezcla con la música sigue siendo el track enviado
    } else {
      forEachSender("audio", sender => sender.replaceTrack(newTrack).catch(console.warn));
    }

    localStorage.setItem("musiaula-music-mode", musicMode ? "1" : "0");
    toast(musicMode
      ? "🎼 Modo música activado: audio sin ningún filtro. Usa audífonos para evitar eco."
      : "Modo voz activado: cancelación de eco encendida (sin filtros que recorten la música).");
  } catch (error) {
    console.error("No se pudo cambiar el modo de audio", error);
    musicMode = !musicMode;
    dom.toggleMusicMode.classList.toggle("on", musicMode);
    toast("No se pudo cambiar el modo de audio.");
  }
}

function startStats() {
  stopStats();
  statsTimer = setInterval(updateStats, 2000);
  updateStats();
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

let lastBytes = { sent: 0, received: 0, at: 0 };

async function updateStats() {
  if (!peers.size) {
    dom.statsPanel.innerHTML = "Sin conexión de video activa.";
    return;
  }

  try {
    // Con varias conexiones se muestra el peor caso (latencia/jitter más
    // altos) y la suma de tráfico: lo que importa para diagnosticar.
    let rtt = null, jitter = null, packetsLost = 0, packetsReceived = 0;
    let bytesSent = 0, bytesReceived = 0, audioLevel = null;

    for (const { pc } of peers.values()) {
      const stats = await pc.getStats();
      stats.forEach(report => {
        if (report.type === "candidate-pair" && report.nominated && report.currentRoundTripTime != null) {
          const value = report.currentRoundTripTime * 1000;
          rtt = rtt == null ? value : Math.max(rtt, value);
        }
        if (report.type === "inbound-rtp") {
          packetsLost += report.packetsLost || 0;
          packetsReceived += report.packetsReceived || 0;
          if (report.kind === "audio" && report.jitter != null) {
            const value = report.jitter * 1000;
            jitter = jitter == null ? value : Math.max(jitter, value);
          }
          bytesReceived += report.bytesReceived || 0;
        }
        if (report.type === "outbound-rtp") bytesSent += report.bytesSent || 0;
        if (report.type === "media-source" && report.kind === "audio" && report.audioLevel != null) {
          audioLevel = report.audioLevel;
        }
      });
    }

    const now = Date.now();
    let upKbps = 0, downKbps = 0;
    if (lastBytes.at) {
      const seconds = (now - lastBytes.at) / 1000;
      upKbps = Math.round((bytesSent - lastBytes.sent) * 8 / 1000 / seconds);
      downKbps = Math.round((bytesReceived - lastBytes.received) * 8 / 1000 / seconds);
    }
    lastBytes = { sent: bytesSent, received: bytesReceived, at: now };

    const lossPct = packetsReceived ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0;
    const grade = (value, good, warn) =>
      value == null ? "" : value <= good ? "ok" : value <= warn ? "warn" : "bad";

    dom.statsPanel.innerHTML = `
      <div><span class="${grade(rtt, 100, 250)}">Latencia (RTT): ${rtt == null ? "—" : Math.round(rtt) + " ms"}</span></div>
      <div><span class="${grade(jitter, 15, 40)}">Jitter audio: ${jitter == null ? "—" : jitter.toFixed(1) + " ms"}</span></div>
      <div><span class="${grade(lossPct, 1, 4)}">Paquetes perdidos: ${lossPct.toFixed(1)}%</span></div>
      <div>Subida: ${upKbps} kbps · Bajada: ${downKbps} kbps</div>
      <div>Mic nivel: ${audioLevel == null ? "—" : "▮".repeat(Math.max(1, Math.round(audioLevel * 12)))}</div>
      <div>Modo audio: ${musicMode ? "🎼 música" : "🎙️ voz"}</div>
      <div>Reloj vs servidor: ${Math.round(serverTimeOffset)} ms</div>
    `;
  } catch (error) {
    console.warn("No se pudieron leer las estadísticas", error);
  }
}

function exportJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    state: appState
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `musiaula-${appState.room || "clase"}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function clearLocalData() {
  localStorage.removeItem(STORAGE_KEY);
  appState = {
    ...appState,
    objective: "",
    activeResource: null,
    activeExercise: null,
    stage: null,
    resources: defaultResources,
    responses: [],
    logs: []
  };
  saveLocal();
  renderAll();
  toast("Datos locales limpiados.");
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...appState,
    savedAt: new Date().toISOString()
  }));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    appState = {
      ...appState,
      ...parsed,
      stage: null,
      resources: Array.isArray(parsed.resources) && parsed.resources.length ? parsed.resources : defaultResources,
      responses: Array.isArray(parsed.responses) ? parsed.responses : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : []
    };
  } catch (error) {
    console.warn("No se pudo cargar localStorage", error);
  }
}

function activateTab(tabId) {
  dom.tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.tab === tabId));
  document.querySelectorAll(".tab-content").forEach(content => {
    content.classList.toggle("active", content.id === tabId);
  });

  // La biblioteca se descarga solo cuando el docente abre Recursos.
  if (tabId === "tab-recursos" && appState.role !== "estudiante" && !biblioLoaded) {
    initBiblioteca();
  }
}

function copyLink() {
  const link = buildInviteUrl();
  navigator.clipboard?.writeText(link).then(() => {
    toast("Enlace de estudiante copiado. Envíalo al otro dispositivo.");
  }).catch(() => {
    window.prompt("Copia este enlace:", link);
  });
}

// Enlace de invitación: el destinatario entra siempre como ESTUDIANTE.
// No lleva el nombre del docente; el invitado se conecta de una con sesión anónima.
function buildInviteUrl() {
  const url = new URL(location.href);
  url.searchParams.set("room", normalizeRoom(dom.roomName.value || appState.room || makeRoomName()));
  url.searchParams.set("role", "estudiante");
  url.searchParams.delete("name");
  return url.toString();
}

function buildClassUrl(includeName) {
  const url = new URL(location.href);
  url.searchParams.set("room", normalizeRoom(dom.roomName.value || appState.room || makeRoomName()));

  if (includeName) {
    url.searchParams.set("name", appState.displayName || dom.displayName.value.trim() || "Participante");
    url.searchParams.set("role", appState.role || dom.role.value || "docente");
  } else {
    url.searchParams.delete("name");
    url.searchParams.delete("role");
  }

  return url.toString();
}

function makeRoomName() {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");
  return `musicala-aula-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeRoom(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || makeRoomName();
}

function cryptoId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function labelRole(role) {
  return {
    docente: "Docente",
    estudiante: "Estudiante",
    observador: "Observador"
  }[role] || role || "Participante";
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("es-CO", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function linkify(value) {
  return value.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );
}

let toastTimer = null;
function toast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 3500);
}
