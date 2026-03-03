let socket;
let currentUser = localStorage.getItem("user");
let currentChat = "global";

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let currentCallPeer = null;

let pendingIncomingOffer = null;
let pendingIncomingFrom = null;

let isMuted = false;
let cameraOn = false;

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

if (!currentUser) window.location.href = "index.html";

function headers() { return { "x-user": currentUser }; }

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function initChat() {
  connectWS();

  loadChatList();
  loadMessages("global");
  updateCallButtonState();

  // NEW: stories + birthdays
  loadStories();
  showBirthdayBanner();

  const input = document.getElementById("messageInput");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });

  if (window.innerWidth > 768) document.getElementById("sidebar")?.classList.remove("active-mobile");
}

function connectWS() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}?user=${encodeURIComponent(currentUser)}`);

  socket.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "system") {
      alert(msg.text || "Системное сообщение");
      return;
    }

    if (msg.type === "messageDeleted") {
      const el = document.querySelector(`[data-message-id="${msg.id}"]`);
      if (el) el.remove();
      return;
    }

    // CALL SIGNALING
    if (msg.type === "call-offer") { onIncomingOffer(msg); return; }
    if (msg.type === "call-answer") {
      if (peerConnection && msg.answer) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
        setCallStatus("Разговор начался");
      }
      return;
    }
    if (msg.type === "call-renegotiate-offer") { await onRenegotiateOffer(msg); return; }
    if (msg.type === "call-renegotiate-answer") { await onRenegotiateAnswer(msg); return; }
    if (msg.type === "ice-candidate") {
      if (peerConnection && msg.candidate) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      }
      return;
    }
    if (msg.type === "call-reject") { alert(`@${msg.from} отклонил звонок`); cleanupCall(); return; }
    if (msg.type === "call-end") { alert(`Звонок с @${msg.from} завершён`); cleanupCall(); return; }

    if (msg.type !== "message") return;

    // render if visible chat
    if (msg.receiver === "global" && currentChat === "global") renderMessage(msg);

    if (msg.receiver !== "global") {
      const visible =
        (msg.sender === currentChat && msg.receiver === currentUser) ||
        (msg.sender === currentUser && msg.receiver === currentChat);

      if (visible) renderMessage(msg);
    }

    loadChatList();
  };
}

/* -------------------- CHAT -------------------- */

async function loadMessages(chatName) {
  const container = document.getElementById("messagesContainer");
  if (!container) return;
  container.innerHTML = "";

  const res = await fetch(`/api/messages?chat=${encodeURIComponent(chatName)}`, { headers: headers() });
  const messages = await res.json();

  messages.forEach(renderMessage);
  scrollBottom();
}

function renderMessage(msg) {
  const container = document.getElementById("messagesContainer");
  if (!container) return;

  const mine = msg.sender === currentUser;

  let content = "";
  if (msg.mediaType === "image") {
    content = `<img class="msg-image" src="${msg.mediaUrl}" alt="">`;
  } else if (msg.mediaType === "video") {
    content = `<video class="msg-video" controls playsinline src="${msg.mediaUrl}"></video>`;
  } else if (msg.mediaType === "audio") {
    content = `<audio controls class="voice-audio" src="${msg.mediaUrl}"></audio>`;
  } else {
    content = `<div class="msg-text">${escapeHtml(msg.text || "")}</div>`;
  }

  const deleteBtn =
    mine && msg.id
      ? `<button class="delete-msg-btn" onclick="deleteMessage(${msg.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>`
      : "";

  const bubble = document.createElement("div");
  bubble.className = `message-row ${mine ? "mine" : "other"}`;
  if (msg.id) bubble.dataset.messageId = String(msg.id);

  bubble.innerHTML = `
    <div class="bubble">
      <div class="bubble-top">
        <span class="sender-name">${escapeHtml(msg.displayName || msg.sender)}</span>
        <div class="bubble-actions">${deleteBtn}</div>
      </div>
      ${content}
    </div>
  `;

  container.appendChild(bubble);
  scrollBottom();
}

function scrollBottom() {
  const c = document.getElementById("messagesContainer");
  if (!c) return;
  c.scrollTop = c.scrollHeight;
}

async function deleteMessage(id) {
  if (!confirm("Удалить это сообщение?")) return;
  const res = await fetch(`/api/messages/${id}`, { method: "DELETE", headers: headers() });
  const data = await res.json();
  if (!data.success) alert(data.error || "Ошибка удаления");
}

async function loadChatList() {
  const block = document.getElementById("privateChatsBlock");
  if (!block) return;

  const res = await fetch("/api/chats", { headers: headers() });
  const chats = await res.json();

  block.innerHTML = chats
    .map((chat) => `
      <div class="chat-item ${currentChat === chat.username ? "active" : ""}" data-chat="${chat.username}" onclick="switchChat('${chat.username}')">
        <div class="avatar-circle">
          ${chat.avatar ? `<img src="${chat.avatar}" alt="">` : `<span>${(chat.displayName || chat.username).charAt(0).toUpperCase()}</span>`}
        </div>
        <div class="chat-meta">
          <span class="name">${escapeHtml(chat.displayName || chat.username)}${chat.todayBirthday ? " 🎂" : ""}</span>
          <span class="preview">${escapeHtml(chat.preview || "Чат")}</span>
        </div>
      </div>
    `)
    .join("");
}

function switchChat(name) {
  currentChat = name;

  document.querySelectorAll(".chat-item").forEach((el) => el.classList.remove("active"));
  const active = document.querySelector(`.chat-item[data-chat="${name}"]`);
  if (active) active.classList.add("active");

  document.getElementById("chatTitle").textContent = name === "global" ? "Общий чат" : "@" + name;
  document.getElementById("chatStatus").textContent = name === "global" ? "общение со всеми" : "личный чат";

  loadMessages(name);
  updateCallButtonState();

  if (window.innerWidth <= 768) document.getElementById("sidebar")?.classList.remove("active-mobile");
}

function updateCallButtonState() {
  const btn = document.getElementById("callBtn");
  if (!btn) return;
  btn.style.display = currentChat === "global" ? "none" : "inline-flex";
}

function sendText() {
  const input = document.getElementById("messageInput");
  const text = input.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({ type: "text", text, sender: currentUser, receiver: currentChat }));
  input.value = "";
}

async function uploadMedia(input) {
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("receiver", currentChat);
  formData.append("text", "");

  const res = await fetch("/api/upload", { method: "POST", headers: headers(), body: formData });
  const data = await res.json();

  if (!data.success) alert(data.error || "Ошибка загрузки");
  input.value = "";
}

/* -------------------- VOICE -------------------- */

async function toggleAudioRec() {
  const voiceBtn = document.getElementById("voiceBtn");

  if (isRecording && mediaRecorder) {
    mediaRecorder.stop();
    isRecording = false;
    if (voiceBtn) voiceBtn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("receiver", currentChat);
      formData.append("text", "");

      const res = await fetch("/api/upload", { method: "POST", headers: headers(), body: formData });
      const data = await res.json();
      if (!data.success) alert(data.error || "Ошибка голосового");

      stream.getTracks().forEach((t) => t.stop());
    };

    mediaRecorder.start();
    isRecording = true;
    if (voiceBtn) voiceBtn.innerHTML = `<i class="fa-solid fa-stop"></i>`;
  } catch {
    alert("Не удалось включить микрофон");
  }
}

function toggleSidebarMobile() {
  const sidebar = document.getElementById("sidebar");
  if (window.innerWidth <= 768) sidebar?.classList.toggle("active-mobile");
}

/* -------------------- SEARCH USERS -------------------- */

async function searchUsers(val) {
  const raw = String(val || "").trim();
  if (!raw.startsWith("@")) {
    document.getElementById("searchResults").innerHTML = "";
    return;
  }
  const q = raw.replace("@", "");

  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: headers() });
  const users = await res.json();

  const results = document.getElementById("searchResults");
  results.innerHTML = users
    .map((u) => `
      <div class="chat-item" onclick="switchChat('${u.username}')">
        <div class="avatar-circle">${u.avatar ? `<img src="${u.avatar}" alt="">` : `<span>${(u.displayName||u.username).charAt(0).toUpperCase()}</span>`}</div>
        <div class="chat-meta">
          <span class="name">${escapeHtml(u.displayName || u.username)}</span>
          <span class="preview">@${escapeHtml(u.username)}</span>
        </div>
      </div>
    `)
    .join("");
}

/* -------------------- BIRTHDAY BANNER -------------------- */

async function showBirthdayBanner() {
  const banner = document.getElementById("birthdayBanner");
  if (!banner) return;

  try {
    const resMe = await fetch("/api/me", { headers: headers() });
    const me = await resMe.json();

    const res = await fetch("/api/birthdays/today", { headers: headers() });
    const list = await res.json();

    const names = Array.isArray(list) ? list.map((p) => p.displayName || p.username) : [];
    const isMine = me?.profile?.todayBirthday === true;

    if (!isMine && names.length === 0) {
      banner.classList.add("hidden");
      banner.innerHTML = "";
      return;
    }

    banner.classList.remove("hidden");

    const lines = [];
    if (isMine) lines.push(`🎉 С днём рождения, ${escapeHtml(me.profile.displayName || me.profile.username)}!`);
    if (names.length > 0) lines.push(`🎂 Сегодня день рождения у: ${escapeHtml(names.join(", "))}`);

    banner.innerHTML = `<div class="birthday-inner">${lines.join("<br>")}</div>`;
  } catch {
    banner.classList.add("hidden");
  }
}

/* -------------------- STORIES -------------------- */

async function loadStories() {
  const listEl = document.getElementById("storiesList");
  if (!listEl) return;

  try {
    const res = await fetch("/api/stories", { headers: headers() });
    const stories = await res.json();

    // группируем по owner, показываем последнюю сторис каждого
    const byOwner = new Map();
    for (const s of stories) {
      if (!byOwner.has(s.owner)) byOwner.set(s.owner, s);
    }

    const uniq = Array.from(byOwner.values()).slice(0, 20);

    listEl.innerHTML = uniq
      .map((s) => `
        <button class="story-chip" onclick="openStoryView(${s.id})" title="${escapeHtml(s.displayName || s.owner)}">
          <div class="story-avatar">
            ${s.avatar ? `<img src="${s.avatar}" alt="">` : `<span>${escapeHtml((s.displayName||s.owner).charAt(0).toUpperCase())}</span>`}
          </div>
          <div class="story-name">${escapeHtml((s.displayName || s.owner).split(" ")[0])}</div>
        </button>
      `)
      .join("");
  } catch {
    listEl.innerHTML = "";
  }
}

function openStoryComposer() {
  document.getElementById("storyComposerModal").style.display = "flex";
  document.getElementById("storyFile").value = "";
  document.getElementById("storyText").value = "";
}

function closeStoryComposer() {
  document.getElementById("storyComposerModal").style.display = "none";
}

async function publishStory() {
  const fileInput = document.getElementById("storyFile");
  const textInput = document.getElementById("storyText");

  const file = fileInput.files[0] || null;
  const text = String(textInput.value || "").trim();

  if (!file && !text) {
    alert("Добавь файл или текст для сторис");
    return;
  }

  const fd = new FormData();
  if (file) fd.append("story", file);
  fd.append("text", text);

  const res = await fetch("/api/stories", { method: "POST", headers: headers(), body: fd });
  const data = await res.json();

  if (!data.success) {
    alert(data.error || "Не удалось опубликовать сторис");
    return;
  }

  closeStoryComposer();
  loadStories();
}

async function openStoryView(storyId) {
  const modal = document.getElementById("storyViewModal");
  const title = document.getElementById("storyViewTitle");
  const content = document.getElementById("storyViewContent");
  const textEl = document.getElementById("storyViewText");

  modal.style.display = "flex";
  content.innerHTML = "";
  textEl.textContent = "";

  try {
    const res = await fetch("/api/stories", { headers: headers() });
    const stories = await res.json();
    const s = stories.find((x) => Number(x.id) === Number(storyId));
    if (!s) {
      title.textContent = "Сторис";
      content.innerHTML = "<div style='padding:10px'>Сторис не найдена</div>";
      return;
    }

    title.textContent = s.displayName ? s.displayName : "@" + s.owner;

    if (s.mediaType === "image") {
      content.innerHTML = `<img src="${s.mediaUrl}" style="width:100%;border-radius:14px;display:block;" alt="">`;
    } else if (s.mediaType === "video") {
      content.innerHTML = `<video src="${s.mediaUrl}" controls playsinline style="width:100%;border-radius:14px;display:block;"></video>`;
    } else {
      content.innerHTML = "";
    }

    textEl.textContent = s.text || "";
  } catch {
    title.textContent = "Сторис";
    content.innerHTML = "<div style='padding:10px'>Ошибка загрузки</div>";
  }
}

function closeStoryView() {
  document.getElementById("storyViewModal").style.display = "none";
}

/* -------------------- PROFILE (stub) -------------------- */
/* Если у тебя уже есть настройки/профиль модалка – оставляй.
   Тут просто заглушки, чтобы не падало. */
function openSettings() { alert("Настройки профиля: подключи твою модалку (если уже есть)"); }
function openCurrentProfile() {
  if (currentChat === "global") {
    alert("Это общий чат");
  } else {
    alert("Профиль пользователя: @" + currentChat + " (можно подключить отдельную страницу/модалку)");
  }
}

/* -------------------- CALLS (оставил твою логику) -------------------- */

function setCallStatus(text) {
  const el = document.getElementById("activeCallStatus");
  if (el) el.textContent = text;
}

function showIncoming(from) {
  document.getElementById("incomingCallText").textContent = `@${from} звонит тебе`;
  document.getElementById("incomingCallModal").style.display = "flex";
}
function hideIncoming() { document.getElementById("incomingCallModal").style.display = "none"; }

function showActive(peer, status = "Соединение...") {
  document.getElementById("activeCallTitle").textContent = `Звонок с @${peer}`;
  setCallStatus(status);
  document.getElementById("activeCallModal").style.display = "flex";
  updateVideoUI();
}
function hideActive() { document.getElementById("activeCallModal").style.display = "none"; }

function updateVideoUI() {
  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  if (!localVideo || !remoteVideo) return;

  localVideo.style.display = cameraOn ? "block" : "none";
  remoteVideo.style.display = "block";

  const camBtn = document.getElementById("camBtn");
  if (camBtn) camBtn.textContent = cameraOn ? "Выключить камеру" : "Включить камеру";
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return localStream;
}

function buildRemoteStream() {
  if (remoteStream) return remoteStream;
  remoteStream = new MediaStream();
  document.getElementById("remoteAudio").srcObject = remoteStream;
  document.getElementById("remoteVideo").srcObject = remoteStream;
  return remoteStream;
}

async function createPeer(peer) {
  currentCallPeer = peer;
  peerConnection = new RTCPeerConnection(rtcConfig);

  await ensureLocalStream();
  buildRemoteStream();

  localStream.getTracks().forEach((t) => peerConnection.addTrack(t, localStream));

  peerConnection.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    socket?.send(JSON.stringify({ type: "ice-candidate", from: currentUser, to: peer, candidate: ev.candidate }));
  };

  peerConnection.ontrack = (ev) => {
    const stream = buildRemoteStream();
    ev.streams[0].getTracks().forEach((t) => {
      if (!stream.getTracks().some((x) => x.id === t.id)) stream.addTrack(t);
    });
    setCallStatus("Разговор начался");
  };

  peerConnection.onconnectionstatechange = () => {
    const st = peerConnection?.connectionState;
    if (st === "connected") setCallStatus("Разговор начался");
    if (st === "connecting") setCallStatus("Подключение...");
    if (["disconnected", "failed", "closed"].includes(st)) cleanupCall();
  };
}

async function startCall() {
  if (currentChat === "global") return alert("Звонок доступен только в личном чате");
  if (currentCallPeer) return alert("У тебя уже есть активный звонок");

  try {
    showActive(currentChat, "Звоним...");
    await createPeer(currentChat);

    const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await peerConnection.setLocalDescription(offer);

    socket.send(JSON.stringify({ type: "call-offer", from: currentUser, to: currentChat, offer }));
  } catch {
    alert("Не удалось начать звонок");
    cleanupCall();
  }
}

function onIncomingOffer(msg) {
  if (currentCallPeer) {
    socket.send(JSON.stringify({ type: "call-reject", from: currentUser, to: msg.from }));
    return;
  }
  pendingIncomingFrom = msg.from;
  pendingIncomingOffer = msg.offer;
  showIncoming(msg.from);
}

async function acceptIncomingCall() {
  if (!pendingIncomingFrom || !pendingIncomingOffer) return;

  try {
    hideIncoming();
    showActive(pendingIncomingFrom, "Подключение...");

    await createPeer(pendingIncomingFrom);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingIncomingOffer));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.send(JSON.stringify({ type: "call-answer", from: currentUser, to: pendingIncomingFrom, answer }));

    pendingIncomingFrom = null;
    pendingIncomingOffer = null;
  } catch {
    alert("Не удалось принять звонок");
    cleanupCall();
  }
}

function rejectIncomingCall() {
  if (pendingIncomingFrom) socket.send(JSON.stringify({ type: "call-reject", from: currentUser, to: pendingIncomingFrom }));
  pendingIncomingFrom = null;
  pendingIncomingOffer = null;
  hideIncoming();
}

function toggleMuteCall() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  const btn = document.getElementById("muteBtn");
  if (btn) btn.textContent = isMuted ? "Включить микрофон" : "Выключить микрофон";
}

async function toggleCamera() {
  if (!peerConnection) return;

  if (!cameraOn) {
    try {
      const vStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const videoTrack = vStream.getVideoTracks()[0];

      if (!localStream) await ensureLocalStream();
      localStream.addTrack(videoTrack);

      const localVideo = document.getElementById("localVideo");
      if (localVideo) localVideo.srcObject = localStream;

      peerConnection.addTrack(videoTrack, localStream);

      cameraOn = true;
      updateVideoUI();
      await renegotiate();
    } catch {
      alert("Не удалось включить камеру");
    }
    return;
  }

  try {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find((s) => s.track && s.track.kind === "video");
    if (videoSender) {
      try { peerConnection.removeTrack(videoSender); }
      catch { videoSender.track.enabled = false; }
    }

    if (localStream) {
      localStream.getVideoTracks().forEach((t) => {
        t.stop();
        localStream.removeTrack(t);
      });
    }

    cameraOn = false;
    updateVideoUI();
    await renegotiate();
  } catch {
    cameraOn = false;
    updateVideoUI();
  }
}

async function renegotiate() {
  if (!peerConnection || !currentCallPeer) return;
  setCallStatus(cameraOn ? "Видео включено" : "Аудио режим");

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.send(JSON.stringify({ type: "call-renegotiate-offer", from: currentUser, to: currentCallPeer, offer }));
}

async function onRenegotiateOffer(msg) {
  if (!peerConnection || msg.from !== currentCallPeer) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.send(JSON.stringify({ type: "call-renegotiate-answer", from: currentUser, to: msg.from, answer }));
  } catch {}
}

async function onRenegotiateAnswer(msg) {
  if (!peerConnection || msg.from !== currentCallPeer) return;
  try { await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer)); } catch {}
}

function endCurrentCall() {
  if (currentCallPeer && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "call-end", from: currentUser, to: currentCallPeer }));
  }
  cleanupCall();
}

function cleanupCall() {
  hideIncoming();
  hideActive();

  try { peerConnection?.close(); } catch {}
  peerConnection = null;

  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;

  if (remoteStream) remoteStream.getTracks().forEach((t) => t.stop());
  remoteStream = null;

  const remoteAudio = document.getElementById("remoteAudio");
  if (remoteAudio) remoteAudio.srcObject = null;

  const localVideo = document.getElementById("localVideo");
  if (localVideo) localVideo.srcObject = null;

  const remoteVideo = document.getElementById("remoteVideo");
  if (remoteVideo) remoteVideo.srcObject = null;

  currentCallPeer = null;
  pendingIncomingFrom = null;
  pendingIncomingOffer = null;

  isMuted = false;
  cameraOn = false;
  updateVideoUI();

  const muteBtn = document.getElementById("muteBtn");
  if (muteBtn) muteBtn.textContent = "Выключить микрофон";
}
