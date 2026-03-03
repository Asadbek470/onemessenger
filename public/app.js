let socket;
let currentUser = localStorage.getItem("user");
let currentChat = "global";

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

let peerConnection = null;
let localStream = null;
let currentCallPeer = null;

let pendingIncomingOffer = null;
let pendingIncomingFrom = null;

let isMuted = false;
let cameraOn = false;

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

if (!currentUser) location.href = "index.html";

function headers() { return { "x-user": currentUser }; }

function escapeHtml(text = "") {
  return String(text).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

/* ================= INIT ================= */

function initChat() {
  connectWS();
  loadChatList();
  switchChat("global");
  loadStories();

  const input = document.getElementById("messageInput");
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") sendText();
  });
}

/* ================= WS ================= */

function connectWS() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}?user=${currentUser}`);

  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "call-offer") return onIncomingOffer(msg);
    if (msg.type === "call-answer") return onCallAnswer(msg);
    if (msg.type === "ice-candidate") return onIce(msg);
    if (msg.type === "call-end") return cleanupCall();
    if (msg.type === "call-decline") return cleanupCall();

    if (msg.type === "messageDeleted") {
      document.querySelector(`[data-message-id="${msg.id}"]`)?.remove();
      return;
    }

    if (msg.type !== "message") return;

    // message visibility
    const to = msg.receiver || "global";

    if (to === "global" && currentChat === "global") renderMessage(msg);

    if (to !== "global") {
      const visible =
        (msg.sender === currentChat && to === currentUser) ||
        (msg.sender === currentUser && to === currentChat);

      if (visible) renderMessage(msg);
    }

    loadChatList();
  };
}

/* ================= CHATS & MESSAGES ================= */

async function loadChatList() {
  const res = await fetch("/api/chats", { headers: headers() });
  const chats = await res.json();

  const block = document.getElementById("privateChatsBlock");
  block.innerHTML = "";

  chats.forEach(c => {
    const u = c.chatWith;
    if (!u) return;

    const item = document.createElement("div");
    item.className = "chat-item";
    item.dataset.chat = u;
    item.onclick = () => switchChat(u);

    item.innerHTML = `
      <div class="avatar">${escapeHtml((u[0] || "?").toUpperCase())}</div>
      <div class="meta">
        <div class="name">@${escapeHtml(u)}</div>
        <div class="preview">Открыть чат</div>
      </div>
    `;

    block.appendChild(item);
  });

  document.querySelectorAll(".chat-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chat === currentChat);
  });
}

function switchChat(chat) {
  currentChat = chat;

  document.getElementById("chatTitle").textContent =
    chat === "global" ? "Общий чат" : "@" + chat;

  document.getElementById("chatStatus").textContent =
    chat === "global" ? "общение со всеми" : "личная переписка";

  document.querySelectorAll(".chat-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chat === currentChat);
  });

  loadMessages(chat);

  if (window.innerWidth <= 768) {
    document.getElementById("sidebar")?.classList.remove("active-mobile");
  }
}

async function loadMessages(chatName) {
  const container = document.getElementById("messagesContainer");
  container.innerHTML = "";

  const res = await fetch(`/api/messages?chat=${encodeURIComponent(chatName)}`, { headers: headers() });
  const messages = await res.json();
  messages.forEach(renderMessage);
  scrollBottom();
}

function renderMessage(msg) {
  const container = document.getElementById("messagesContainer");
  const mine = msg.sender === currentUser;

  let content = "";
  if (msg.mediaType === "image") {
    content = `<img class="msg-image" src="${msg.mediaUrl}" />`;
  } else if (msg.mediaType === "video") {
    content = `<video controls playsinline src="${msg.mediaUrl}"></video>`;
  } else if (msg.mediaType === "audio") {
    content = `<audio controls src="${msg.mediaUrl}"></audio>`;
  } else {
    content = `<div class="msg-text">${escapeHtml(msg.text)}</div>`;
  }

  const row = document.createElement("div");
  row.className = `row-msg ${mine ? "mine" : ""}`;
  row.dataset.messageId = msg.id;

  row.innerHTML = `
    <div class="bubble">
      <div class="bubble-top">
        <div class="sender">${mine ? "Вы" : "@" + escapeHtml(msg.sender)}</div>
        ${mine ? `<button class="del" onclick="deleteMessage(${msg.id})" title="Удалить">🗑</button>` : ""}
      </div>
      ${content}
    </div>
  `;

  container.appendChild(row);
  scrollBottom();
}

function scrollBottom() {
  const c = document.getElementById("messagesContainer");
  c.scrollTop = c.scrollHeight;
}

function sendText() {
  const input = document.getElementById("messageInput");
  const text = input.value.trim();
  if (!text) return;

  socket.send(JSON.stringify({
    type: "text",
    text,
    sender: currentUser,
    receiver: currentChat
  }));

  input.value = "";
}

async function deleteMessage(id) {
  await fetch(`/api/messages/${id}`, { method: "DELETE", headers: headers() });
}

/* ================= SEARCH ================= */

async function searchUsers(q) {
  const out = document.getElementById("searchResults");
  const query = String(q || "").trim();

  if (!query) {
    out.innerHTML = "";
    return;
  }

  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: headers() });
  const rows = await res.json();

  out.innerHTML = "";
  rows.forEach(r => {
    const u = r.username;
    if (!u || u === currentUser) return;

    const item = document.createElement("div");
    item.className = "chat-item";
    item.onclick = () => switchChat(u);

    item.innerHTML = `
      <div class="avatar">${escapeHtml((u[0] || "?").toUpperCase())}</div>
      <div class="meta">
        <div class="name">@${escapeHtml(u)} ${r.phone ? " · " + escapeHtml(r.phone) : ""}</div>
        <div class="preview">${escapeHtml(r.displayName || "")}</div>
      </div>
    `;

    out.appendChild(item);
  });
}

/* ================= MEDIA UPLOAD ================= */

async function uploadMedia(input) {
  const file = input.files?.[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("receiver", currentChat);

  await fetch("/api/upload", { method: "POST", headers: headers(), body: fd });

  input.value = "";
}

/* ================= VOICE ================= */

async function toggleAudioRec() {
  if (isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const file = new File([blob], "voice.webm", { type: "audio/webm" });

    const fd = new FormData();
    fd.append("file", file);
    fd.append("receiver", currentChat);

    await fetch("/api/upload", { method: "POST", headers: headers(), body: fd });
    stream.getTracks().forEach(t => t.stop());
  };

  mediaRecorder.start();
  isRecording = true;
}

/* ================= PROFILE ================= */

async function openSettings() {
  const me = await fetch("/api/me", { headers: headers() }).then(r => r.json());
  const p = me.profile || {};

  const displayName = prompt("Имя (display name):", p.displayName || currentUser);
  if (displayName === null) return;

  const bio = prompt("Bio (о себе):", p.bio || "");
  if (bio === null) return;

  const phone = prompt("Телефон (для поиска, не обязательно):", p.phone || "");
  if (phone === null) return;

  await fetch("/api/me", {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, bio, phone })
  });

  alert("Профиль обновлён ✅");
  loadChatList();
}

async function openCurrentProfile() {
  const me = await fetch("/api/me", { headers: headers() }).then(r => r.json());
  const p = me.profile || {};
  alert(`@${p.username}\nИмя: ${p.displayName || ""}\nBio: ${p.bio || ""}\nТел: ${p.phone || ""}`);
}

function logout() {
  localStorage.removeItem("user");
  location.href = "index.html";
}

/* ================= STORIES ================= */

async function loadStories() {
  const list = document.getElementById("storiesList");
  if (!list) return;

  const res = await fetch("/api/stories", { headers: headers() });
  const stories = await res.json();

  list.innerHTML = "";
  stories.slice(0, 20).forEach(s => {
    const chip = document.createElement("button");
    chip.className = "story-chip";
    chip.onclick = () => openStoryView(s);

    chip.innerHTML = `
      <div class="story-avatar">
        ${s.mediaUrl ? `<img src="${s.mediaUrl}">` : escapeHtml((s.owner || "?")[0])}
      </div>
      <div class="story-name">@${escapeHtml(s.owner || "")}</div>
    `;

    list.appendChild(chip);
  });
}

function openStoryComposer() {
  document.getElementById("storyComposerModal").style.display = "flex";
}
function closeStoryComposer() {
  document.getElementById("storyComposerModal").style.display = "none";
}

async function publishStory() {
  const file = document.getElementById("storyFile").files?.[0] || null;
  const text = document.getElementById("storyText").value || "";

  const fd = new FormData();
  if (file) fd.append("story", file);
  fd.append("text", text);

  await fetch("/api/stories", { method: "POST", headers: headers(), body: fd });

  document.getElementById("storyText").value = "";
  document.getElementById("storyFile").value = "";
  closeStoryComposer();
  loadStories();
}

function openStoryView(s) {
  document.getElementById("storyViewModal").style.display = "flex";
  document.getElementById("storyViewTitle").textContent = "@" + (s.owner || "");
  document.getElementById("storyViewText").textContent = s.text || "";

  const c = document.getElementById("storyViewContent");
  if (s.mediaType === "video") {
    c.innerHTML = `<video controls playsinline src="${s.mediaUrl}" style="width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.08);"></video>`;
  } else if (s.mediaUrl) {
    c.innerHTML = `<img src="${s.mediaUrl}" style="width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.08);" />`;
  } else {
    c.innerHTML = `<div class="msg-text">Без медиа</div>`;
  }
}

function closeStoryView() {
  document.getElementById("storyViewModal").style.display = "none";
}

/* ================= SIDEBAR MOBILE ================= */

function toggleSidebarMobile() {
  document.getElementById("sidebar")?.classList.toggle("active-mobile");
}

/* ================= CALLS (WebRTC) ================= */

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  const localVideo = document.getElementById("localVideo");
  localVideo.muted = true;
  localVideo.playsInline = true;
  localVideo.autoplay = true;
  localVideo.srcObject = localStream;

  return localStream;
}

async function createPeer(peer) {
  currentCallPeer = peer;
  peerConnection = new RTCPeerConnection(rtcConfig);

  await ensureLocalStream();
  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

  peerConnection.onicecandidate = (e) => {
    if (!e.candidate) return;
    socket.send(JSON.stringify({ type: "ice-candidate", to: peer, from: currentUser, candidate: e.candidate }));
  };

  peerConnection.ontrack = async (e) => {
    if (e.track.kind === "audio") {
      const remoteAudio = document.getElementById("remoteAudio");
      remoteAudio.srcObject = e.streams[0];
      try { await remoteAudio.play(); } catch {}
      return;
    }
    const remoteVideo = document.getElementById("remoteVideo");
    remoteVideo.srcObject = e.streams[0];
    try { await remoteVideo.play(); } catch {}
  };
}

async function startCall() {
  if (currentChat === "global") {
    alert("Звонок доступен только в личном чате.");
    return;
  }

  await createPeer(currentChat);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.send(JSON.stringify({ type: "call-offer", to: currentChat, from: currentUser, offer }));
  document.getElementById("activeCallModal").style.display = "flex";
  document.getElementById("activeCallTitle").textContent = "Звонок с @" + currentChat;
}

function onIncomingOffer(msg) {
  pendingIncomingFrom = msg.from;
  pendingIncomingOffer = msg.offer;
  document.getElementById("incomingCallText").textContent = "@" + pendingIncomingFrom + " звонит тебе";
  document.getElementById("incomingCallModal").style.display = "flex";
}

async function acceptIncomingCall() {
  document.getElementById("incomingCallModal").style.display = "none";

  await createPeer(pendingIncomingFrom);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingIncomingOffer));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.send(JSON.stringify({ type: "call-answer", to: pendingIncomingFrom, from: currentUser, answer }));
  document.getElementById("activeCallModal").style.display = "flex";
  document.getElementById("activeCallTitle").textContent = "Звонок с @" + pendingIncomingFrom;
}

function rejectIncomingCall() {
  document.getElementById("incomingCallModal").style.display = "none";
  if (pendingIncomingFrom) {
    socket.send(JSON.stringify({ type: "call-decline", to: pendingIncomingFrom, from: currentUser }));
  }
  pendingIncomingFrom = null;
  pendingIncomingOffer = null;
}

function onCallAnswer(msg) {
  peerConnection?.setRemoteDescription(new RTCSessionDescription(msg.answer));
  document.getElementById("activeCallStatus").textContent = "Соединено ✅";
}

function onIce(msg) {
  try { peerConnection?.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
}

async function toggleCamera() {
  if (!peerConnection) return;

  if (!cameraOn) {
    const vStream = await navigator.mediaDevices.getUserMedia({ video: true });
    const videoTrack = vStream.getVideoTracks()[0];

    const sender = peerConnection.getSenders().find(s => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(videoTrack);
    else peerConnection.addTrack(videoTrack, localStream);

    localStream.addTrack(videoTrack);

    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = localStream;
    try { await localVideo.play(); } catch {}
    cameraOn = true;
    return;
  }

  const sender = peerConnection.getSenders().find(s => s.track?.kind === "video");
  if (sender) await sender.replaceTrack(null);

  localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
  cameraOn = false;
}

function toggleMuteCall() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
}

function endCurrentCall() {
  if (currentCallPeer) {
    socket.send(JSON.stringify({ type: "call-end", to: currentCallPeer, from: currentUser }));
  }
  cleanupCall();
}

function cleanupCall() {
  peerConnection?.close();
  peerConnection = null;

  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  document.getElementById("activeCallModal").style.display = "none";
  document.getElementById("activeCallStatus").textContent = "Соединение…";

  cameraOn = false;
  isMuted = false;
  currentCallPeer = null;

  pendingIncomingFrom = null;
  pendingIncomingOffer = null;
}

async function searchUsers(value) {
  const container = document.getElementById("searchResults");
  const query = String(value || "").trim();

  if (!query) {
    container.innerHTML = "";
    return;
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: headers()
    });

    const users = await res.json();

    container.innerHTML = "";

    if (!users.length) {
      container.innerHTML = `
        <div class="chat-item">Никого не найдено</div>
      `;
      return;
    }

    users.forEach(user => {
      const div = document.createElement("div");
      div.className = "chat-item";
      div.innerHTML = `
        <div class="avatar-circle">
          ${user.username[0].toUpperCase()}
        </div>
        <div class="chat-meta">
          <span class="name">@${user.username}</span>
          <span class="preview">${user.displayName || ""}</span>
        </div>
      `;

      div.onclick = () => {
        switchChat(user.username);
        container.innerHTML = "";
        document.getElementById("userSearch").value = "";
      };

      container.appendChild(div);
    });

  } catch (err) {
    console.error(err);
  }
}
