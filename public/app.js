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
  alert("Код-пароль установлен ✅");
}

function removePasscodeFromSettings() {
  if (!confirm("Убрать код-пароль с этого устройства?")) return;
  localStorage.removeItem("passcodeHash");
  renderPasscodeSection();
}

function lockNow() {
  if (!passcodeEnabled()) return alert("Сначала установи код-пароль");
  document.getElementById("passcodeOverlay").classList.remove("hidden");
  closeSettings();
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

  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.add("mobile-hidden");

  document.getElementById("typingLine").classList.add("hidden");

  if (isGroupChat(currentChat)) {
    const groupId = currentChat.slice(6);
    const r = await fetch(`/api/groups/${groupId}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.ok) currentGroupMeta = { ...d.group, memberCount: d.members.length, myRole: d.myRole };
  }

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
  } else if (m.mediaType === "list") {
    body = renderListBody(m);
  } else {
    body = `<div class="mtext">${esc(m.text || "")}</div>`;
  }

  const del = mine ? `<button class="trash" onclick="deleteMsg(${m.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>` : "";
  const senderLine = (m.chatType === "global" || m.chatType === "group") ? `<div class="who">${esc(m.sender)}</div>` : "";

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
  scrollBottom();
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
    <div class="memberrow">
      <div class="avatar">${mem.avatarUrl ? `<img src="${esc(mem.avatarUrl)}" alt="">` : `<span>${esc((mem.displayName || mem.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(mem.displayName || mem.username)}${verifiedBadge(mem.verified)}</div>
        <div class="preview">@${esc(mem.username)} · ${mem.role === "owner" ? "владелец" : mem.role === "admin" ? "админ" : "участник"}</div>
      </div>
      ${(canManage && mem.role !== "owner" && mem.username !== me.username) ? `<button class="iconbtn" onclick="removeGroupMember('${groupId}','${esc(mem.username)}')" title="Убрать"><i class="fa-solid fa-user-minus"></i></button>` : ""}
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
  if (currentChat === "global" || isGroupChat(currentChat)) {
    if (isGroupChat(currentChat)) return openGroupInfo();
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
  name.innerHTML = esc(p.displayName || p.username) + verifiedBadge(p.verified);
  user.textContent = "@" + p.username;
  bio.textContent = p.bio ? p.bio : "";
  birth.textContent = p.birthDate ? ("🎂 " + p.birthDate) : ""; // only ever present when isMe

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

  renderPasscodeSection();
  render2FASection();
  renderWallpaperSection();
  renderVerificationSection();
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

  me = { ...me, ...d2.profile };
  alert("Профиль обновлён ✅");
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
  alert("2FA включена ✅");
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
  alert("2FA отключена");
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
  alert("Заявка отправлена, ожидай решения администратора");
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
  alert("Сторис опубликована ✅");
}

function viewStory(s) {
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
