// ================== AUTH ==================
const token = localStorage.getItem("token");
if (!token) location.href = "index.html";

let me = null;
let currentChat = "global"; // 'global' | username | 'group:<id>'
let currentGroupMeta = null; // populated when currentChat is a group
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

// list of the user's groups/channels, refreshed alongside private chats
let myGroups = [];

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

function verifiedBadge(isVerified) {
  return isVerified ? ` <i class="fa-solid fa-circle-check verified-badge" title="Официально подтверждён"></i>` : "";
}

// ================== PASSCODE LOCK (device-local) ==================
// This locks the app on THIS device/browser only. It is not an account
// security feature (that's 2FA below) and is not synced anywhere — it's
// the same idea as Telegram's local passcode.
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function passcodeEnabled() {
  return !!localStorage.getItem("passcodeHash");
}

async function unlockAttempt() {
  const input = document.getElementById("passcodeInput");
  const err = document.getElementById("passcodeError");
  const hash = await sha256Hex(input.value.trim());
  if (hash === localStorage.getItem("passcodeHash")) {
    document.getElementById("passcodeOverlay").classList.add("hidden");
    input.value = "";
    err.textContent = "";
    boot();
  } else {
    err.textContent = "Неверный код";
    input.value = "";
  }
}

function passcodeKeydown(e) {
  if (e.key === "Enter") unlockAttempt();
}

async function setPasscodeFromSettings() {
  const p1 = document.getElementById("newPasscode").value.trim();
  const p2 = document.getElementById("newPasscodeConfirm").value.trim();
  if (!/^\d{4,8}$/.test(p1)) return alert("Код: 4-8 цифр");
  if (p1 !== p2) return alert("Коды не совпадают");
  localStorage.setItem("passcodeHash", await sha256Hex(p1));
  document.getElementById("newPasscode").value = "";
  document.getElementById("newPasscodeConfirm").value = "";
  renderPasscodeSection();
  toast("Код-пароль установлен ✅");
}

function removePasscodeFromSettings() {
  if (!confirm("Убрать код-пароль с этого устройства?")) return;
  localStorage.removeItem("passcodeHash");
  renderPasscodeSection();
}

function lockNow() {
  if (!passcodeEnabled()) return alert("Сначала установи код-пароль");
  document.getElementById("passcodeOverlay").classList.remove("hidden");
}

function renderPasscodeSection() {
  const box = document.getElementById("passcodeSection");
  if (passcodeEnabled()) {
    box.innerHTML = `
      <div class="hint">Код-пароль включён на этом устройстве.</div>
      <div class="row">
        <button class="btn ghost" onclick="lockNow()">Заблокировать сейчас</button>
        <button class="btn danger" onclick="removePasscodeFromSettings()">Убрать код</button>
      </div>
    `;
  } else {
    box.innerHTML = `
      <label>Новый код (4-8 цифр)</label>
      <input id="newPasscode" type="password" inputmode="numeric" maxlength="8">
      <label>Повтори код</label>
      <input id="newPasscodeConfirm" type="password" inputmode="numeric" maxlength="8">
      <button class="btn primary full" onclick="setPasscodeFromSettings()">Установить код-пароль</button>
    `;
  }
}

// ================== BOOT ==================
window.addEventListener("DOMContentLoaded", () => {
  if (passcodeEnabled()) {
    document.getElementById("passcodeOverlay").classList.remove("hidden");
    document.getElementById("passcodeInput").focus();
  } else {
    boot();
  }
});

function boot() { initApp(); }

// ================== INIT ==================
async function initApp() {
  await loadMe();
  if (!me) return; // loadMe already redirected on failure

  applyTheme(me.settings || {});
  connectWS();

  await refreshChats();
  await loadStories();
  await showBirthdays();

  document.getElementById("callBtn").style.display = "none";

  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {}

  switchTab("chats");
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function loadMe() {
  for (;;) {
    try {
      const r = await fetch("/api/me", { headers: authHeaders() });

      // Only a real "your token is invalid/expired" answer should log the
      // person out. Anything else (server briefly waking up on a free host,
      // a dropped connection, a non-JSON error page) must NOT wipe the saved
      // token — that was the bug causing "logged out on every refresh".
      if (r.status === 401) return logout();

      const d = await r.json();
      if (!d.ok) {
        showBootError("Не удалось загрузить профиль, пробую ещё раз...");
        await sleep(3000);
        continue;
      }

      hideBootError();
      me = d.profile;
      return;
    } catch {
      // Network error / server still starting up (common right after a
      // free-tier host wakes up) — retry instead of logging out.
      showBootError("Сервер сейчас недоступен (возможно, ещё запускается). Пробую ещё раз...");
      await sleep(3000);
    }
  }
}

function showBootError(text) {
  let box = document.getElementById("bootError");
  if (!box) {
    box = document.createElement("div");
    box.id = "bootError";
    box.className = "banner";
    box.style.margin = "16px";
    document.body.prepend(box);
  }
  box.textContent = text;
}
function hideBootError() {
  const box = document.getElementById("bootError");
  if (box) box.remove();
}

// ================== NAV/UI ==================
function logout() {
  localStorage.removeItem("token");
  location.href = "index.html";
}

// Bottom-tab navigation replaces the old left sidebar entirely. There are
// three tabs (chats / profile / settings) plus a fourth "screen" — an open
// chat conversation — that slides in over everything and hides the tab bar.
let activeTab = "chats";

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("screenChat").classList.add("hidden");

  document.getElementById(`screen${tab[0].toUpperCase()}${tab.slice(1)}`).classList.remove("hidden");
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("bottomNav").classList.remove("hidden");

  if (tab === "profile") loadMyProfileTab();
  if (tab === "settings") openSettings();
}

function isGroupChat(chat) {
  return typeof chat === "string" && chat.startsWith("group:");
}

function updateHeader() {
  const title = document.getElementById("chatTitle");
  const sub = document.getElementById("chatSub");

  if (currentChat === "global") {
    title.textContent = "Общий чат";
    sub.textContent = "общение со всеми";
  } else if (isGroupChat(currentChat)) {
    const g = currentGroupMeta;
    title.innerHTML = (g ? esc(g.name) : "Группа") + (g && g.isChannel ? ` <i class="fa-solid fa-bullhorn" title="Канал"></i>` : "");
    sub.textContent = g ? (g.isChannel ? "канал" : `${g.memberCount || ""} участников`.trim()) : "";
  } else {
    title.textContent = "@" + currentChat;
    sub.textContent = onlineSet.has(currentChat) ? "в сети" : "не в сети";
  }

  document.getElementById("callBtn").style.display = (currentChat !== "global" && !isGroupChat(currentChat)) ? "inline-flex" : "none";
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
      if (currentChat === data.from || (isGroupChat(currentChat) && data.to === currentChat)) {
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

    if (data.type === "listUpdated") {
      updateListBubble(data.id, data.list);
      return;
    }

    if (data.type === "giftReceived") {
      toast(`${data.emoji} @${data.from} подарил тебе подарок!`);
      if (activeTab === "profile") loadMyProfileTab();
      return;
    }

    if (data.type === "call-error") { if (data.message) alert(data.message); return; }

    // calls
    if (data.type === "call-offer") return onIncomingOffer(data);
    if (data.type === "call-answer") return onCallAnswer(data);
    if (data.type === "ice") return onIce(data);
    if (data.type === "call-end") return onCallEnd();
    if (data.type === "call-reject") return onCallReject(data);

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

    const title = msg.chatType === "global" ? "Общий чат" : (msg.chatType === "group" ? "Группа" : "@" + msg.sender);
    const body = msg.mediaType !== "text" ? (msg.mediaType === "list" ? "[список]" : `[${msg.mediaType}]`) : (msg.text || "");
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
  if (msg.chatType === "group") return currentChat === msg.receiver;
  const other = msg.sender === me.username ? msg.receiver : msg.sender;
  return currentChat === other;
}

// ================== CHAT ==================
async function openChat(chat) {
  currentChat = chat === "global" ? "global" : (isGroupChat(chat) ? chat : String(chat).replace(/^@+/, "").toLowerCase());
  currentGroupMeta = null;

  document.querySelectorAll(".chatitem").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.chatitem[data-chat="${currentChat}"]`);
  if (btn) btn.classList.add("active");

  document.getElementById("typingLine").classList.add("hidden");

  // opening a chat slides its own full-screen conversation over the tabs
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("screenChat").classList.remove("hidden");
  document.getElementById("bottomNav").classList.add("hidden");

  if (isGroupChat(currentChat)) {
    const groupId = currentChat.slice(6);
    const r = await fetch(`/api/groups/${groupId}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.ok) currentGroupMeta = { ...d.group, memberCount: d.members.length, myRole: d.myRole };
  }

  updateHeader();
  await loadMessages();
}

function backToChats() {
  document.getElementById("screenChat").classList.add("hidden");
  document.getElementById("bottomNav").classList.remove("hidden");
  switchTab("chats");
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
    body = renderVoiceBody(m);
  } else if (m.mediaType === "list") {
    body = renderListBody(m);
  } else {
    body = `<div class="mtext">${esc(m.text || "")}</div>`;
  }

  const del = mine ? `<button class="trash" onclick="deleteMsg(${m.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>` : "";
  const senderLine = (m.chatType === "global" || m.chatType === "group")
    ? `<div class="who clickable" onclick="openProfile('${esc(m.sender)}', ${m.sender === me.username})">${esc(m.sender)}</div>`
    : "";

  const row = document.createElement("div");
  row.className = "mrow " + (mine ? "mine" : "other");
  row.dataset.mid = String(m.id);

  row.innerHTML = `
    <div class="bubble pop">
      <div class="btop">
        ${senderLine}
        ${del}
      </div>
      ${body}
    </div>
  `;

  box.appendChild(row);
  if (m.mediaType === "audio") setupVoicePlayer(m.id);
  scrollBottom();
}

// ---------------- custom voice message player ----------------
// A native <audio controls> element renders tiny and inconsistently across
// browsers, which is exactly the "маленький формат" complaint — so instead
// we drive a full-width custom play/seek/duration UI off a hidden <audio>.
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function renderVoiceBody(m) {
  return `
    <div class="voicecard" data-voice-id="${m.id}">
      <button class="voiceplay" id="voice-${m.id}-btn" onclick="toggleVoicePlay(${m.id})">
        <i class="fa-solid fa-play" id="voice-${m.id}-icon"></i>
      </button>
      <div class="voicemain">
        <div class="voicetrack" id="voice-${m.id}-track" onclick="seekVoice(event, ${m.id})">
          <div class="voiceprogress" id="voice-${m.id}-progress"></div>
        </div>
        <div class="voicetime" id="voice-${m.id}-time">0:00</div>
      </div>
      <audio id="voice-${m.id}-audio" src="${esc(m.mediaUrl)}" preload="metadata"></audio>
    </div>
  `;
}

function setupVoicePlayer(id) {
  const audio = document.getElementById(`voice-${id}-audio`);
  const icon = document.getElementById(`voice-${id}-icon`);
  const progress = document.getElementById(`voice-${id}-progress`);
  const time = document.getElementById(`voice-${id}-time`);
  if (!audio) return;

  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration)) time.textContent = fmtTime(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.duration) progress.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    if (!audio.paused) time.textContent = fmtTime(audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    icon.className = "fa-solid fa-play";
    progress.style.width = "0%";
    time.textContent = isFinite(audio.duration) ? fmtTime(audio.duration) : "0:00";
  });
  audio.addEventListener("pause", () => { icon.className = "fa-solid fa-play"; });
  audio.addEventListener("play", () => { icon.className = "fa-solid fa-pause"; });
}

function toggleVoicePlay(id) {
  const audio = document.getElementById(`voice-${id}-audio`);
  if (!audio) return;

  // only one voice message plays at a time
  document.querySelectorAll("audio[id^='voice-'][id$='-audio']").forEach(a => {
    if (a !== audio && !a.paused) a.pause();
  });

  if (audio.paused) audio.play(); else audio.pause();
}

function seekVoice(evt, id) {
  const audio = document.getElementById(`voice-${id}-audio`);
  const track = document.getElementById(`voice-${id}-track`);
  if (!audio || !audio.duration) return;

  const rect = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
}

function renderListBody(m) {
  let list;
  try { list = JSON.parse(m.text); } catch { return `<div class="mtext">[список]</div>`; }
  const items = (list.items || []).map((it, i) => `
    <li class="listitem ${it.checked ? "checked" : ""}" onclick="toggleListItem(${m.id}, ${i})">
      <i class="fa-solid ${it.checked ? "fa-square-check" : "fa-square"}"></i>
      <span>${esc(it.text)}</span>
    </li>
  `).join("");
  return `
    <div class="listcard" data-list-id="${m.id}">
      <div class="listtitle"><i class="fa-solid fa-list-check"></i> ${esc(list.title || "Список")}</div>
      <ul class="listitems">${items}</ul>
    </div>
  `;
}

function updateListBubble(id, list) {
  const card = document.querySelector(`.listcard[data-list-id="${id}"]`);
  if (!card) return;
  const items = (list.items || []).map((it, i) => `
    <li class="listitem ${it.checked ? "checked" : ""}" onclick="toggleListItem(${id}, ${i})">
      <i class="fa-solid ${it.checked ? "fa-square-check" : "fa-square"}"></i>
      <span>${esc(it.text)}</span>
    </li>
  `).join("");
  card.querySelector(".listitems").innerHTML = items;
}

function toggleListItem(id, itemIndex) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "list-toggle", id, itemIndex }));
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

// ---------------- shopping / to-do list composer ----------------
function openListComposer() {
  document.getElementById("listModal").classList.remove("hidden");
  document.getElementById("listTitle").value = "";
  const rows = document.getElementById("listItemRows");
  rows.innerHTML = "";
  addListRow();
  addListRow();
}
function closeListComposer() {
  document.getElementById("listModal").classList.add("hidden");
}
function addListRow() {
  const rows = document.getElementById("listItemRows");
  const row = document.createElement("input");
  row.className = "listRowInput";
  row.placeholder = "Пункт списка...";
  rows.appendChild(row);
  row.focus();
}
function publishList() {
  const title = document.getElementById("listTitle").value.trim() || "Список";
  const items = [...document.querySelectorAll(".listRowInput")].map(i => i.value.trim()).filter(Boolean);
  if (items.length === 0) return alert("Добавь хотя бы один пункт");
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  ws.send(JSON.stringify({ type: "list-message", receiver: currentChat, title, items }));
  closeListComposer();
}

// ---------------- attach menu (photo/video vs list) ----------------
function toggleAttachMenu() {
  document.getElementById("attachMenu").classList.toggle("hidden");
}
function attachPickMedia() {
  document.getElementById("attachMenu").classList.add("hidden");
  document.getElementById("fileInput").click();
}
function attachPickList() {
  document.getElementById("attachMenu").classList.add("hidden");
  openListComposer();
}

async function refreshChats() {
  const [chatsRes, groupsRes] = await Promise.all([
    fetch("/api/chats", { headers: authHeaders() }),
    fetch("/api/groups", { headers: authHeaders() })
  ]);
  const chatsData = await chatsRes.json();
  const groupsData = await groupsRes.json();
  if (groupsData.ok) myGroups = groupsData.groups;

  const wrap = document.getElementById("privateChats");
  wrap.innerHTML = "";

  if (groupsData.ok) {
    groupsData.groups.forEach(g => {
      const chatKey = `group:${g.id}`;
      const btn = document.createElement("button");
      btn.className = "chatitem";
      btn.dataset.chat = chatKey;
      btn.onclick = () => openChat(chatKey);
      btn.innerHTML = `
        <div class="avatar circle group">${g.avatarUrl ? `<img src="${esc(g.avatarUrl)}" alt="">` : `<i class="fa-solid ${g.isChannel ? "fa-bullhorn" : "fa-users"}"></i>`}</div>
        <div class="meta">
          <div class="name">${esc(g.name)}</div>
          <div class="preview">${g.isChannel ? "канал" : "группа"}</div>
        </div>
      `;
      wrap.appendChild(btn);
    });
  }

  if (chatsData.ok) {
    chatsData.chats.forEach(c => {
      const btn = document.createElement("button");
      btn.className = "chatitem";
      btn.dataset.chat = c.username;
      btn.onclick = () => openChat(c.username);

      const isOn = onlineSet.has(c.username);

      btn.innerHTML = `
        <div class="avatar">${c.avatarUrl ? `<img src="${esc(c.avatarUrl)}" alt="">` : `<span>${esc((c.displayName || c.username)[0].toUpperCase())}</span>`}</div>
        <div class="meta">
          <div class="name">${esc(c.displayName || c.username)}${verifiedBadge(c.verified)}</div>
          <div class="preview">${esc(c.preview || "")}</div>
        </div>
        <span class="dot ${isOn ? "online" : "offline"}" title="${isOn ? "Онлайн" : "Оффлайн"}"></span>
      `;
      wrap.appendChild(btn);
    });
  }

  document.querySelectorAll(".chatitem").forEach(b => b.classList.toggle("active", b.dataset.chat === currentChat));
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

// ================== GROUPS & CHANNELS ==================
function openCreateGroupModal(isChannel) {
  document.getElementById("groupModal").classList.remove("hidden");
  document.getElementById("groupModalTitle").textContent = isChannel ? "Новый канал" : "Новая группа";
  document.getElementById("groupIsChannel").value = isChannel ? "1" : "0";
  document.getElementById("groupName").value = "";
  document.getElementById("groupDesc").value = "";
  document.getElementById("groupMembers").value = "";
}
function closeCreateGroupModal() {
  document.getElementById("groupModal").classList.add("hidden");
}
async function submitCreateGroup() {
  const name = document.getElementById("groupName").value.trim();
  const description = document.getElementById("groupDesc").value.trim();
  const isChannel = document.getElementById("groupIsChannel").value === "1";
  const members = document.getElementById("groupMembers").value
    .split(",").map(s => s.trim().replace(/^@+/, "")).filter(Boolean);

  if (!name) return alert("Введи название");

  const r = await fetch("/api/groups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, isChannel, members })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка создания");

  closeCreateGroupModal();
  await refreshChats();
  openChat(`group:${d.id}`);
}

async function openGroupInfo() {
  if (!isGroupChat(currentChat)) return;
  const groupId = currentChat.slice(6);
  const r = await fetch(`/api/groups/${groupId}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");

  const modal = document.getElementById("groupInfoModal");
  modal.classList.remove("hidden");
  document.getElementById("groupInfoTitle").textContent = d.group.name + (d.group.isChannel ? " (канал)" : "");
  document.getElementById("groupInfoDesc").textContent = d.group.description || "";

  const canManage = d.myRole === "owner" || d.myRole === "admin";
  const list = document.getElementById("groupMembersList");
  list.innerHTML = d.members.map(mem => `
    <div class="memberrow clickable" onclick="openProfile('${esc(mem.username)}', ${mem.username === me.username})">
      <div class="avatar">${mem.avatarUrl ? `<img src="${esc(mem.avatarUrl)}" alt="">` : `<span>${esc((mem.displayName || mem.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(mem.displayName || mem.username)}${verifiedBadge(mem.verified)}</div>
        <div class="preview">@${esc(mem.username)} · ${mem.role === "owner" ? "владелец" : mem.role === "admin" ? "админ" : "участник"}</div>
      </div>
      ${(canManage && mem.role !== "owner" && mem.username !== me.username) ? `<button class="iconbtn" onclick="event.stopPropagation(); removeGroupMember('${groupId}','${esc(mem.username)}')" title="Убрать"><i class="fa-solid fa-user-minus"></i></button>` : ""}
    </div>
  `).join("");

  document.getElementById("groupAddMemberRow").classList.toggle("hidden", !canManage);
  document.getElementById("groupLeaveBtn").onclick = () => removeGroupMember(groupId, me.username, true);
}
function closeGroupInfo() {
  document.getElementById("groupInfoModal").classList.add("hidden");
}
async function addGroupMember() {
  const groupId = currentChat.slice(6);
  const username = document.getElementById("groupAddMemberInput").value.trim().replace(/^@+/, "");
  if (!username) return;

  const r = await fetch(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  document.getElementById("groupAddMemberInput").value = "";
  openGroupInfo();
}
async function removeGroupMember(groupId, username, isSelf = false) {
  if (isSelf && !confirm("Покинуть группу?")) return;
  const r = await fetch(`/api/groups/${groupId}/members/${encodeURIComponent(username)}`, {
    method: "DELETE", headers: authHeaders()
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");

  if (isSelf) {
    closeGroupInfo();
    await refreshChats();
    openChat("global");
  } else {
    openGroupInfo();
  }
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
        <div class="name">${esc(u.displayName || u.username)}${verifiedBadge(u.verified)}</div>
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
    switchTab("profile");
  } else if (isGroupChat(currentChat)) {
    openGroupInfo();
  } else {
    await openProfile(currentChat, false);
  }
}

// Viewing your OWN profile always goes to the Профиль tab now; this modal
// is only ever used for other people, plus it now shows/sends gifts.
async function openProfile(username, isMe) {
  if (isMe) { switchTab("profile"); return; }

  const modal = document.getElementById("profileModal");
  modal.classList.remove("hidden");
  document.getElementById("giftPickerBox").classList.add("hidden");

  const title = document.getElementById("profileTitle");
  const avatar = document.getElementById("profileAvatar");
  const name = document.getElementById("profileName");
  const user = document.getElementById("profileUser");
  const bio = document.getElementById("profileBio");
  const birth = document.getElementById("profileBirth");
  const actions = document.getElementById("profileActions");

  title.textContent = "Профиль";
  actions.innerHTML = "";

  const r = await fetch(`/api/users/${encodeURIComponent(username)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) { alert("Не найден"); return closeProfile(); }
  const p = d.user;

  avatar.innerHTML = p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="">` : `<span>${esc((p.displayName || p.username)[0].toUpperCase())}</span>`;
  name.innerHTML = esc(p.displayName || p.username) + verifiedBadge(p.verified);
  user.textContent = "@" + p.username;
  bio.textContent = p.bio ? p.bio : "";
  birth.textContent = "";

  const openChatBtn = document.createElement("button");
  openChatBtn.className = "btn primary full";
  openChatBtn.textContent = "Открыть чат";
  openChatBtn.onclick = () => { closeProfile(); openChat(p.username); };
  actions.appendChild(openChatBtn);

  const giftBtn = document.createElement("button");
  giftBtn.className = "btn ghost full";
  giftBtn.innerHTML = `🎁 Подарить`;
  giftBtn.onclick = () => openGiftPicker(p.username);
  actions.appendChild(giftBtn);

  await loadGifts(username, "profileGiftsRow");
}

function closeProfile() {
  document.getElementById("profileModal").classList.add("hidden");
}

// ================== SETTINGS ==================
function openSettings() {
  document.getElementById("setDisplayName").value = me.displayName || "";
  document.getElementById("setBio").value = me.bio || "";
  document.getElementById("setBirthDate").value = me.birthDate || "";
  document.getElementById("setAvatarUrl").value = me.avatarUrl || "";

  renderPasscodeSection();
  render2FASection();
  renderWallpaperSection();
  renderVerificationSection();
  renderDeleteAccountSection();
}

// ---------------- DELETE ACCOUNT (tucked away in Settings on purpose) ----------------
function renderDeleteAccountSection() {
  const box = document.getElementById("deleteAccountSection");
  box.innerHTML = `<button class="btn small-link" onclick="revealDeleteAccountForm()">Удалить аккаунт навсегда</button>`;
}

function revealDeleteAccountForm() {
  const box = document.getElementById("deleteAccountSection");
  box.innerHTML = `
    <div class="hint">Это необратимо: удалятся твой профиль, все сообщения и участие в группах/каналах. Подтверди паролем.</div>
    <label>Пароль</label>
    <input id="deleteAccountPassword" type="password">
    <button class="btn danger full" onclick="confirmDeleteAccount()">Подтвердить удаление</button>
    <button class="btn ghost full" onclick="renderDeleteAccountSection()">Отмена</button>
  `;
}

async function confirmDeleteAccount() {
  const password = document.getElementById("deleteAccountPassword").value;
  if (!password) return alert("Введи пароль");
  if (!confirm("Точно удалить аккаунт навсегда? Это нельзя отменить.")) return;

  const r = await fetch("/api/me", {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка удаления");

  localStorage.removeItem("token");
  location.href = "index.html";
}

async function uploadAvatarFile(input) {
  const file = input.files[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("file", file);

  const r = await fetch("/api/me/avatar", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  input.value = "";
  if (!d.ok) return alert(d.error || "Ошибка загрузки аватара");

  document.getElementById("setAvatarUrl").value = d.avatarUrl;
  me.avatarUrl = d.avatarUrl;
  updateHeader();
  refreshChats();
  toast("Аватар обновлён ✅");
}

function toast(text) {
  let el = document.getElementById("toastBox");
  if (!el) {
    el = document.createElement("div");
    el.id = "toastBox";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove("show"), 2200);
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

  me = { ...me, ...d2.profile };
  toast("Профиль обновлён ✅");
  updateHeader();
  refreshChats();
}

// ---------------- THEME / WALLPAPER ----------------
const WALLPAPER_PRESETS = [
  { id: "default", label: "Стандартные" },
  { id: "night", label: "Ночь" },
  { id: "ocean", label: "Океан" },
  { id: "sunset", label: "Закат" },
  { id: "forest", label: "Лес" }
];
const ACCENT_PRESETS = ["#2a9df4", "#29d17d", "#ff8a3d", "#ff4d9d", "#a06bff"];

function applyTheme(settings) {
  document.body.dataset.wallpaper = settings.wallpaper || "default";
  if (settings.accent) document.documentElement.style.setProperty("--blue", settings.accent);
}

function renderWallpaperSection() {
  const box = document.getElementById("wallpaperSection");
  const current = (me.settings || {}).wallpaper || "default";
  const currentAccent = (me.settings || {}).accent || "#2a9df4";

  box.innerHTML = `
    <label>Обои чата</label>
    <div class="swatchrow">
      ${WALLPAPER_PRESETS.map(w => `
        <button class="wallswatch wp-${w.id} ${current === w.id ? "active" : ""}" onclick="pickWallpaper('${w.id}')" title="${w.label}"></button>
      `).join("")}
    </div>
    <label>Акцентный цвет</label>
    <div class="swatchrow">
      ${ACCENT_PRESETS.map(c => `
        <button class="colorswatch ${currentAccent === c ? "active" : ""}" style="background:${c}" onclick="pickAccent('${c}')"></button>
      `).join("")}
    </div>
  `;
}

async function saveSettingsPatch(patch) {
  const r = await fetch("/api/me/settings", {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  const d = await r.json();
  if (d.ok) {
    me.settings = d.settings;
    applyTheme(me.settings);
  }
  return d;
}
async function pickWallpaper(id) {
  await saveSettingsPatch({ wallpaper: id });
  renderWallpaperSection();
}
async function pickAccent(color) {
  await saveSettingsPatch({ accent: color });
  renderWallpaperSection();
}

// ---------------- 2FA ----------------
function render2FASection() {
  const box = document.getElementById("twoFASection");
  if (me.totpEnabled) {
    box.innerHTML = `
      <div class="hint">Двухэтапная аутентификация включена ✅</div>
      <label>Пароль (для отключения)</label>
      <input id="disable2FAPassword" type="password">
      <button class="btn danger full" onclick="disable2FA()">Отключить 2FA</button>
    `;
  } else {
    box.innerHTML = `
      <div class="hint">Защити вход кодом из приложения-аутентификатора (Google Authenticator, Authy и т.п.)</div>
      <button class="btn primary full" onclick="start2FASetup()">Включить 2FA</button>
      <div id="twoFASetupBox"></div>
    `;
  }
}

async function start2FASetup() {
  const r = await fetch("/api/2fa/setup", { method: "POST", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");

  const box = document.getElementById("twoFASetupBox");
  box.innerHTML = `
    <div class="hint">Отсканируй QR в приложении-аутентификаторе или введи ключ вручную:</div>
    <div id="totpQr" class="totpqr"></div>
    <div class="totpsecret">${esc(d.secret)}</div>
    <label>Код из приложения</label>
    <input id="confirm2FACode" inputmode="numeric" maxlength="6" placeholder="000000">
    <button class="btn primary full" onclick="confirm2FASetup()">Подтвердить и включить</button>
  `;

  if (window.QRCode) {
    new QRCode(document.getElementById("totpQr"), { text: d.otpauthUrl, width: 160, height: 160 });
  }
}

async function confirm2FASetup() {
  const code = document.getElementById("confirm2FACode").value.trim();
  const r = await fetch("/api/2fa/confirm", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Неверный код");

  me.totpEnabled = true;
  toast("2FA включена ✅");
  render2FASection();
}

async function disable2FA() {
  const password = document.getElementById("disable2FAPassword").value;
  const r = await fetch("/api/2fa/disable", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");

  me.totpEnabled = false;
  toast("2FA отключена");
  render2FASection();
}

// ---------------- VERIFICATION (official badge) ----------------
function renderVerificationSection() {
  const box = document.getElementById("verificationSection");
  if (me.verified) {
    box.innerHTML = `<div class="hint">Аккаунт официально подтверждён ✅</div>`;
    return;
  }
  box.innerHTML = `
    <div class="hint">Подтверди, что аккаунт представляет реальную организацию — после одобрения появится значок ✅</div>
    <label>Организация</label>
    <input id="verOrg" placeholder="ООО Ромашка">
    <label>Должность</label>
    <input id="verRole" placeholder="Директор по маркетингу">
    <label>Ссылка-подтверждение (сайт компании, соцсети и т.п.)</label>
    <input id="verProof" placeholder="https://...">
    <button class="btn primary full" onclick="submitVerification()">Отправить заявку</button>
    <div id="verMineList" class="hint"></div>
  `;
  loadMyVerificationRequests();
}

async function submitVerification() {
  const orgName = document.getElementById("verOrg").value.trim();
  const role = document.getElementById("verRole").value.trim();
  const proofUrl = document.getElementById("verProof").value.trim();

  const r = await fetch("/api/verification/request", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ orgName, role, proofUrl })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка отправки");
  toast("Заявка отправлена, ожидай решения администратора");
  loadMyVerificationRequests();
}

async function loadMyVerificationRequests() {
  const r = await fetch("/api/verification/mine", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;
  const box = document.getElementById("verMineList");
  if (!box) return;
  if (d.requests.length === 0) { box.textContent = ""; return; }
  const statusRu = { pending: "на рассмотрении", approved: "одобрена", rejected: "отклонена" };
  box.innerHTML = "Твои заявки: " + d.requests.map(r => `${esc(r.orgName)} — ${statusRu[r.status] || r.status}`).join(", ");
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

// ================== MY PROFILE TAB ==================
async function loadMyProfileTab() {
  document.getElementById("myProfileAvatar").innerHTML = me.avatarUrl
    ? `<img src="${esc(me.avatarUrl)}" alt="">`
    : `<span>${esc((me.displayName || me.username)[0].toUpperCase())}</span>`;
  document.getElementById("myProfileName").innerHTML = esc(me.displayName || me.username) + verifiedBadge(me.verified);
  document.getElementById("myProfileUser").textContent = "@" + me.username;
  document.getElementById("myProfileBio").textContent = me.bio || "";

  await loadGifts(me.username, "myGiftsRow");

  const r = await fetch("/api/stories/mine", { headers: authHeaders() });
  const d = await r.json();
  const grid = document.getElementById("myStoriesGrid");
  if (!d.ok || d.stories.length === 0) {
    grid.innerHTML = `<div class="hint">Ты ещё не публиковал(а) историй</div>`;
    return;
  }

  grid.innerHTML = d.stories.map(s => {
    const thumb = s.mediaType === "image" ? `<img src="${esc(s.mediaUrl)}" alt="">`
      : s.mediaType === "video" ? `<video src="${esc(s.mediaUrl)}" muted></video>`
      : `<div class="storythumb-text">${esc((s.text || "").slice(0, 40))}</div>`;
    return `
      <button class="storythumb ${s.active ? "" : "expired"}" onclick='viewStory(${JSON.stringify(s).replace(/'/g, "&#39;")})'>
        ${thumb}
        ${!s.active ? '<span class="storythumb-badge">истекла</span>' : ""}
      </button>
    `;
  }).join("");
}

// ================== GIFTS ==================
async function loadGifts(username, containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;

  const r = await fetch(`/api/gifts/${encodeURIComponent(username)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok || d.gifts.length === 0) { box.innerHTML = ""; return; }

  box.innerHTML = d.gifts.map(g => `<span class="gift-badge" title="от @${esc(g.sender)}">${g.emoji}</span>`).join("");
}

const GIFT_EMOJIS = ["🎁", "🌟", "💎", "🔥", "❤️", "🏆", "👑", "✨", "🎉", "🌹"];
let giftRecipient = null;

function openGiftPicker(username) {
  giftRecipient = username;
  const box = document.getElementById("giftPickerBox");
  box.classList.remove("hidden");
  document.getElementById("giftCodeInput").value = "";
  document.getElementById("giftEmojiRow").innerHTML = GIFT_EMOJIS
    .map(e => `<button class="gift-emoji-btn" onclick="sendGift('${e}')">${e}</button>`)
    .join("");
}

async function sendGift(emoji) {
  if (!giftRecipient) return;
  const code = document.getElementById("giftCodeInput").value.trim();

  const r = await fetch("/api/gifts/send", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: giftRecipient, emoji, code })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Не получилось подарить");

  toast(`${emoji} Подарок отправлен!`);
  document.getElementById("giftPickerBox").classList.add("hidden");
  await loadGifts(giftRecipient, "profileGiftsRow");
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
      <div class="storyname">${esc((s.displayName || s.owner).split(" ")[0])}${verifiedBadge(s.verified)}</div>
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
}

// ---------------- full-screen story viewer (replaces the old plain alert()) ----------------
let storyTimer = null;
const STORY_DURATION_MS = 6000; // images/text; a video instead runs for its own length

function closeStoryViewer() {
  const modal = document.getElementById("storyViewerModal");
  modal.classList.add("hidden");
  document.getElementById("storyViewerMedia").innerHTML = "";
  clearTimeout(storyTimer);
  storyTimer = null;
}

function viewStory(s) {
  const modal = document.getElementById("storyViewerModal");
  modal.classList.remove("hidden");

  const avatarBox = document.getElementById("storyViewerAvatar");
  avatarBox.innerHTML = s.avatarUrl ? `<img src="${esc(s.avatarUrl)}" alt="">` : `<span>${esc((s.displayName || s.owner)[0].toUpperCase())}</span>`;
  document.getElementById("storyViewerName").innerHTML = esc(s.displayName || s.owner) + verifiedBadge(s.verified);
  document.getElementById("storyViewerCaption").textContent = s.text || "";

  const mediaBox = document.getElementById("storyViewerMedia");
  mediaBox.innerHTML = "";
  clearTimeout(storyTimer);

  const bar = document.getElementById("storyProgressBar");
  bar.style.transition = "none";
  bar.style.width = "0%";
  // force reflow so the next transition actually animates from 0
  void bar.offsetWidth;

  if (s.mediaType === "video" && s.mediaUrl) {
    const video = document.createElement("video");
    video.src = s.mediaUrl;
    video.autoplay = true;
    video.playsInline = true;
    video.className = "storyviewer-video";
    mediaBox.appendChild(video);
    video.addEventListener("loadedmetadata", () => {
      const durMs = isFinite(video.duration) ? video.duration * 1000 : STORY_DURATION_MS;
      animateStoryProgress(bar, durMs);
      storyTimer = setTimeout(closeStoryViewer, durMs);
    });
  } else if (s.mediaType === "image" && s.mediaUrl) {
    const img = document.createElement("img");
    img.src = s.mediaUrl;
    img.className = "storyviewer-image";
    mediaBox.appendChild(img);
    animateStoryProgress(bar, STORY_DURATION_MS);
    storyTimer = setTimeout(closeStoryViewer, STORY_DURATION_MS);
  } else {
    // text-only story: give it a nice gradient card instead of a bare page
    const card = document.createElement("div");
    card.className = "storyviewer-textcard";
    card.textContent = s.text || "";
    mediaBox.appendChild(card);
    animateStoryProgress(bar, STORY_DURATION_MS);
    storyTimer = setTimeout(closeStoryViewer, STORY_DURATION_MS);
  }
}

function animateStoryProgress(bar, durMs) {
  requestAnimationFrame(() => {
    bar.style.transition = `width ${durMs}ms linear`;
    bar.style.width = "100%";
  });
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
let callTimerInterval = null;
let callStartedAt = null;
let isSpeakerOn = false;
const userInfoCache = new Map();

async function getUserInfo(username) {
  if (userInfoCache.has(username)) return userInfoCache.get(username);
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(username)}`, { headers: authHeaders() });
    const d = await r.json();
    const info = d.ok ? d.user : { username, displayName: username, avatarUrl: "" };
    userInfoCache.set(username, info);
    return info;
  } catch {
    return { username, displayName: username, avatarUrl: "" };
  }
}

function renderCallAvatar(el, info) {
  el.innerHTML = info.avatarUrl
    ? `<img src="${esc(info.avatarUrl)}" alt="">`
    : `<span>${esc((info.displayName || info.username)[0].toUpperCase())}</span>`;
}

async function openIncoming(username) {
  const info = await getUserInfo(username);
  document.getElementById("incomingCallText").textContent = `@${username} звонит тебе`;
  renderCallAvatar(document.getElementById("incomingCallAvatar"), info);
  document.getElementById("incomingCallModal").classList.remove("hidden");
}
function closeIncoming() {
  document.getElementById("incomingCallModal").classList.add("hidden");
}

async function openCall(username, status) {
  const info = await getUserInfo(username);
  document.getElementById("callTitle").textContent = info.displayName || `@${username}`;
  document.getElementById("callStatus").textContent = status || "Соединение...";
  renderCallAvatar(document.getElementById("callAvatar"), info);
  document.getElementById("callAvatarRing").classList.remove("connected");
  document.getElementById("callTimer").classList.add("hidden");
  document.getElementById("callModal").classList.remove("hidden");
}
function closeCall() {
  document.getElementById("callModal").classList.add("hidden");
}

function startCallTimer() {
  callStartedAt = Date.now();
  document.getElementById("callTimer").classList.remove("hidden");
  document.getElementById("callAvatarRing").classList.add("connected");
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - callStartedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    document.getElementById("callTimer").textContent = `${mm}:${ss}`;
  }, 1000);
}
function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callStartedAt = null;
}

function markConnected() {
  document.getElementById("callStatus").textContent = "Разговор идёт";
  if (!callTimerInterval) startCallTimer();
}

async function startAudioCall() {
  if (currentChat === "global" || isGroupChat(currentChat)) return alert("Звонок только в личном чате");
  if (callPeer) return alert("Звонок уже идет");
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  callPeer = currentChat;
  await openCall(callPeer, "Звоним...");

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

  openIncoming(incomingFrom);
}

async function acceptIncomingCall() {
  if (!incomingFrom || !incomingOffer) return;

  closeIncoming();
  callPeer = incomingFrom;
  await openCall(callPeer, "Подключение...");

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
  markConnected();
}

async function onIce(data) {
  if (!pc || !data.candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
}

function onCallEnd() {
  cleanupCall();
}
function onCallReject(data) {
  document.getElementById("callStatus").textContent = `@${data.from} отклонил звонок`;
  setTimeout(cleanupCall, 1200);
}

async function createPeer(peer) {
  pc = new RTCPeerConnection(rtcCfg);

  remoteStream = new MediaStream();
  document.getElementById("remoteAudio").srcObject = remoteStream;

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
    markConnected();
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") markConnected();
    if (["failed", "disconnected", "closed"].includes(st)) cleanupCall();
  };
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById("muteBtn");
  btn.classList.toggle("callbtn-active", isMuted);
  btn.innerHTML = `<i class="fa-solid ${isMuted ? "fa-microphone-slash" : "fa-microphone"}"></i>`;
}

async function toggleSpeaker() {
  const audioEl = document.getElementById("remoteAudio");
  isSpeakerOn = !isSpeakerOn;
  const btn = document.getElementById("speakerBtn");
  btn.classList.toggle("callbtn-active", isSpeakerOn);
  btn.innerHTML = `<i class="fa-solid ${isSpeakerOn ? "fa-volume-high" : "fa-volume-low"}"></i>`;
  // setSinkId is only supported in some browsers (mainly desktop Chrome/Edge);
  // where unsupported this simply becomes a visual toggle with no effect.
  if (typeof audioEl.setSinkId === "function") {
    try { await audioEl.setSinkId(isSpeakerOn ? "default" : ""); } catch {}
  }
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
  stopCallTimer();

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
  isSpeakerOn = false;

  const muteBtn = document.getElementById("muteBtn");
  muteBtn.classList.remove("callbtn-active");
  muteBtn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;

  const speakerBtn = document.getElementById("speakerBtn");
  speakerBtn.classList.remove("callbtn-active");
  speakerBtn.innerHTML = `<i class="fa-solid fa-volume-high"></i>`;

  document.getElementById("remoteAudio").srcObject = null;
}
