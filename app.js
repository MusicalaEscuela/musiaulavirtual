import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase, ref, set, update, push, remove, get,
  onValue, onChildAdded, onDisconnect, query, limitToLast
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
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
let firebaseReady = false;
let roomPath = null;
let presenceRef = null;
let participantsCount = 0;
let unsubscribers = [];

let peer = null;
let localStream = null;
let remoteConnected = false;
let micOn = true;
let camOn = true;

let metronomeTimer = null;
let audioContext = null;
let stageTimer = null;
let answeredQuizIds = new Set();

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

  if (roomParam && nameParam) {
    enterClass({
      room: roomParam,
      displayName: nameParam,
      role: roleParam || "docente"
    });
  }
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
    "btnStageCelebrate", "btnStageClear",
    "videoArea", "remoteVideo", "remotePlaceholder", "localVideo",
    "toggleMic", "toggleCam", "reconnectVideo"
  ].forEach(id => dom[id] = document.getElementById(id));

  dom.tabs = Array.from(document.querySelectorAll(".tab"));
  dom.quickResponses = Array.from(document.querySelectorAll("[data-response]"));
}

function setupEvents() {
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

  dom.copyLobbyLink.addEventListener("click", () => copyLink(false));
  dom.copyClassLink.addEventListener("click", () => copyLink(true));

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
    if (metronomeTimer) {
      stopMetronome();
    } else {
      startMetronome();
    }
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
    resources: appState.resources
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
  stopMetronome();
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

function startMetronome() {
  const bpm = Math.max(40, Math.min(240, Number(dom.bpm.value) || 80));
  const interval = 60000 / bpm;
  dom.toggleMetronome.textContent = "Detener";

  tick();
  metronomeTimer = setInterval(tick, interval);
}

function stopMetronome() {
  if (metronomeTimer) clearInterval(metronomeTimer);
  metronomeTimer = null;
  dom.toggleMetronome.textContent = "Iniciar";
  dom.beatIndicator.classList.remove("on");
}

function tick() {
  dom.beatIndicator.classList.add("on");
  setTimeout(() => dom.beatIndicator.classList.remove("on"), 90);

  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.045;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.045);
  } catch (error) {
    // Si el navegador bloquea audio, el indicador visual igual sirve.
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

function copyLink(includeClassState) {
  const link = buildClassUrl(includeClassState);
  navigator.clipboard?.writeText(link).then(() => {
    toast("Enlace copiado. Pégalo en el segundo dispositivo.");
  }).catch(() => {
    window.prompt("Copia este enlace:", link);
  });
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
