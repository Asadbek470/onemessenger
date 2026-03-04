let token = localStorage.getItem("token");
if (!token) location.href = "index.html";

let me = null;
let currentChat = "global";
let ws = null;
let wsReady = false;
let wsQueue = []; // если WS еще не открылся

// voice recorder
let mediaRecorder = null;
let chunks = [];
let recording = false;

// WebRTC audio call
let pc = null;
let localStream = null;
let remoteStream = null;
let callPeer = null;
let isMuted = false;

// incoming call state (замена confirm)
let pendingOffer = null;
let pendingFrom = null;

const rtcCfg = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

function esc(s="") {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function initApp() {
  await loadMe();
  connectWS();

  openChat("global", false);
  await refreshChats();
  await loadStories();
  await showBirthdays();

  document.getElementById("callBtn").style.display = "none";
  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");
}

async function loadMe() {
  const r = await fetch("/api/me", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return logout();
  me = d.profile;
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("me");
  location.href = "index.html";
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("mobile-hidden");
}

// ---------------- WS ----------------
function wsSend(obj) {
  const payload = JSON.stringify(obj);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    wsQueue.push(payload);
    return;
  }
  ws.send(payload);
}

function flushWsQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (wsQueue.length) ws.send(wsQueue.shift());
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    wsReady = true;
    flushWsQueue();
  };

  ws.onclose = () => {
    wsReady = false;
    // мягкая попытка переподключиться (без фанатизма)
    setTimeout(() => {
      if (!wsReady) connectWS();
    }, 1200);
  };

  ws.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "blocked") {
      alert("Аккаунт заблокирован");
      logout();
      return;
    }

    if (data.type === "message") {
      const msg = data.message;
      if (shouldRender(msg)) renderMessage(msg);
      await refreshChats();
      return;
    }

    if (data.type === "messageDeleted") {
      const el = document.querySelector(`[data-mid="${data.id}"]`);
      if (el) el.remove();
      return;
    }

    // Call signaling
    if (data.type === "call-offer") return onIncomingOffer(data);
    if (data.type === "call-answer") return onAnswer(data);
    if (data.type === "ice") return onIce(data);
    if (data.type === "call-end") return onCallEnd(data);
    if (data.type === "call-reject") return onCallReject(data);
    if (data.type === "call-error") return alert(data.message || "Ошибка звонка");
  };
}

function shouldRender(msg) {
  if (msg.chatType === "global") return currentChat === "global";

  const other = msg.sender === me.username ? msg.receiver : msg.sender;
  return currentChat === other;
}

// ---------------- CHAT ----------------
async function openChat(chat, load = true) {
  currentChat = chat;
  document.getElementById("chatTitle").textContent = chat === "global" ? "Общий чат" : "@" + chat;
  document.getElementById("chatSub").textContent = chat === "global" ? "общение со всеми" : "личный чат";

  // call button
  document.getElementById("callBtn").style.display = chat === "global" ? "none" : "inline-flex";

  // set active
  document.querySelectorAll(".chatitem").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.chatitem[data-chat="${chat}"]`);
  if (btn) btn.classList.add("active");

  // mobile close sidebar
  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");

  if (load) await loadMessages();
}

async function loadMessages() {
  const box = document.getElementById("messages");
  box.innerHTML = "";

  const r = await fetch(`/api/messages?chat=${encodeURIComponent(currentChat)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  d.messages.forEach(renderMessage);
  scrollBottom();
}

function scrollBottom() {
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  const box = document.getElementById("messages");
  const mine = m.sender === me.username;

  let body = "";
  if (m.mediaType === "image") {
    body = `<img class="mimg" src="${m.mediaUrl}" alt="">`;
  } else if (m.mediaType === "video") {
    body = `<video class="mvid" controls playsinline src="${m.mediaUrl}"></video>`;
  } else if (m.mediaType === "audio") {
    body = `<audio class="maud" controls src="${m.mediaUrl}"></audio>`;
  } else {
    body = `<div class="mtext">${esc(m.text || "")}</div>`;
  }

  const del = mine ? `<button class="trash" onclick="deleteMsg(${m.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>` : "";

  const row = document.createElement("div");
  row.className = "mrow " + (mine ? "mine" : "other");
  row.dataset.mid = String(m.id);

  row.innerHTML = `
    <div class="bubble">
      <div class="btop">
        <div class="who">${esc(m.sender)}</div>
        ${del}
      </div>
      ${body}
    </div>
  `;

  box.appendChild(row);
  scrollBottom();
}

async function deleteMsg(id) {
  if (!confirm("Удалить сообщение?")) return;
  const r = await fetch(`/api/messages/${id}`, { method: "DELETE", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) alert(d.error || "Ошибка удаления");
}

function onEnter(e) {
  if (e.key === "Enter") sendText();
}

function sendText() {
  const input = document.getElementById("textInput");
  const text = input.value.trim();
  if (!text) return;

  wsSend({
    type: "text-message",
    receiver: currentChat,
    text
  });

  input.value = "";
}

async function sendMedia(input) {
  const file = input.files[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("receiver", currentChat);
  fd.append("text", "");

  const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  if (!d.ok) alert(d.error || "Ошибка медиа");

  input.value = "";
}

async function refreshChats() {
  const r = await fetch("/api/chats", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const wrap = document.getElementById("privateChats");
  wrap.innerHTML = "";

  d.chats.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "chatitem";
    btn.dataset.chat = c.username;
    btn.onclick = () => openChat(c.username);
    btn.innerHTML = `
      <div class="avatar">${c.avatarUrl ? `<img src="${c.avatarUrl}" alt="">` : `<span>${esc((c.displayName||c.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(c.displayName || c.username)}</div>
        <div class="preview">${esc(c.preview || "")}</div>
      </div>
    `;
    wrap.appendChild(btn);
  });
}

// ---------------- SEARCH ----------------
async function searchUsers(val) {
  const qraw = String(val || "").trim();
  const results = document.getElementById("searchResults");

  if (!qraw.startsWith("@") || qraw.length < 2) {
    results.innerHTML = "";
    return;
  }

  const q = qraw.replace(/^@+/, "");
  const r = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  results.innerHTML = "";
  d.users.forEach(u => {
    const btn = document.createElement("button");
    btn.className = "chatitem";
    btn.onclick = () => openChat(u.username);
    btn.innerHTML = `
      <div class="avatar">${u.avatarUrl ? `<img src="${u.avatarUrl}" alt="">` : `<span>${esc((u.displayName||u.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(u.displayName || u.username)}</div>
        <div class="preview">@${esc(u.username)}</div>
      </div>
    `;
    results.appendChild(btn);
  });
}

// ---------------- PROFILE VIEW ----------------
async function openCurrentProfile() {
  if (currentChat === "global") {
    await openProfile(me.username, true);
  } else {
    await openProfile(currentChat, false);
  }
}

async function openProfile(username, isMe) {
  const modal = document.getElementById("profileModal");
  modal.classList.remove("hidden");

  const title = document.getElementById("profileTitle");
  const avatar = document.getElementById("profileAvatar");
  const name = document.getElementById("profileName");
  const user = document.getElementById("profileUser");
  const bio = document.getElementById("profileBio");
  const birth = document.getElementById("profileBirth");
  const actions = document.getElementById("profileActions");

  title.textContent = isMe ? "Мой профиль" : "Профиль";
  actions.innerHTML = "";

  let p = null;
  if (isMe) {
    p = me;
  } else {
    const r = await fetch(`/api/users/${encodeURIComponent(username)}`, { headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { alert("Не найден"); return closeProfile(); }
    p = d.user;
  }

  avatar.innerHTML = p.avatarUrl ? `<img src="${p.avatarUrl}" alt="">` : `<span>${esc((p.displayName||p.username)[0].toUpperCase())}</span>`;
  name.textContent = p.displayName || p.username;
  user.textContent = "@" + p.username;
  bio.textContent = p.bio ? p.bio : "";
  birth.textContent = p.birthDate ? ("🎂 " + p.birthDate) : "";

  if (!isMe) {
    const b = document.createElement("button");
    b.className = "btn primary full";
    b.textContent = "Открыть чат";
    b.onclick = () => { closeProfile(); openChat(p.username); };
    actions.appendChild(b);
  } else {
    const b = document.createElement("button");
    b.className = "btn ghost full";
    b.textContent = "Настройки профиля";
    b.onclick = () => { closeProfile(); openSettings(); };
    actions.appendChild(b);
  }
}

function closeProfile() {
  document.getElementById("profileModal").classList.add("hidden");
}

// ---------------- SETTINGS ----------------
function openSettings() {
  document.getElementById("settingsModal").classList.remove("hidden");
  document.getElementById("setDisplayName").value = me.displayName || "";
  document.getElementById("setBio").value = me.bio || "";
  document.getElementById("setBirthDate").value = me.birthDate || "";
  document.getElementById("setAvatarUrl").value = me.avatarUrl || "";
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

async function saveProfile() {
  const displayName = document.getElementById("setDisplayName").value.trim();
  const bio = document.getElementById("setBio").value.trim();
  const birthDate = document.getElementById("setBirthDate").value.trim();
  let avatarUrl = document.getElementById("setAvatarUrl").value.trim();

  const file = document.getElementById("avatarFile").files[0];
  if (file) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("receiver", "global");
    fd.append("text", "");
    const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
    const d = await r.json();
    if (d.ok && d.message && d.message.mediaUrl) {
      avatarUrl = d.message.mediaUrl;
    }
  }

  const r2 = await fetch("/api/me", {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, bio, birthDate, avatarUrl })
  });
  const d2 = await r2.json();
  if (!d2.ok) return alert(d2.error || "Ошибка сохранения");

  me = d2.profile;
  closeSettings();
  alert("Профиль обновлён ✅");
}

// ---------------- VOICE MESSAGE ----------------
async function toggleVoice() {
  const btn = document.getElementById("voiceBtn");

  if (recording && mediaRecorder) {
    mediaRecorder.stop();
    recording = false;
    btn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });

      const fd = new FormData();
      fd.append("file", file);
      fd.append("receiver", currentChat);
      fd.append("text", "");

      const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
      const d = await r.json();
      if (!d.ok) alert(d.error || "Ошибка голосового");

      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start();
    recording = true;
    btn.innerHTML = `<i class="fa-solid fa-stop"></i>`;
  } catch {
    alert("Не удалось включить микрофон");
  }
}

// ---------------- STORIES ----------------
async function loadStories() {
  const r = await fetch("/api/stories", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const map = new Map();
  d.stories.forEach(s => { if (!map.has(s.owner)) map.set(s.owner, s); });

  const list = document.getElementById("storiesList");
  list.innerHTML = "";

  [...map.values()].slice(0, 20).forEach(s => {
    const b = document.createElement("button");
    b.className = "storychip";
    b.onclick = () => viewStory(s);
    b.innerHTML = `
      <div class="storyava">${s.avatarUrl ? `<img src="${s.avatarUrl}" alt="">` : `<span>${esc((s.displayName||s.owner)[0].toUpperCase())}</span>`}</div>
      <div class="storyname">${esc((s.displayName || s.owner).split(" ")[0])}</div>
    `;
    list.appendChild(b);
  });
}

function openStoryComposer() {
  document.getElementById("storyModal").classList.remove("hidden");
  document.getElementById("storyFile").value = "";
  document.getElementById("storyText").value = "";
}
function closeStoryComposer() {
  document.getElementById("storyModal").classList.add("hidden");
}

async function publishStory() {
  const file = document.getElementById("storyFile").files[0] || null;
  const text = document.getElementById("storyText").value.trim();

  if (!file && !text) return alert("Добавь файл или текст");

  const fd = new FormData();
  if (file) fd.append("story", file);
  fd.append("text", text);

  const r = await fetch("/api/stories", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка сторис");

  closeStoryComposer();
  await loadStories();
  alert("Сторис опубликована ✅");
}

function viewStory(s) {
  if (s.mediaUrl) window.open(s.mediaUrl, "_blank");
  if (s.text) alert(`Сторис @${s.owner}:\n\n${s.text}`);
}

// ---------------- BIRTHDAYS ----------------
async function showBirthdays() {
  const banner = document.getElementById("birthdayBanner");
  const r = await fetch("/api/birthdays/today", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const list = d.list || [];
  const today = new Date();
  const mm = String(today.getMonth()+1).padStart(2,"0");
  const dd = String(today.getDate()).padStart(2,"0");
  const mine = (me.birthDate || "").slice(5,10) === `${mm}-${dd}`;

  if (!mine && list.length === 0) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }

  banner.classList.remove("hidden");
  const names = list.map(x => x.displayName || x.username).join(", ");
  banner.innerHTML = `
    ${mine ? `🎉 С днём рождения, ${esc(me.displayName || me.username)}!<br>` : ""}
    ${list.length ? `🎂 Сегодня день рождения у: ${esc(names)}` : ""}
  `;
}

// ---------------- AUDIO CALL (WebRTC) ----------------
function openCallModal(title, status) {
  document.getElementById("callModal").classList.remove("hidden");
  document.getElementById("callTitle").textContent = title;
  document.getElementById("callStatus").textContent = status || "Соединение...";
}

function closeCallModal() {
  document.getElementById("callModal").classList.add("hidden");
}

function showIncomingModal(from) {
  document.getElementById("incomingCallText").textContent = `@${from} звонит тебе`;
  document.getElementById("incomingCallModal").classList.remove("hidden");
}

function hideIncomingModal() {
  document.getElementById("incomingCallModal").classList.add("hidden");
}

async function startAudioCall() {
  if (currentChat === "global") return alert("Звонок только в личном чате");
  if (callPeer) return alert("Звонок уже идет");

  callPeer = currentChat;
  openCallModal(`Аудиозвонок с @${callPeer}`, "Звоним...");

  try {
    await createPeer(callPeer);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    wsSend({ type: "call-offer", to: callPeer, offer });
  } catch {
    alert("Не удалось начать звонок");
    cleanupCall();
  }
}

async function onIncomingOffer(data) {
  // если уже в звонке, отклоняем
  if (callPeer) {
    wsSend({ type: "call-reject", to: data.from });
    return;
  }

  pendingFrom = data.from;
  pendingOffer = data.offer;

  showIncomingModal(pendingFrom);
}

async function acceptIncomingCall() {
  if (!pendingFrom || !pendingOffer) return;

  try {
    hideIncomingModal();

    callPeer = pendingFrom;
    openCallModal(`Аудиозвонок с @${callPeer}`, "Подключение...");

    await createPeer(callPeer);
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    wsSend({ type: "call-answer", to: callPeer, answer });

    pendingFrom = null;
    pendingOffer = null;
  } catch {
    alert("Не удалось принять звонок");
    cleanupCall();
  }
}

function declineIncomingCall() {
  if (pendingFrom) wsSend({ type: "call-reject", to: pendingFrom });
  pendingFrom = null;
  pendingOffer = null;
  hideIncomingModal();
}

async function onAnswer(data) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  document.getElementById("callStatus").textContent = "Разговор начался ✅";
}

async function onIce(data) {
  if (!pc || !data.candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
}

function onCallEnd() {
  alert(`Звонок завершён`);
  cleanupCall();
}

function onCallReject(data) {
  alert(`@${data.from} отклонил звонок`);
  cleanupCall();
}

async function createPeer(peer) {
  pc = new RTCPeerConnection(rtcCfg);

  remoteStream = new MediaStream();
  document.getElementById("remoteAudio").srcObject = remoteStream;

  // На телефонах важно: playsinline уже есть в HTML, это ок
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (ev) => {
    if (ev.candidate) wsSend({ type: "ice", to: peer, candidate: ev.candidate });
  };

  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(t => {
      if (!remoteStream.getTracks().some(x => x.id === t.id)) remoteStream.addTrack(t);
    });
    document.getElementById("callStatus").textContent = "Разговор начался ✅";
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") document.getElementById("callStatus").textContent = "Разговор начался ✅";
    if (st === "failed" || st === "disconnected" || st === "closed") cleanupCall();
  };
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById("muteBtn").textContent = isMuted ? "Включить микрофон" : "Выключить микрофон";
}

function endCall() {
  if (callPeer) wsSend({ type: "call-end", to: callPeer });
  cleanupCall();
}

function cleanupCall() {
  hideIncomingModal();
  closeCallModal();

  try { pc && pc.close(); } catch {}
  pc = null;

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;

  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteStream = null;

  callPeer = null;
  isMuted = false;

  document.getElementById("muteBtn").textContent = "Выключить микрофон";
  document.getElementById("remoteAudio").srcObject = null;

  pendingFrom = null;
  pendingOffer = null;
}
