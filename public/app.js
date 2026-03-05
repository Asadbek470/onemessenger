const API = "/api";
let token = localStorage.getItem("token");
let currentUser = null;
let currentChat = "global";
let ws = null;
let pc = null;
let localStream = null;
let currentCallUser = null;
let mediaRecorder = null;
let audioChunks = [];
let typingTimer = null;
let recording = false;
let stories = [];

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
  }
}

function connectWS() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}?token=${token}`);
  ws.onopen = () => console.log("WebSocket открыт");
  ws.onerror = (err) => console.error("WebSocket ошибка", err);
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
        console.log("WebSocket готов", data.username);
        break;
      case "moderation":
        alert(data.message);
        break;
      case "call-error":
        alert(data.message);
        break;
    }
  };
  ws.onclose = () => {
    console.log("WebSocket закрыт, переподключение через 3 сек");
    setTimeout(connectWS, 3000);
  };
}

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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "typing", to: currentChat }));
  }
}

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
    const avatarHtml = chat.avatarUrl ? `<img src="${chat.avatarUrl}">` : '<span>👤</span>';
    const statusClass = (chat.lastSeen > Date.now() - 60000) ? "online" : "offline";
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
    content = `<img src="${m.mediaUrl}" class="mimg" onclick="window.open('${m.mediaUrl}')">`;
  } else if (m.mediaType === "video") {
    content = `<video src="${m.mediaUrl}" controls class="mvid"></video>`;
  } else if (m.mediaType === "audio") {
    content = `<audio src="${m.mediaUrl}" controls class="maud"></audio>`;
  }

  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const deleteBtn = isMine ? `<button class="trash" onclick="deleteMessage(${m.id})"><span>🗑️</span></button>` : '';

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

function sendText() {
  const input = document.getElementById("textInput");
  const text = input.value.trim();
  if (!text) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "text-message",
      receiver: currentChat,
      text
    }));
    input.value = "";
  } else {
    alert("Нет соединения с сервером");
  }
}

async function uploadFile(file, text = "") {
  const form = new FormData();
  form.append("file", file);
  form.append("receiver", currentChat);
  if (text) form.append("text", text);

  try {
    const res = await fetch(API + "/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: form
    });
    const data = await res.json();
    if (!data.ok) alert("Ошибка загрузки файла");
  } catch (e) {
    alert("Ошибка сети при загрузке");
  }
}

function sendMedia(input) {
  const file = input.files[0];
  if (file) {
    uploadFile(file);
    input.value = "";
  }
}

// Голосовые сообщения (удержание)
document.getElementById("voiceBtn").addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});
document.getElementById("voiceBtn").addEventListener("mouseup", stopRecording);
document.getElementById("voiceBtn").addEventListener("mouseleave", stopRecording);

function startRecording() {
  if (recording) return;
  recording = true;
  document.getElementById("voiceBtn").classList.add("recording");

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        uploadFile(blob);
        stream.getTracks().forEach(t => t.stop());
        recording = false;
        document.getElementById("voiceBtn").classList.remove("recording");
      };
      mediaRecorder.start();
    })
    .catch(() => {
      alert("Нет доступа к микрофону");
      recording = false;
      document.getElementById("voiceBtn").classList.remove("recording");
    });
}

function stopRecording() {
  if (!recording) return;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// ==================== УЛУЧШЕННАЯ МОБИЛЬНАЯ ВЕРСИЯ ====================

// Функция принудительного закрытия сайдбара
function forceCloseSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  if (sidebar) {
    sidebar.classList.add("mobile-hidden");
  }
  if (overlay) {
    overlay.classList.remove("active");
  }
}

// Функция сворачивания поиска
function closeSearch() {
  const toggle = document.querySelector('.search-toggle');
  const expanded = document.getElementById('searchExpanded');
  if (toggle && expanded) {
    toggle.classList.remove('hidden');
    expanded.classList.add('hidden');
    const results = document.getElementById('searchResults');
    if (results) results.innerHTML = '';
  }
}

// ОСНОВНАЯ ФУНКЦИЯ ОТКРЫТИЯ ЧАТА
async function openChat(chat) {
  // Сворачиваем поиск
  closeSearch();

  // Загружаем сообщения
  currentChat = chat;
  loadMessages(chat);

  // Обновляем заголовок
  if (chat === "global") {
    document.getElementById("chatTitle").innerText = "Общий чат";
    document.getElementById("chatSub").innerText = "общение со всеми";
    document.getElementById("callBtn").disabled = true;
  } else {
    try {
      const res = await fetch(API + "/users/" + chat, {
        headers: { Authorization: "Bearer " + token }
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById("chatTitle").innerText = data.user.displayName || data.user.username;
        document.getElementById("chatSub").innerText = data.user.bio || "";
        document.getElementById("callBtn").disabled = false;
      }
    } catch (e) {
      console.error("Ошибка загрузки пользователя", e);
    }
  }

  // Обновляем активный класс
  document.querySelectorAll(".chatitem").forEach(el => el.classList.remove("active"));
  const active = document.querySelector(`.chatitem[data-username="${chat}"]`);
  if (active) active.classList.add("active");
  else if (chat === "global") {
    document.querySelector('.chatitem[data-chat="global"]')?.classList.add("active");
  }

  // ========== ГЛАВНОЕ: ПРИНУДИТЕЛЬНО ЗАКРЫВАЕМ САЙДБАР ==========
  forceCloseSidebar();
  // =================================================================
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  if (sidebar && overlay) {
    sidebar.classList.toggle("mobile-hidden");
    overlay.classList.toggle("active");
  }
}

// Функции для сворачивания поиска и историй
function toggleSearch() {
  const toggle = document.querySelector('.search-toggle');
  const expanded = document.getElementById('searchExpanded');
  if (toggle && expanded) {
    toggle.classList.add('hidden');
    expanded.classList.remove('hidden');
    document.getElementById('searchInput').focus();
  }
}

let storiesCollapsed = false;
function toggleStories() {
  const container = document.getElementById('storiesContainer');
  const toggleBtn = document.querySelector('.toggle-stories');
  if (container && toggleBtn) {
    storiesCollapsed = !storiesCollapsed;
    if (storiesCollapsed) {
      container.classList.add('collapsed');
      toggleBtn.textContent = '▶';
    } else {
      container.classList.remove('collapsed');
      toggleBtn.textContent = '▼';
    }
  }
}

// ====================================================================

let searchTimeout;
function searchUsers(query) {
  clearTimeout(searchTimeout);
  if (!query.trim()) {
    document.getElementById("searchResults").innerHTML = "";
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
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
          <div class="avatar">${u.avatarUrl ? `<img src="${u.avatarUrl}">` : '<span>👤</span>'}</div>
          <div class="meta">
            <div class="name">${u.displayName} <span class="status-dot offline"></span></div>
            <div class="preview">@${u.username}</div>
          </div>
        `;
        results.appendChild(btn);
      });
    } catch (e) {
      console.error("Ошибка поиска", e);
    }
  }, 300);
}

async function loadStories() {
  try {
    const res = await fetch(API + "/stories", {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    stories = data.stories || [];
    renderStories();
  } catch (e) {
    console.error("Ошибка загрузки историй", e);
  }
}

function renderStories() {
  const list = document.getElementById("storiesList");
  if (!list) return;
  list.innerHTML = "";
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
      <div class="storyava">${s.avatarUrl ? `<img src="${s.avatarUrl}">` : '<span>👤</span>'}</div>
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

  try {
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
  } catch (e) {
    alert("Ошибка сети");
  }
}

function openStoryViewer(owner) {
  const userStories = stories.filter(s => s.owner === owner);
  if (userStories.length === 0) return;
  let currentIndex = 0;
  const modal = document.createElement("div");
  modal.id = "storyViewerModal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="story-viewer-card">
      ${userStories.map((s, i) => `
        <div class="story-page ${i === 0 ? 'active' : ''}" data-index="${i}">
          ${s.mediaType === "image" ? `<img src="${s.mediaUrl}" class="story-media">` : ''}
          ${s.mediaType === "video" ? `<video src="${s.mediaUrl}" class="story-media" controls autoplay></video>` : ''}
          ${s.text ? `<div class="story-text">${escapeHtml(s.text)}</div>` : ''}
        </div>
      `).join('')}
      <button class="story-prev" onclick="window.prevStory()">‹</button>
      <button class="story-next" onclick="window.nextStory()">›</button>
      <button class="story-close" onclick="window.closeStoryViewer()">✕</button>
    </div>
  `;
  document.body.appendChild(modal);
  window.prevStory = () => {
    if (currentIndex > 0) {
      document.querySelector(`.story-page[data-index="${currentIndex}"]`).classList.remove("active");
      currentIndex--;
      document.querySelector(`.story-page[data-index="${currentIndex}"]`).classList.add("active");
    }
  };
  window.nextStory = () => {
    if (currentIndex < userStories.length - 1) {
      document.querySelector(`.story-page[data-index="${currentIndex}"]`).classList.remove("active");
      currentIndex++;
      document.querySelector(`.story-page[data-index="${currentIndex}"]`).classList.add("active");
    } else {
      closeStoryViewer();
    }
  };
  window.closeStoryViewer = () => {
    document.getElementById("storyViewerModal").remove();
    delete window.prevStory;
    delete window.nextStory;
    delete window.closeStoryViewer;
  };
}

async function startCall() {
  if (currentChat === "global") {
    alert("Нельзя позвонить в общий чат");
    return;
  }
  currentCallUser = currentChat;
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
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
  } catch (err) {
    alert("Ошибка доступа к микрофону");
  }
}

async function incomingCall(from, offer) {
  currentCallUser = from;
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  try {
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
  } catch (err) {
    alert("Ошибка при ответе на звонок");
  }
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
    document.getElementById("muteBtn").innerText = audioTrack.enabled ? "🔇 Выключить микрофон" : "🎤 Включить микрофон";
  }
}

async function openCurrentProfile() {
  if (currentChat === "global") return;
  try {
    const res = await fetch(API + "/users/" + currentChat, {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    if (!data.ok) return;
    showProfileModal(data.user);
  } catch (e) {
    console.error("Ошибка загрузки профиля", e);
  }
}

function showProfileModal(user) {
  document.getElementById("profileName").innerText = user.displayName || user.username;
  document.getElementById("profileUser").innerText = "@" + user.username;
  document.getElementById("profileBio").innerText = user.bio || "";
  document.getElementById("profileBirth").innerText = user.birthDate ? `ДР: ${user.birthDate}` : "";
  const avatar = document.getElementById("profileAvatar");
  avatar.innerHTML = user.avatarUrl ? `<img src="${user.avatarUrl}">` : '<span>👤</span>';
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
    const form = new FormData();
    form.append("file", avatarFile);
    form.append("receiver", "global");
    try {
      const uploadRes = await fetch(API + "/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: form
      });
      const uploadData = await uploadRes.json();
      if (uploadData.ok) {
        avatarUrl = uploadData.message.mediaUrl;
      }
    } catch (e) {
      alert("Ошибка загрузки аватара");
    }
  }

  try {
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
      loadChats();
    } else {
      alert("Ошибка сохранения");
    }
  } catch (e) {
    alert("Ошибка сети");
  }
}

function confirmDeleteAccount() {
  if (confirm("Вы уверены, что хотите удалить свой аккаунт? Это действие необратимо, все ваши данные будут потеряны.")) {
    deleteAccount();
  }
}

async function deleteAccount() {
  try {
    const res = await fetch(API + "/me", {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    if (data.ok) {
      alert("Аккаунт удалён. Вы будете перенаправлены на страницу входа.");
      localStorage.removeItem("token");
      location.href = "/index.html";
    } else {
      alert("Ошибка при удалении: " + (data.error || "неизвестная ошибка"));
    }
  } catch (e) {
    alert("Ошибка сети");
  }
}

async function checkBirthdays() {
  try {
    const res = await fetch(API + "/birthdays/today", {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    if (data.list.length > 0) {
      const names = data.list.map(u => u.displayName || u.username).join(", ");
      document.getElementById("birthdayBanner").innerText = `🎉 Сегодня день рождения: ${names}`;
      document.getElementById("birthdayBanner").classList.remove("hidden");
    }
  } catch (e) {
    console.error("Ошибка загрузки дней рождения", e);
  }
}

function logout() {
  localStorage.removeItem("token");
  location.href = "/index.html";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function onEnter(e) {
  if (e.key === "Enter") {
    sendText();
    sendTyping();
  } else {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      sendTyping();
    }, 500);
  }
}
