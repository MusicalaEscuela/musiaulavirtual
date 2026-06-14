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

const NOTES = ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"];
const STORAGE_KEY = "musiaula_prototipo_v2";

const RTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ]
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

let peer = null;
let localStream = null;
let remoteConnected = false;
let micOn = true;
let camOn = true;
let musicMode = false;
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

let appState = {
  room: "",
  displayName: "",
  role: "docente",
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
    "toast", "lobby", "app", "joinForm", "displayName", "role", "roomName", "randomRoom",
    "copyLobbyLink", "roomTitle", "connectionStatus", "copyClassLink",
    "leaveClass", "objectiveInput", "publishObjective", "objectiveView",
    "activeResourceTitle", "activeResourceDesc", "activeExerciseTitle", "activeExerciseBody",
    "responsesList", "resourceList", "addResource", "resourceTitle", "resourceDesc",
    "createResource", "rootNote", "exerciseMode", "scalePreview", "previewScale",
    "launchScale", "bpm", "toggleMetronome", "beatIndicator", "workedOn", "progress",
    "homework", "saveLog", "exportLog", "clearLocal", "classLogList", "sendState",
    "stageArea", "stageNote", "btnStageNote", "btnStageSeq", "btnStageQuiz",
    "btnStagePulse", "btnStageCelebrate", "btnStageClear",
    "videoArea", "remoteVideo", "remotePlaceholder", "localVideo",
    "toggleMic", "toggleCam", "toggleMusicMode", "toggleStats", "statsPanel", "reconnectVideo",
    "authGate", "googleLogin", "emailForm", "authEmail", "authPassword",
    "registerBtn", "resetPassword", "logoutBtn", "userBadge",
    "metroChip", "metroStateText", "beatIndicatorAula", "meter"
  ].forEach(id => dom[id] = document.getElementById(id));

  dom.tabs = Array.from(document.querySelectorAll(".tab"));
  dom.quickResponses = Array.from(document.querySelectorAll("[data-response]"));
}

function setupEvents() {
  setupAuthEvents();

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
      toast("Respuesta enviada.");
    });
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

  dom.toggleStats.addEventListener("click", () => {
    const show = dom.statsPanel.classList.toggle("hidden") === false;
    dom.toggleStats.classList.toggle("on", show);
    if (show) startStats();
    else stopStats();
  });

  dom.reconnectVideo.addEventListener("click", () => {
    toast("Reiniciando conexión de video...");
    startTeacherCall();
  });
}

function launchStage(stage) {
  appState.stage = { id: cryptoId(), at: new Date().toISOString(), ...stage };
  saveLocal();
  renderStage();
  syncPatch({ stage: appState.stage });
}

function clearStage() {
  appState.stage = null;
  saveLocal();
  renderStage();
  syncPatch({ stage: null });
  toast("Escenario limpio.");
}

/* ===== Sala: Firebase ===== */

function enterClass({ room, displayName, role }) {
  if (!displayName) {
    toast("Falta el nombre para entrar.");
    return;
  }

  appState.room = normalizeRoom(room);
  appState.displayName = displayName;
  appState.role = role || "docente";
  saveLocal();

  document.body.classList.toggle("role-estudiante", appState.role === "estudiante");
  document.body.classList.toggle("role-docente", appState.role !== "estudiante");

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

  try {
    // Presencia: aparezco en la sala y desaparezco solo si me desconecto.
    presenceRef = push(ref(db, `${roomPath}/participants`));
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

  listen(ref(db, `${roomPath}/participants`), snapshot => {
    participantsCount = snapshot.size || 0;
    renderStatusCount();
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

  setStatus("En sala", true);
  startVideo();
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
    objective: appState.objective || "",
    activeResource: appState.activeResource,
    activeExercise: appState.activeExercise,
    stage: appState.stage,
    resources: appState.resources,
    metronome: metro
  };
}

function mergeState(incoming) {
  const allowed = ["objective", "activeResource", "activeExercise", "stage", "resources"];
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
    if (key === "stage" && JSON.stringify(incoming.stage) !== JSON.stringify(appState.stage)) {
      stageChanged = true;
    }
    appState[key] = incoming[key];
  });

  // Metrónomo compartido: aplicar siempre (null/ausente = apagado)
  applyMetronome(incoming.metronome || null);

  if (!Array.isArray(appState.resources)) appState.resources = [];
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

/* ===== Video 1 a 1: WebRTC con señalización por Firebase ===== */

async function startVideo() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    dom.localVideo.srcObject = localStream;
  } catch (error) {
    console.error("Sin acceso a cámara/micrófono", error);
    toast("No hay acceso a cámara o micrófono. El aula funciona, pero sin video.");
    dom.remotePlaceholder.querySelector("p").textContent = "Sin cámara local. Revisa permisos del navegador.";
    return;
  }

  if (appState.role !== "estudiante") {
    startTeacherCall();
  } else {
    listenForOffer();
  }
}

function createPeer() {
  closePeer();
  peer = new RTCPeerConnection(RTC_CONFIG);

  localStream?.getTracks().forEach(track => peer.addTrack(track, localStream));

  peer.ontrack = event => {
    dom.remoteVideo.srcObject = event.streams[0];
    remoteConnected = true;
    dom.remotePlaceholder.classList.add("hidden");
  };

  peer.onconnectionstatechange = () => {
    if (!peer) return;
    if (peer.connectionState === "connected") {
      setStatus(`Video conectado · ${Math.max(participantsCount, 2)} personas`, true);
    }
    if (["disconnected", "failed"].includes(peer.connectionState)) {
      remoteConnected = false;
      dom.remotePlaceholder.classList.remove("hidden");
      dom.remotePlaceholder.querySelector("p").textContent = "Se perdió la conexión de video...";
      setStatus("Video desconectado", false);
    }
  };

  return peer;
}

function closePeer() {
  if (peer) {
    try { peer.close(); } catch {}
    peer = null;
  }
}

function hangUp() {
  closePeer();
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  if (appState.role !== "estudiante" && firebaseReady && roomPath) {
    remove(ref(db, `${roomPath}/webrtc`)).catch(() => {});
  }
}

// Docente = quien llama: publica oferta y espera respuesta.
async function startTeacherCall() {
  if (!localStream || !firebaseReady || !roomPath) return;

  const rtcRef = ref(db, `${roomPath}/webrtc`);
  await remove(rtcRef).catch(() => {});

  const pc = createPeer();
  const sessionId = cryptoId();

  pc.onicecandidate = event => {
    if (event.candidate) {
      push(ref(db, `${roomPath}/webrtc/callerCandidates`), event.candidate.toJSON()).catch(console.warn);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(ref(db, `${roomPath}/webrtc/offer`), {
    sessionId,
    type: offer.type,
    sdp: offer.sdp
  });

  listen(ref(db, `${roomPath}/webrtc/answer`), async snapshot => {
    const answer = snapshot.val();
    if (!answer || !pc || pc !== peer) return;
    if (pc.signalingState !== "have-local-offer") return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.warn("No se pudo aplicar la respuesta", error);
    }
  });

  listen(query(ref(db, `${roomPath}/webrtc/calleeCandidates`), limitToLast(60)), null, async snap => {
    if (!pc || pc !== peer) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(snap.val()));
    } catch (error) {
      console.warn("Candidato inválido", error);
    }
  });
}

// Estudiante = quien contesta: espera la oferta del docente.
function listenForOffer() {
  let answeredSession = null;

  listen(ref(db, `${roomPath}/webrtc/offer`), async snapshot => {
    const offer = snapshot.val();
    if (!offer || !offer.sdp || offer.sessionId === answeredSession) return;
    answeredSession = offer.sessionId;

    const pc = createPeer();

    pc.onicecandidate = event => {
      if (event.candidate) {
        push(ref(db, `${roomPath}/webrtc/calleeCandidates`), event.candidate.toJSON()).catch(console.warn);
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, `${roomPath}/webrtc/answer`), { type: answer.type, sdp: answer.sdp });
    } catch (error) {
      console.error("No se pudo contestar la llamada", error);
      return;
    }

    listen(query(ref(db, `${roomPath}/webrtc/callerCandidates`), limitToLast(60)), null, async snap => {
      if (!pc || pc !== peer) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(snap.val()));
      } catch (error) {
        console.warn("Candidato inválido", error);
      }
    });
  });
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
    dom.activeResourceTitle.textContent = appState.activeResource.title;
    dom.activeResourceDesc.textContent = appState.activeResource.desc || "Sin descripción.";
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

  const stage = appState.stage;
  if (!stage) {
    dom.stageArea.classList.add("hidden");
    dom.stageArea.innerHTML = "";
    return;
  }

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

function renderResources() {
  if (!appState.resources.length) {
    dom.resourceList.innerHTML = `<div class="log-list empty">No hay recursos todavía.</div>`;
    return;
  }

  dom.resourceList.innerHTML = appState.resources.map(resource => `
    <article class="resource-card">
      <h3>${escapeHtml(resource.title)}</h3>
      <p>${linkify(escapeHtml(resource.desc || "Sin descripción."))}</p>
      <div class="actions wrap">
        <button class="primary tiny" data-activate-resource="${resource.id}">Activar</button>
        <button class="ghost tiny" data-delete-resource="${resource.id}">Eliminar</button>
      </div>
    </article>
  `).join("");

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
    dom.responsesList.textContent = "Aún no hay respuestas.";
    return;
  }

  dom.responsesList.className = "log-list";
  dom.responsesList.innerHTML = appState.responses.slice(0, 12).map(response => `
    <div class="log-item">
      <strong>${escapeHtml(response.name)}</strong> · ${escapeHtml(labelRole(response.role))}
      <br>${escapeHtml(response.text)}
      <br><small>${formatDate(response.at)}</small>
    </div>
  `).join("");
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
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: musicMode
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
        : { echoCancellation: true, noiseSuppression: true }
    });
    const newTrack = newStream.getAudioTracks()[0];
    newTrack.enabled = micOn;

    const oldTrack = localStream?.getAudioTracks()[0];
    if (oldTrack && localStream) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream?.addTrack(newTrack);

    const sender = peer?.getSenders().find(s => s.track?.kind === "audio");
    if (sender) await sender.replaceTrack(newTrack);

    toast(musicMode
      ? "🎼 Modo música activado: audio sin filtros. Usa audífonos para evitar eco."
      : "Modo voz activado: filtros de eco y ruido encendidos.");
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
  if (!peer) {
    dom.statsPanel.innerHTML = "Sin conexión de video activa.";
    return;
  }

  try {
    const stats = await peer.getStats();
    let rtt = null, jitter = null, packetsLost = 0, packetsReceived = 0;
    let bytesSent = 0, bytesReceived = 0, audioLevel = null;

    stats.forEach(report => {
      if (report.type === "candidate-pair" && report.nominated && report.currentRoundTripTime != null) {
        rtt = report.currentRoundTripTime * 1000;
      }
      if (report.type === "inbound-rtp") {
        packetsLost += report.packetsLost || 0;
        packetsReceived += report.packetsReceived || 0;
        if (report.kind === "audio" && report.jitter != null) jitter = report.jitter * 1000;
        bytesReceived += report.bytesReceived || 0;
      }
      if (report.type === "outbound-rtp") bytesSent += report.bytesSent || 0;
      if (report.type === "media-source" && report.kind === "audio" && report.audioLevel != null) {
        audioLevel = report.audioLevel;
      }
    });

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
