// ================== AUTH ==================
const token = localStorage.getItem("token");
if (!token) location.href = "index.html";

let me = null;
let currentChat = "global";
let ws = null;

// typing timer
let typingTimer = null;
let isTypingNow = false;

// audio recorder (hold)
let mediaRecorder = null;
let chunks = [];
let holding = false;

// WebRTC audio call
let pc = null;
let localStream = null;
let remoteStream = null;
let callPeer = null;
let isMuted = false;

// incoming offer buffer
let incomingOffer = null;
let incomingFrom = null;

const rtcCfg = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// online state
const onlineSet = new Set();

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

// ================== INIT ==================
async function initApp() {
  await loadMe();
  if (!me) return; // loadMe already redirected on failure
  connectWS();

  await openChat("global");
  await refreshChats();
  await loadStories();
  await showBirthdays();

  document.getElementById("callBtn").style.display = "none";

  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {}

  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");
}

async function loadMe() {
  const r = await fetch("/api/me", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return logout();
  me = d.profile;
}

// ================== NAV/UI ==================
function logout() {
  localStorage.removeItem("token");
  location.href = "index.html";
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("mobile-hidden");
}

function updateHeader() {
  const title = document.getElementById("chatTitle");
  const sub = document.getElementById("chatSub");
  title.textContent = currentChat === "global" ? "Общий чат" : "@" + currentChat;
  sub.textContent = currentChat === "global" ? "общение со всеми" : (onlineSet.has(currentChat) ? "в сети" : "не в сети");

  document.getElementById("callBtn").style.display = currentChat === "global" ? "none" : "inline-flex";
}

// ================== WS ==================
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}?token=${encodeURIComponent(token)}`);

  ws.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "presence") {
      onlineSet.clear();
      (data.online || []).forEach(u => onlineSet.add(u));
      updateHeader();
      renderOnlineDots();
      return;
    }

    if (data.type === "typing") {
      if (currentChat === data.from) {
        const el = document.getElementById("typingLine");
        el.classList.toggle("hidden", !data.isTyping);
      }
      return;
    }

    if (data.type === "messageDeleted") {
      const el = document.querySelector(`[data-mid="${data.id}"]`);
      if (el) el.remove();
      return;
    }

    // calls
    if (data.type === "call-offer") return onIncomingOffer(data);
    if (data.type === "call-answer") return onCallAnswer(data);
    if (data.type === "ice") return onIce(data);
    if (data.type === "call-end") return onCallEnd();
    if (data.type === "call-reject") return onCallReject(data);
    if (data.type === "call-error") return alert(data.message || "Ошибка звонка");

    if (data.type === "message") {
      const msg = data.message;
      if (shouldRender(msg)) renderMessage(msg);

      if (!shouldRender(msg) || document.hidden) maybeNotify(msg);

      await refreshChats();
      return;
    }
  };
}

function maybeNotify(msg) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (msg.sender === me.username) return;

    const title = msg.chatType === "global" ? "Общий чат" : "@" + msg.sender;
    const body = msg.mediaType !== "text" ? `[${msg.mediaType}]` : (msg.text || "");
    new Notification(title, { body });
  } catch {}
}

function typing(on) {
  if (!ws || ws.readyState !== 1) return;
  if (currentChat === "global") return;

  if (on && isTypingNow) return;

  isTypingNow = on;
  ws.send(JSON.stringify({ type: "typing", to: currentChat, isTyping: on }));

  if (typingTimer) clearTimeout(typingTimer);
  if (on) {
    typingTimer = setTimeout(() => {
      isTypingNow = false;
      ws.send(JSON.stringify({ type: "typing", to: currentChat, isTyping: false }));
    }, 1200);
  }
}

function shouldRender(msg) {
  if (msg.chatType === "global") return currentChat === "global";
  const other = msg.sender === me.username ? msg.receiver : msg.sender;
  return currentChat === other;
}

// ================== CHAT ==================
async function openChat(chat) {
  currentChat = chat === "global" ? "global" : String(chat).replace(/^@+/, "").toLowerCase();

  document.querySelectorAll(".chatitem").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.chatitem[data-chat="${currentChat}"]`);
  if (btn) btn.classList.add("active");

  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");

  document.getElementById("typingLine").classList.add("hidden");
  updateHeader();

  await loadMessages();
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
    body = `<img class="mimg" src="${esc(m.mediaUrl)}" alt="">`;
  } else if (m.mediaType === "video") {
    body = `<video class="mvid" controls playsinline src="${esc(m.mediaUrl)}"></video>`;
  } else if (m.mediaType === "audio") {
    body = `<audio class="maud" controls src="${esc(m.mediaUrl)}"></audio>`;
  } else {
    body = `<div class="mtext">${esc(m.text || "")}</div>`;
  }

  const del = mine ? `<button class="trash" onclick="deleteMsg(${m.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>` : "";

  const row = document.createElement("div");
  row.className = "mrow " + (mine ? "mine" : "other");
  row.dataset.mid = String(m.id);

  row.innerHTML = `
    <div class="bubble pop">
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
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  ws.send(JSON.stringify({ type: "text-message", receiver: currentChat, text }));
  input.value = "";
  typing(false);
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

    const isOn = onlineSet.has(c.username);

    btn.innerHTML = `
      <div class="avatar">${c.avatarUrl ? `<img src="${esc(c.avatarUrl)}" alt="">` : `<span>${esc((c.displayName || c.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(c.displayName || c.username)}</div>
        <div class="preview">${esc(c.preview || "")}</div>
      </div>
      <span class="dot ${isOn ? "online" : "offline"}" title="${isOn ? "Онлайн" : "Оффлайн"}"></span>
    `;
    wrap.appendChild(btn);
  });

  renderOnlineDots();
}

function renderOnlineDots() {
  document.querySelectorAll("#privateChats .chatitem").forEach(btn => {
    const u = btn.dataset.chat;
    const dot = btn.querySelector(".dot");
    if (!dot) return;
    const on = onlineSet.has(u);
    dot.classList.toggle("online", on);
    dot.classList.toggle("offline", !on);
  });
}

// ================== SEARCH ==================
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
    btn.onclick = () => { results.innerHTML = ""; document.getElementById("searchInput").value = ""; openChat(u.username); };
    btn.innerHTML = `
      <div class="avatar">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="">` : `<span>${esc((u.displayName || u.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(u.displayName || u.username)}</div>
        <div class="preview">@${esc(u.username)}</div>
      </div>
      <span class="dot ${onlineSet.has(u.username) ? "online" : "offline"}"></span>
    `;
    results.appendChild(btn);
  });
}

// ================== PROFILE VIEW ==================
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

  avatar.innerHTML = p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="">` : `<span>${esc((p.displayName || p.username)[0].toUpperCase())}</span>`;
  name.textContent = p.displayName || p.username;
  user.textContent = "@" + p.username;
  bio.textContent = p.bio ? p.bio : "";
  birth.textContent = p.birthDate ? ("🎂 " + p.birthDate) : ""; // only ever present when isMe, server no longer exposes others' birthDate

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

// ================== SETTINGS ==================
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
  const avatarUrl = document.getElementById("setAvatarUrl").value.trim();

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
  updateHeader();
  refreshChats();
}

// ================== VOICE (HOLD) ==================
async function startHoldVoice() {
  if (holding) return;
  holding = true;

  const btn = document.getElementById("voiceBtn");
  btn.classList.add("recording");
  btn.innerHTML = `<i class="fa-solid fa-stop"></i>`;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });

        const fd = new FormData();
        fd.append("file", file);
        fd.append("receiver", currentChat);
        fd.append("text", "");

        const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
        const d = await r.json();
        if (!d.ok) alert(d.error || "Ошибка голосового");
      } finally {
        stream.getTracks().forEach(t => t.stop());
      }
    };

    mediaRecorder.start();
  } catch {
    alert("Не удалось включить микрофон (разрешение?)");
    stopHoldVoice();
  }
}

function stopHoldVoice() {
  if (!holding) return;
  holding = false;

  const btn = document.getElementById("voiceBtn");
  btn.classList.remove("recording");
  btn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// ================== STORIES ==================
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
      <div class="storyava">${s.avatarUrl ? `<img src="${esc(s.avatarUrl)}" alt="">` : `<span>${esc((s.displayName || s.owner)[0].toUpperCase())}</span>`}</div>
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
  // textContent avoids any HTML injection via story text
  const msg = document.createElement("div");
  const owner = document.createElement("div");
  owner.textContent = `Сторис @${s.owner}`;
  msg.appendChild(owner);
  if (s.text) {
    const t = document.createElement("div");
    t.textContent = s.text;
    msg.appendChild(t);
  }
  alert(msg.textContent);
  if (s.mediaUrl) window.open(s.mediaUrl, "_blank");
}

// ================== BIRTHDAYS ==================
async function showBirthdays() {
  const banner = document.getElementById("birthdayBanner");
  const r = await fetch("/api/birthdays/today", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  const list = d.list || [];
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const mine = (me.birthDate || "").slice(5, 10) === `${mm}-${dd}`;

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

// ================== AUDIO CALL (WebRTC) ==================
function openIncoming(text) {
  document.getElementById("incomingCallText").textContent = text;
  document.getElementById("incomingCallModal").classList.remove("hidden");
}
function closeIncoming() {
  document.getElementById("incomingCallModal").classList.add("hidden");
}

function openCall(title, status) {
  document.getElementById("callTitle").textContent = title;
  document.getElementById("callStatus").textContent = status || "Соединение...";
  document.getElementById("callModal").classList.remove("hidden");
}
function closeCall() {
  document.getElementById("callModal").classList.add("hidden");
}

async function startAudioCall() {
  if (currentChat === "global") return alert("Звонок только в личном чате");
  if (callPeer) return alert("Звонок уже идет");
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  callPeer = currentChat;
  openCall(`Аудиозвонок с @${callPeer}`, "Звоним...");

  try {
    await createPeer(callPeer);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "call-offer", to: callPeer, offer }));
  } catch {
    alert("Не удалось начать звонок");
    cleanupCall();
  }
}

async function onIncomingOffer(data) {
  if (callPeer) {
    ws.send(JSON.stringify({ type: "call-reject", to: data.from }));
    return;
  }

  incomingFrom = data.from;
  incomingOffer = data.offer;

  openIncoming(`@${incomingFrom} звонит тебе`);
}

async function acceptIncomingCall() {
  if (!incomingFrom || !incomingOffer) return;

  closeIncoming();
  callPeer = incomingFrom;
  openCall(`Аудиозвонок с @${callPeer}`, "Подключение...");

  try {
    await createPeer(callPeer);
    await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "call-answer", to: callPeer, answer }));

    incomingFrom = null;
    incomingOffer = null;
  } catch {
    alert("Не удалось принять звонок");
    cleanupCall();
  }
}

function declineIncomingCall() {
  if (incomingFrom) {
    ws.send(JSON.stringify({ type: "call-reject", to: incomingFrom }));
  }
  incomingFrom = null;
  incomingOffer = null;
  closeIncoming();
}

async function onCallAnswer(data) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  document.getElementById("callStatus").textContent = "Разговор начался ✅";
}

async function onIce(data) {
  if (!pc || !data.candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
}

function onCallEnd() {
  alert("Звонок завершён");
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

  // getUserMedia requires HTTPS in production (Render provides this by default).
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      ws.send(JSON.stringify({ type: "ice", to: peer, candidate: ev.candidate }));
    }
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
    if (["failed", "disconnected", "closed"].includes(st)) cleanupCall();
  };
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById("muteBtn").textContent = isMuted ? "Включить микрофон" : "Выключить микрофон";
}

function endCall() {
  if (callPeer && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "call-end", to: callPeer }));
  }
  cleanupCall();
}

function cleanupCall() {
  closeCall();
  closeIncoming();

  try { pc && pc.close(); } catch {}
  pc = null;

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;

  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteStream = null;

  callPeer = null;
  incomingFrom = null;
  incomingOffer = null;
  isMuted = false;

  document.getElementById("muteBtn").textContent = "Выключить микрофон";
  document.getElementById("remoteAudio").srcObject = null;
}
