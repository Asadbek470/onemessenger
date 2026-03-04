// ===============================
// CONFIG & GLOBALS
// ===============================
const API = "/api";
let token = localStorage.getItem("token");
let currentUser = null;
let currentChat = "global";
let ws = null;
let pc = null;
let localStream = null;
let currentCallUser = null;
let recorder = null;
let audioChunks = [];
let typingTimer = null;
let recording = false;
let stories = [];
let currentStoryIndex = 0;

// ===============================
// INIT
// ===============================
async function init() {
  if (!token) {
    location.href = "/index.html";
    return;
  }
  await loadProfile();
  connectWS();
  loadChats();
  loadMessages("global");
  loadStories();
  checkBirthdays();
}
window.addEventListener("load", init);

// ===============================
// PROFILE
// ===============================
async function loadProfile() {
  const res = await fetch(API + "/me", {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  if (!data.ok) {
    localStorage.removeItem("token");
    location.href = "/index.html";
    return;
  }
  currentUser = data.profile;
  updateHeader();
}

function updateHeader() {
  if (currentChat === "global") {
    document.getElementById("chatTitle").innerText = "Общий чат";
    document.getElementById("chatSub").innerText = "общение со всеми";
  } else {
    // будет обновлено при openChat
  }
}

// ===============================
// WEBSOCKET
// ===============================
function connectWS() {
  ws = new WebSocket(`wss://${location.host}?token=${token}`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case "message":
        appendMessage(data.message);
        break;
      case "messageDeleted":
        removeMessage(data.id);
        break;
      case "call-offer":
        incomingCall(data.from, data.offer);
        break;
      case "call-answer":
        if (pc) pc.setRemoteDescription(data.answer);
        break;
      case "ice":
        if (pc) pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        break;
      case "call-end":
        endCall();
        break;
      case "status":
        updateUserStatus(data.username, data.status);
        break;
      case "typing":
        showTypingIndicator(data.from);
        break;
      case "ws-ready":
        console.log("WebSocket ready", data.username);
        break;
      case "moderation":
        alert(data.message);
        break;
      case "call-error":
        alert(data.message);
        break;
    }
  };
}

// ===============================
// STATUS & TYPING
// ===============================
function updateUserStatus(username, status) {
  const chatItem = document.querySelector(`.chatitem[data-username="${username}"]`);
  if (chatItem) {
    const dot = chatItem.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${status}`;
  }
}

function showTypingIndicator(from) {
  if (from !== currentChat) return;
  const sub = document.getElementById("chatSub");
  const original = sub.dataset.original || sub.innerText;
  sub.dataset.original = original;
  sub.innerText = "печатает...";
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    sub.innerText = original;
  }, 2000);
}

function sendTyping() {
  if (!currentChat || currentChat === "global") return;
  ws.send(JSON.stringify({ type: "typing", to: currentChat }));
}

// ===============================
// CHATS
// ===============================
async function loadChats() {
  const res = await fetch(API + "/chats", {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  const list = document.getElementById("privateChats");
  list.innerHTML = "";
  data.chats.forEach(chat => {
    const div = document.createElement("button");
    div.className = "chatitem";
    div.setAttribute("data-username", chat.username);
    div.onclick = () => openChat(chat.username);
    const avatarHtml = chat.avatarUrl ? `<img src="${chat.avatarUrl}">` : '<i class="fa-solid fa-user"></i>';
    const statusClass = (chat.lastSeen > Date.now() - 60000) ? "online" : "offline"; // приблизительно
    div.innerHTML = `
      <div class="avatar">${avatarHtml}</div>
      <div class="meta">
        <div class="name">${chat.displayName} <span class="status-dot ${statusClass}"></span></div>
        <div class="preview">${chat.preview || ""}</div>
      </div>
    `;
    list.appendChild(div);
  });
}

// ===============================
// MESSAGES
// ===============================
async function loadMessages(chat) {
  const res = await fetch(API + "/messages?chat=" + chat, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  const container = document.getElementById("messages");
  container.innerHTML = "";
  data.messages.forEach(m => appendMessage(m));
  container.scrollTop = container.scrollHeight;
}

function appendMessage(m) {
  const container = document.getElementById("messages");
  const isMine = m.sender === currentUser.username;
  const div = document.createElement("div");
  div.className = `mrow ${isMine ? "mine" : "other"}`;
  div.id = `msg-${m.id}`;

  let content = "";
  if (m.mediaType === "text") {
    content = `<div class="mtext">${escapeHtml(m.text)}</div>`;
  } else if (m.mediaType === "image") {
    content = `<img src="${m.mediaUrl}" class="mimg" onclick="openMedia('${m.mediaUrl}')">`;
  } else if (m.mediaType === "video") {
    content = `<video src="${m.mediaUrl}" controls class="mvid"></video>`;
  } else if (m.mediaType === "audio") {
    content = `<audio src="${m.mediaUrl}" controls class="maud"></audio>`;
  }

  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const deleteBtn = isMine ? `<button class="trash" onclick="deleteMessage(${m.id})"><i class="fa-regular fa-trash-can"></i></button>` : '';

  div.innerHTML = `
    <div class="bubble">
      <div class="btop">
        <span class="who">${m.sender}</span>
        ${deleteBtn}
      </div>
      ${content}
      <div class="btime">${time}</div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeMessage(id) {
  const el = document.getElementById(`msg-${id}`);
  if (el) el.remove();
}

async function deleteMessage(id) {
  if (!confirm("Удалить сообщение?")) return;
  const res = await fetch(API + "/messages/" + id, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  if (!data.ok) alert("Ошибка удаления");
}

// ===============================
// SEND TEXT
// ===============================
function sendText() {
  const input = document.getElementById("textInput");
  const text = input.value.trim();
  if (!text) return;

  ws.send(JSON.stringify({
    type: "text-message",
    receiver: currentChat,
    text
  }));
  input.value = "";
}

// ===============================
// UPLOAD MEDIA
// ===============================
async function uploadFile(file, text = "") {
  const form = new FormData();
  form.append("file", file);
  form.append("receiver", currentChat);
  if (text) form.append("text", text);

  await fetch(API + "/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form
  });
}

function sendMedia(input) {
  const file = input.files[0];
  if (file) {
    uploadFile(file);
    input.value = "";
  }
}

// ===============================
// AUDIO MESSAGE (удержание кнопки)
// ===============================
let recordTimeout;
function startRecording() {
  if (recording) return;
  recording = true;
  document.getElementById("voiceBtn").classList.add("recording");

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      recorder = new MediaRecorder(stream);
      audioChunks = [];
      recorder.ondataavailable = e => audioChunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        uploadFile(blob);
        stream.getTracks().forEach(t => t.stop());
      };
      recorder.start();
    })
    .catch(err => alert("Нет доступа к микрофону"));
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  document.getElementById("voiceBtn").classList.remove("recording");
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

// Для мобильных можно использовать touch события, но пока так:
document.getElementById("voiceBtn").addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});
document.getElementById("voiceBtn").addEventListener("mouseup", stopRecording);
document.getElementById("voiceBtn").addEventListener("mouseleave", stopRecording);

// ===============================
// OPEN CHAT
// ===============================
async function openChat(chat) {
  currentChat = chat;
  loadMessages(chat);

  if (chat === "global") {
    document.getElementById("chatTitle").innerText = "Общий чат";
    document.getElementById("chatSub").innerText = "общение со всеми";
    document.getElementById("callBtn").disabled = true;
  } else {
    // Загружаем информацию о пользователе
    const res = await fetch(API + "/users/" + chat, {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("chatTitle").innerText = data.user.displayName || data.user.username;
      document.getElementById("chatSub").innerText = data.user.bio || "";
      document.getElementById("callBtn").disabled = false;
    }
  }
  // обновить активный класс в сайдбаре
  document.querySelectorAll(".chatitem").forEach(el => el.classList.remove("active"));
  const active = document.querySelector(`.chatitem[data-username="${chat}"]`);
  if (active) active.classList.add("active");
  else if (chat === "global") {
    document.querySelector('.chatitem[data-chat="global"]').classList.add("active");
  }
}

// ===============================
// SEARCH USERS
// ===============================
let searchTimeout;
function searchUsers(query) {
  clearTimeout(searchTimeout);
  if (!query.trim()) {
    document.getElementById("searchResults").innerHTML = "";
    return;
  }
  searchTimeout = setTimeout(async () => {
    const res = await fetch(API + "/users/search?q=" + encodeURIComponent(query), {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    const results = document.getElementById("searchResults");
    results.innerHTML = "";
    data.users.forEach(u => {
      const btn = document.createElement("button");
      btn.className = "chatitem";
      btn.onclick = () => openChat(u.username);
      btn.innerHTML = `
        <div class="avatar">${u.avatarUrl ? `<img src="${u.avatarUrl}">` : '<i class="fa-solid fa-user"></i>'}</div>
        <div class="meta">
          <div class="name">${u.displayName} <span class="status-dot offline"></span></div>
          <div class="preview">@${u.username}</div>
        </div>
      `;
      results.appendChild(btn);
    });
  }, 300);
}

// ===============================
// STORIES
// ===============================
async function loadStories() {
  const res = await fetch(API + "/stories", {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  stories = data.stories || [];
  renderStories();
}

function renderStories() {
  const list = document.getElementById("storiesList");
  list.innerHTML = "";
  // группируем по пользователям (берём последнюю сторис каждого)
  const grouped = new Map();
  stories.forEach(s => {
    if (!grouped.has(s.owner) || grouped.get(s.owner).createdAt < s.createdAt) {
      grouped.set(s.owner, s);
    }
  });
  grouped.forEach(s => {
    const btn = document.createElement("button");
    btn.className = "storychip";
    btn.onclick = () => openStoryViewer(s.owner);
    btn.innerHTML = `
      <div class="storyava">${s.avatarUrl ? `<img src="${s.avatarUrl}">` : '<i class="fa-solid fa-circle-user"></i>'}</div>
      <span class="storyname">${s.displayName || s.owner}</span>
    `;
    list.appendChild(btn);
  });
}

function openStoryComposer() {
  document.getElementById("storyModal").classList.remove("hidden");
}

function closeStoryComposer() {
  document.getElementById("storyModal").classList.add("hidden");
}

async function publishStory() {
  const fileInput = document.getElementById("storyFile");
  const text = document.getElementById("storyText").value.trim();
  const form = new FormData();
  if (fileInput.files[0]) form.append("story", fileInput.files[0]);
  if (text) form.append("text", text);

  const res = await fetch(API + "/stories", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form
  });
  const data = await res.json();
  if (data.ok) {
    closeStoryComposer();
    loadStories();
  } else {
    alert("Ошибка публикации");
  }
}

function openStoryViewer(owner) {
  const userStories = stories.filter(s => s.owner === owner);
  if (userStories.length === 0) return;
  currentStoryIndex = 0;
  showStoryModal(userStories);
}

function showStoryModal(storiesArray) {
  // создаём модалку просмотра сторис (упрощённо)
  let html = `<div class="story-viewer">`;
  storiesArray.forEach((s, i) => {
    html += `<div class="story-page ${i === 0 ? 'active' : ''}" data-index="${i}">`;
    if (s.mediaType === "image") {
      html += `<img src="${s.mediaUrl}" class="story-media">`;
    } else if (s.mediaType === "video") {
      html += `<video src="${s.mediaUrl}" class="story-media" controls autoplay></video>`;
    }
    if (s.text) html += `<div class="story-text">${escapeHtml(s.text)}</div>`;
    html += `</div>`;
  });
  html += `
    <button class="story-prev" onclick="prevStory()">‹</button>
    <button class="story-next" onclick="nextStory()">›</button>
    <button class="story-close" onclick="closeStoryViewer()">✕</button>
  `;
  const modal = document.createElement("div");
  modal.id = "storyViewerModal";
  modal.className = "modal";
  modal.innerHTML = `<div class="story-viewer-card">${html}</div>`;
  document.body.appendChild(modal);
}

function closeStoryViewer() {
  const modal = document.getElementById("storyViewerModal");
  if (modal) modal.remove();
}

function nextStory() {
  // логика переключения
}

function prevStory() {
  // логика переключения
}

// ===============================
// CALLS (только аудио)
// ===============================
async function startCall() {
  if (currentChat === "global") {
    alert("Нельзя позвонить в общий чат");
    return;
  }
  currentCallUser = currentChat;
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    // аудио автоматически воспроизводится через <audio> элемент
    document.getElementById("remoteAudio").srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "ice",
        to: currentCallUser,
        candidate: event.candidate
      }));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: "call-offer",
    to: currentCallUser,
    offer
  }));

  document.getElementById("callModal").classList.remove("hidden");
  document.getElementById("callStatus").innerText = "Звонок...";
}

async function incomingCall(from, offer) {
  currentCallUser = from;
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    document.getElementById("remoteAudio").srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "ice",
        to: from,
        candidate: event.candidate
      }));
    }
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(JSON.stringify({
    type: "call-answer",
    to: from,
    answer
  }));

  document.getElementById("incomingCallModal").classList.remove("hidden");
  document.getElementById("incomingCallText").innerText = `Входящий звонок от @${from}`;
}

function acceptIncomingCall() {
  document.getElementById("incomingCallModal").classList.add("hidden");
  document.getElementById("callModal").classList.remove("hidden");
  document.getElementById("callStatus").innerText = "Соединение...";
}

function declineIncomingCall() {
  ws.send(JSON.stringify({ type: "call-end", to: currentCallUser }));
  document.getElementById("incomingCallModal").classList.add("hidden");
  if (pc) pc.close();
  pc = null;
  if (localStream) localStream.getTracks().forEach(t => t.stop());
}

function endCall() {
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  pc = null;
  document.getElementById("callModal").classList.add("hidden");
  document.getElementById("remoteAudio").srcObject = null;
  if (currentCallUser) {
    ws.send(JSON.stringify({ type: "call-end", to: currentCallUser }));
    currentCallUser = null;
  }
}

function toggleMute() {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    document.getElementById("muteBtn").innerText = audioTrack.enabled ? "Выключить микрофон" : "Включить микрофон";
  }
}

// ===============================
// PROFILE MODAL
// ===============================
async function openCurrentProfile() {
  if (currentChat === "global") return;
  const res = await fetch(API + "/users/" + currentChat, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  if (!data.ok) return;
  showProfileModal(data.user);
}

function showProfileModal(user) {
  document.getElementById("profileName").innerText = user.displayName || user.username;
  document.getElementById("profileUser").innerText = "@" + user.username;
  document.getElementById("profileBio").innerText = user.bio || "";
  document.getElementById("profileBirth").innerText = user.birthDate ? `ДР: ${user.birthDate}` : "";
  const avatar = document.getElementById("profileAvatar");
  avatar.innerHTML = user.avatarUrl ? `<img src="${user.avatarUrl}">` : '<i class="fa-solid fa-user"></i>';
  document.getElementById("profileActions").innerHTML = `
    <button class="btn primary" onclick="openChat('${user.username}')">Написать</button>
    <button class="btn ghost" onclick="startCallWith('${user.username}')">Позвонить</button>
  `;
  document.getElementById("profileModal").classList.remove("hidden");
}

function startCallWith(username) {
  closeProfile();
  openChat(username);
  startCall();
}

function closeProfile() {
  document.getElementById("profileModal").classList.add("hidden");
}

// ===============================
// SETTINGS MODAL
// ===============================
function openSettings() {
  document.getElementById("setDisplayName").value = currentUser.displayName || "";
  document.getElementById("setBio").value = currentUser.bio || "";
  document.getElementById("setBirthDate").value = currentUser.birthDate || "";
  document.getElementById("setAvatarUrl").value = currentUser.avatarUrl || "";
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

async function saveProfile() {
  const displayName = document.getElementById("setDisplayName").value.trim();
  const bio = document.getElementById("setBio").value.trim();
  const birthDate = document.getElementById("setBirthDate").value.trim();
  let avatarUrl = document.getElementById("setAvatarUrl").value.trim();
  const avatarFile = document.getElementById("avatarFile").files[0];

  if (avatarFile) {
    // загружаем аватар как файл
    const form = new FormData();
    form.append("file", avatarFile);
    form.append("receiver", "global"); // заглушка
    const uploadRes = await fetch(API + "/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: form
    });
    const uploadData = await uploadRes.json();
    if (uploadData.ok) {
      avatarUrl = uploadData.message.mediaUrl;
    }
  }

  const res = await fetch(API + "/me", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token
    },
    body: JSON.stringify({ displayName, bio, birthDate, avatarUrl })
  });
  const data = await res.json();
  if (data.ok) {
    currentUser = data.profile;
    closeSettings();
    loadChats(); // обновить имена в списке
  } else {
    alert("Ошибка сохранения");
  }
}

// ===============================
// BIRTHDAYS
// ===============================
async function checkBirthdays() {
  const res = await fetch(API + "/birthdays/today", {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  if (data.list.length > 0) {
    const names = data.list.map(u => u.displayName || u.username).join(", ");
    document.getElementById("birthdayBanner").innerText = `🎉 Сегодня день рождения: ${names}`;
    document.getElementById("birthdayBanner").classList.remove("hidden");
  }
}

// ===============================
// LOGOUT
// ===============================
function logout() {
  localStorage.removeItem("token");
  location.href = "/index.html";
}

// ===============================
// UTILS
// ===============================
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function onEnter(e) {
  if (e.key === "Enter") {
    sendText();
    sendTyping(); // можно и так
  } else {
    // отправляем typing при вводе
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      sendTyping();
    }, 500);
  }
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("mobile-hidden");
}
