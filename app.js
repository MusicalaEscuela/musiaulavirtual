(() => {
  const NOTES = ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"];
  const STORAGE_KEY = "musiaula_prototipo_v1";
  const MSG_PREFIX = "MUSIAULA_V1::";

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
  let api = null;
  let localParticipantId = null;
  let dataChannelReady = false;
  let knownParticipants = new Map();
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
      "copyLobbyLink", "roomTitle", "connectionStatus", "copyClassLink", "openExternal",
      "leaveClass", "jitsiContainer", "objectiveInput", "publishObjective", "objectiveView",
      "activeResourceTitle", "activeResourceDesc", "activeExerciseTitle", "activeExerciseBody",
      "responsesList", "resourceList", "addResource", "resourceTitle", "resourceDesc",
      "createResource", "rootNote", "exerciseMode", "scalePreview", "previewScale",
      "launchScale", "bpm", "toggleMetronome", "beatIndicator", "workedOn", "progress",
      "homework", "saveLog", "exportLog", "clearLocal", "classLogList", "sendState",
      "stageArea", "stageNote", "btnStageNote", "btnStageSeq", "btnStageQuiz",
      "btnStageCelebrate", "btnStageClear"
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

    dom.leaveClass.addEventListener("click", () => {
      if (api) {
        api.executeCommand("hangup");
        api.dispose();
        api = null;
      }
      stopMetronome();
      location.href = location.pathname;
    });

    dom.tabs.forEach(tab => {
      tab.addEventListener("click", () => activateTab(tab.dataset.tab));
    });

    dom.publishObjective.addEventListener("click", () => {
      appState.objective = dom.objectiveInput.value.trim();
      saveLocal();
      renderAula();
      broadcast({ type: "STATE_PATCH", patch: { objective: appState.objective } });
      toast("Objetivo publicado.");
    });

    dom.sendState.addEventListener("click", () => {
      broadcastFullState();
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
      broadcast({ type: "STATE_PATCH", patch: { resources: appState.resources } });
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
      broadcast({ type: "STATE_PATCH", patch: { resources: appState.resources } });
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
      broadcast({ type: "STATE_PATCH", patch: { activeExercise: exercise } });
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
        const response = {
          id: cryptoId(),
          name: appState.displayName || "Participante",
          role: appState.role,
          text: button.dataset.response,
          at: new Date().toISOString()
        };
        appState.responses.unshift(response);
        saveLocal();
        renderResponses();
        broadcast({ type: "RESPONSE", response });
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
      broadcast({ type: "LOG_ADDED", log });
      toast("Entrada guardada localmente.");
    });

    dom.exportLog.addEventListener("click", exportJson);
    dom.clearLocal.addEventListener("click", clearLocalData);

    dom.btnStageNote.addEventListener("click", () => {
      launchStage({
        kind: "bigNote",
        note: dom.stageNote.value
      });
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

    dom.btnStageClear.addEventListener("click", () => {
      appState.stage = null;
      saveLocal();
      renderStage();
      broadcast({ type: "STATE_PATCH", patch: { stage: null } });
      toast("Escenario limpio.");
    });
  }

  function launchStage(stage) {
    appState.stage = { id: cryptoId(), at: new Date().toISOString(), ...stage };
    saveLocal();
    renderStage();
    broadcast({ type: "STATE_PATCH", patch: { stage: appState.stage } });
  }

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
    dom.openExternal.href = "https://meet.jit.si/" + encodeURIComponent(appState.room);
    dom.lobby.classList.add("hidden");
    dom.app.classList.remove("hidden");

    renderAll();
    initJitsi();
  }

  function initJitsi() {
    if (!window.JitsiMeetExternalAPI) {
      dom.connectionStatus.textContent = "No cargó Jitsi";
      dom.connectionStatus.className = "status offline";
      toast("No se pudo cargar Jitsi. Revisa internet o abre el enlace externo.");
      return;
    }

    dom.connectionStatus.textContent = "Conectando";
    dom.connectionStatus.className = "status offline";

    const domain = "meet.jit.si";
    const options = {
      roomName: appState.room,
      width: "100%",
      height: "100%",
      parentNode: dom.jitsiContainer,
      userInfo: {
        displayName: `${appState.displayName} · ${labelRole(appState.role)}`
      },
      configOverwrite: {
        prejoinPageEnabled: false,
        disableDeepLinking: true,
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        disableInviteFunctions: true,
        enableWelcomePage: false
      },
      interfaceConfigOverwrite: {
        MOBILE_APP_PROMO: false,
        SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false
      }
    };

    dom.jitsiContainer.innerHTML = "";
    api = new JitsiMeetExternalAPI(domain, options);

    api.addListener("videoConferenceJoined", event => {
      localParticipantId = event.id;
      dom.connectionStatus.textContent = "En sala";
      dom.connectionStatus.className = "status online";
      refreshParticipants().then(() => {
        broadcast({ type: "STATE_REQUEST" });
        setTimeout(broadcastFullState, 850);
      });
    });

    api.addListener("participantJoined", event => {
      if (event && event.id) {
        knownParticipants.set(event.id, event);
      }
      setTimeout(() => {
        refreshParticipants().then(broadcastFullState);
      }, 900);
    });

    api.addListener("participantLeft", event => {
      if (event && event.id) knownParticipants.delete(event.id);
      renderParticipantStatus();
    });

    api.addListener("dataChannelOpened", () => {
      dataChannelReady = true;
      dom.connectionStatus.textContent = "Sincronización lista";
      dom.connectionStatus.className = "status online";
      setTimeout(() => {
        broadcast({ type: "STATE_REQUEST" });
        broadcastFullState();
      }, 500);
    });

    api.addListener("endpointTextMessageReceived", event => {
      const text = event?.eventData?.text || "";
      if (!text.startsWith(MSG_PREFIX)) return;

      try {
        const message = JSON.parse(text.slice(MSG_PREFIX.length));
        handleRemoteMessage(message, event?.senderInfo);
      } catch (error) {
        console.warn("Mensaje MusiAula inválido", error);
      }
    });

    api.addListener("errorOccurred", event => {
      console.warn("Jitsi error", event);
      if (event?.isFatal) {
        dom.connectionStatus.textContent = "Error de llamada";
        dom.connectionStatus.className = "status offline";
      }
    });

    renderParticipantStatus();
  }

  async function refreshParticipants() {
    if (!api) return [];
    try {
      let participants = [];

      if (typeof api.getRoomsInfo === "function") {
        const rooms = await api.getRoomsInfo();
        participants = flattenRoomsParticipants(rooms);
      } else if (typeof api.getParticipantsInfo === "function") {
        participants = api.getParticipantsInfo() || [];
      }

      participants.forEach(p => {
        if (p.id && p.id !== localParticipantId) knownParticipants.set(p.id, p);
      });

      renderParticipantStatus();
      return participants;
    } catch (error) {
      console.warn("No se pudo refrescar participantes", error);
      return [];
    }
  }

  function flattenRoomsParticipants(rooms) {
    if (!Array.isArray(rooms)) return [];
    const result = [];

    rooms.forEach(room => {
      const participants = room.participants;
      if (Array.isArray(participants)) {
        participants.forEach(p => result.push(p));
      } else if (participants && typeof participants === "object") {
        Object.values(participants).forEach(p => result.push(p));
      }
    });

    return result;
  }

  function renderParticipantStatus() {
    if (!api) return;

    const count = knownParticipants.size + (localParticipantId ? 1 : 0);
    if (dataChannelReady) {
      dom.connectionStatus.textContent = count > 1 ? `Sincronizado · ${count} personas` : "Solo en sala";
      dom.connectionStatus.className = "status online";
    }
  }

  function broadcastFullState() {
    broadcast({
      type: "FULL_STATE",
      state: publicState()
    });
  }

  function publicState() {
    return {
      room: appState.room,
      objective: appState.objective,
      activeResource: appState.activeResource,
      activeExercise: appState.activeExercise,
      stage: appState.stage,
      resources: appState.resources,
      responses: appState.responses.slice(0, 20)
    };
  }

  async function broadcast(message) {
    if (!api || !dataChannelReady) {
      console.info("Sin dataChannel aún; guardado local solamente.", message);
      return;
    }

    await refreshParticipants();

    const payload = MSG_PREFIX + JSON.stringify({
      ...message,
      sender: {
        id: localParticipantId,
        name: appState.displayName,
        role: appState.role
      },
      sentAt: new Date().toISOString()
    });

    const participantIds = [...knownParticipants.keys()].filter(id => id && id !== localParticipantId);

    participantIds.forEach(id => {
      try {
        api.executeCommand("sendEndpointTextMessage", id, payload);
      } catch (error) {
        console.warn("No se pudo enviar mensaje endpoint a", id, error);
      }
    });
  }

  function handleRemoteMessage(message) {
    if (!message || !message.type) return;

    if (message.type === "STATE_REQUEST") {
      setTimeout(broadcastFullState, 450);
      return;
    }

    if (message.type === "FULL_STATE" && message.state) {
      mergeState(message.state);
      toast(`Aula sincronizada desde ${message.sender?.name || "otro dispositivo"}.`);
      return;
    }

    if (message.type === "STATE_PATCH" && message.patch) {
      mergeState(message.patch);
      toast(`Actualización recibida de ${message.sender?.name || "otro dispositivo"}.`);
      return;
    }

    if (message.type === "RESPONSE" && message.response) {
      addUnique("responses", message.response);
      saveLocal();
      renderResponses();
      toast(`${message.response.name}: ${message.response.text}`);
      return;
    }

    if (message.type === "LOG_ADDED" && message.log) {
      addUnique("logs", message.log);
      saveLocal();
      renderLogs();
      toast(`Bitácora recibida de ${message.sender?.name || "otro dispositivo"}.`);
    }
  }

  function mergeState(incoming) {
    const allowed = ["objective", "activeResource", "activeExercise", "stage", "resources", "responses"];
    allowed.forEach(key => {
      if (incoming[key] !== undefined) appState[key] = incoming[key];
    });
    saveLocal();
    renderAll();
  }

  function addUnique(collection, item) {
    const exists = appState[collection].some(entry => entry.id === item.id);
    if (!exists) appState[collection].unshift(item);
  }

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
        <div class="scale-preview">${appState.activeExercise.sequence.map(note => `<span class="note-pill">${escapeHtml(note)}</span>`).join("")}</div>
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
          ${stage.sequence.map(note => `<span class="note-pill big">${escapeHtml(note)}</span>`).join("")}
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
          ${stage.options.map(note => `
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

          const response = {
            id: cryptoId(),
            name: appState.displayName || "Participante",
            role: appState.role,
            text: `${correct ? "✅" : "❌"} Respondió "${answer}" — ${stage.question}`,
            at: new Date().toISOString()
          };
          appState.responses.unshift(response);
          saveLocal();
          renderResponses();
          broadcast({ type: "RESPONSE", response });
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
    if (close) {
      close.addEventListener("click", () => {
        appState.stage = null;
        saveLocal();
        renderStage();
        broadcast({ type: "STATE_PATCH", patch: { stage: null } });
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
        broadcast({ type: "STATE_PATCH", patch: { activeResource: resource } });
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
        broadcast({ type: "STATE_PATCH", patch: { resources: appState.resources, activeResource: appState.activeResource } });
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
      .replace(/[\u0300-\u036f]/g, "")
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
})();
