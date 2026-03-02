let socket;
let currentUser = localStorage.getItem("user");
let currentChat = "global";
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let avatarFile = null;
let openedProfileUsername = null;

if (!currentUser) {
  window.location.href = "index.html";
}

function headers() {
  return { "x-user": currentUser };
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initChat() {
  connectWS();
  loadMyProfile();
  loadChatList();
  loadMessages("global");
  loadStories();
  checkBirthdays();

  const input = document.getElementById("messageInput");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendText();
  });

  if (window.innerWidth > 768) {
    document.getElementById("sidebar").classList.remove("active-mobile");
  }
}

function connectWS() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}?user=${encodeURIComponent(currentUser)}`);

  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== "message") return;

    if (msg.receiver === "global" && currentChat === "global") renderMessage(msg);

    if (
      msg.receiver !== "global" &&
      ((msg.sender === currentChat && msg.receiver === currentUser) ||
      (msg.sender === currentUser && msg.receiver === currentChat))
    ) {
      renderMessage(msg);
    }

    loadChatList();
  };
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
  const displayName = msg.displayName || msg.sender;

  let content = "";

  if (msg.mediaType === "image") {
    content = `<img class="msg-image" src="${msg.mediaUrl}" alt="image">`;
  } else if (msg.mediaType === "video") {
    content = `<video class="msg-video" controls src="${msg.mediaUrl}"></video>`;
  } else if (msg.mediaType === "audio") {
    content = `
      <div class="voice-wave">
        <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
      </div>
      <audio controls src="${msg.mediaUrl}" class="voice-audio"></audio>
    `;
  } else {
    content = `<div class="msg-text">${escapeHtml(msg.text || "")}</div>`;
  }

  const bubble = document.createElement("div");
  bubble.className = `message-row ${mine ? "mine" : "other"}`;
  bubble.innerHTML = `
    <div class="bubble">
      <div class="bubble-top">
        <span class="sender-name">${escapeHtml(displayName)}</span>
        ${msg.sender !== "global" ? `<button class="mini-profile-btn" onclick="openUserProfile('${msg.sender}')">Профиль</button>` : ""}
      </div>
      ${content}
    </div>
  `;

  container.appendChild(bubble);
  scrollBottom();
}

function scrollBottom() {
  const container = document.getElementById("messagesContainer");
  container.scrollTop = container.scrollHeight;
}

async function searchUsers(val) {
  const results = document.getElementById("searchResults");
  results.innerHTML = "";

  if (!val.startsWith("@")) return;

  const query = val.replace("@", "").trim().toLowerCase();
  if (!query) return;

  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: headers() });
  const users = await res.json();

  results.innerHTML = users
    .filter((u) => u.username !== currentUser)
    .map((u) => `
      <div class="user-item">
        <div class="user-main" onclick="startPrivate('${u.username}')">
          <b>@${u.username}</b>
          <span>${escapeHtml(u.displayName || u.username)} ${u.todayBirthday ? "🎂" : ""}</span>
        </div>
        <button class="user-profile-btn" onclick="openUserProfile('${u.username}')">Профиль</button>
      </div>
    `)
    .join("");
}

async function loadChatList() {
  const block = document.getElementById("privateChatsBlock");
  const res = await fetch("/api/chats", { headers: headers() });
  const chats = await res.json();

  block.innerHTML = chats.map((chat) => `
    <div class="chat-item ${currentChat === chat.username ? "active" : ""}" data-chat="${chat.username}" onclick="switchChat('${chat.username}')">
      <div class="avatar-circle">
        ${chat.avatar ? `<img src="${chat.avatar}" alt="">` : `<span>${(chat.displayName || chat.username).charAt(0).toUpperCase()}</span>`}
      </div>
      <div class="chat-meta">
        <span class="name">${escapeHtml(chat.displayName || chat.username)} ${chat.todayBirthday ? "🎂" : ""}</span>
        <span class="preview">${escapeHtml(chat.preview || "Чат")}</span>
      </div>
    </div>
  `).join("");
}

function startPrivate(username) {
  switchChat(username);
  document.getElementById("searchResults").innerHTML = "";
  document.getElementById("userSearch").value = "@" + username;
}

function switchChat(name) {
  currentChat = name;

  document.querySelectorAll(".chat-item").forEach((el) => el.classList.remove("active"));
  const active = document.querySelector(`.chat-item[data-chat="${name}"]`);
  if (active) active.classList.add("active");

  document.getElementById("chatTitle").textContent = name === "global" ? "Общий чат" : "@" + name;
  document.getElementById("chatStatus").textContent = name === "global" ? "общение со всеми" : "личный чат";

  loadMessages(name);

  if (window.innerWidth <= 768) {
    document.getElementById("sidebar").classList.remove("active-mobile");
  }
}

function sendText() {
  const input = document.getElementById("messageInput");
  const text = input.value.trim();

  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({
    type: "text",
    text,
    sender: currentUser,
    receiver: currentChat
  }));

  input.value = "";
}

async function uploadMedia(input) {
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("receiver", currentChat);
  formData.append("text", "");

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: headers(),
    body: formData
  });

  const data = await res.json();
  if (!data.success) alert(data.error || "Ошибка загрузки");
  input.value = "";
}

async function toggleAudioRec() {
  const voiceBtn = document.getElementById("voiceBtn");

  if (isRecording && mediaRecorder) {
    mediaRecorder.stop();
    isRecording = false;
    voiceBtn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("receiver", currentChat);
      formData.append("text", "");

      const res = await fetch("/api/upload", {
        method: "POST",
        headers: headers(),
        body: formData
      });

      const data = await res.json();
      if (!data.success) alert(data.error || "Ошибка загрузки голосового");

      stream.getTracks().forEach((track) => track.stop());
    };

    mediaRecorder.start();
    isRecording = true;
    voiceBtn.innerHTML = `<i class="fa-solid fa-stop"></i>`;
  } catch {
    alert("Не удалось включить микрофон");
  }
}

async function loadMyProfile() {
  const res = await fetch("/api/me", { headers: headers() });
  const data = await res.json();
  if (!data.success) return;

  const profile = data.profile;
  document.getElementById("editUsername").value = profile.username || "";
  document.getElementById("editName").value = profile.displayName || profile.username;
  document.getElementById("editBio").value = profile.bio || "";
  document.getElementById("editBirthday").value = profile.birthday || "";
  document.getElementById("editProfileVisibility").value = profile.profileVisibility || "all";
  document.getElementById("editStoryVisibility").value = profile.storyVisibility || "all";
  setAvatarBlock("profilePreview", profile);

  if (profile.todayBirthday) {
    const banner = document.getElementById("birthdayBanner");
    banner.textContent = "🎉 С днём рождения! One Messenger поздравляет тебя сегодня!";
    banner.classList.remove("hidden");
  }
}

function openSettings() {
  document.getElementById("settingsModal").style.display = "flex";
}

function closeSettings() {
  document.getElementById("settingsModal").style.display = "none";
}

function previewAvatar(input) {
  avatarFile = input.files[0] || null;
  if (!avatarFile) return;

  const reader = new FileReader();
  reader.onload = () => {
    const el = document.getElementById("profilePreview");
    el.innerHTML = `<img src="${reader.result}" alt="">`;
  };
  reader.readAsDataURL(avatarFile);
}

async function saveProfile() {
  const formData = new FormData();
  formData.append("username", document.getElementById("editUsername").value.trim());
  formData.append("displayName", document.getElementById("editName").value.trim());
  formData.append("bio", document.getElementById("editBio").value.trim());
  formData.append("birthday", document.getElementById("editBirthday").value.trim());
  formData.append("profileVisibility", document.getElementById("editProfileVisibility").value);
  formData.append("storyVisibility", document.getElementById("editStoryVisibility").value);

  const newPin = document.getElementById("editPin").value.trim();
  if (newPin) formData.append("newPin", newPin);

  const currentAvatarImg = document.querySelector("#profilePreview img");
  formData.append("currentAvatar", currentAvatarImg ? currentAvatarImg.getAttribute("src") : "");
  if (avatarFile) formData.append("avatar", avatarFile);

  const oldUser = currentUser;

  const res = await fetch("/api/me", {
    method: "POST",
    headers: headers(),
    body: formData
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Ошибка сохранения профиля");
    return;
  }

  currentUser = data.profile.username;
  localStorage.setItem("user", currentUser);

  if (oldUser !== currentUser && socket) {
    try { socket.close(); } catch {}
    connectWS();
  }

  document.getElementById("editPin").value = "";
  closeSettings();
  loadMyProfile();
  loadChatList();
  loadStories();
  checkBirthdays();
}

async function openUserProfile(username) {
  const res = await fetch(`/api/profile/${encodeURIComponent(username)}`, { headers: headers() });
  const data = await res.json();

  if (!data.success) {
    alert(data.error || "Профиль не найден");
    return;
  }

  openedProfileUsername = username;

  const profile = data.profile;
  document.getElementById("viewProfileUsername").textContent = "@" + profile.username;
  document.getElementById("viewProfileName").textContent = profile.displayName || profile.username;
  document.getElementById("viewProfileBio").textContent = profile.bio || "Скрыто или не указано";
  document.getElementById("viewProfileBirthday").textContent = profile.birthday || "Не указано";
  document.getElementById("todayBirthdayLine").style.display = profile.todayBirthday ? "block" : "none";
  setAvatarBlock("viewProfileAvatar", profile);

  const addBtn = document.getElementById("addContactBtn");
  addBtn.style.display = username === currentUser ? "none" : "block";
  addBtn.textContent = data.isContact ? "Уже в контактах" : "Добавить в контакты";
  addBtn.disabled = !!data.isContact;

  document.getElementById("profileModal").style.display = "flex";
}

function openCurrentProfile() {
  if (currentChat === "global") return;
  openUserProfile(currentChat);
}

function closeProfile() {
  document.getElementById("profileModal").style.display = "none";
}

async function addCurrentProfileToContacts() {
  if (!openedProfileUsername || openedProfileUsername === currentUser) return;

  const res = await fetch("/api/contacts/add", {
    method: "POST",
    headers: {
      ...headers(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username: openedProfileUsername })
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Не удалось добавить в контакты");
    return;
  }

  document.getElementById("addContactBtn").textContent = "Уже в контактах";
  document.getElementById("addContactBtn").disabled = true;
}

async function publishStory() {
  const input = document.getElementById("storyInput");
  const text = document.getElementById("storyText").value.trim();
  const file = input.files[0];

  const formData = new FormData();
  formData.append("text", text);
  if (file) formData.append("story", file);

  const res = await fetch("/api/stories", {
    method: "POST",
    headers: headers(),
    body: formData
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Ошибка публикации сторис");
    return;
  }

  document.getElementById("storyText").value = "";
  input.value = "";
  loadStories();
  alert("Сторис опубликована");
}

async function loadStories() {
  const strip = document.getElementById("storiesStrip");
  const res = await fetch("/api/stories", { headers: headers() });
  const stories = await res.json();

  if (!stories.length) {
    strip.innerHTML = `<div class="stories-empty">Сторис пока нет</div>`;
    return;
  }

  strip.innerHTML = stories.map((story) => `
    <button class="story-chip" onclick="openStory(${story.id}, '${story.owner.replaceAll("'", "\\'")}')">
      <div class="story-avatar">
        ${story.avatar ? `<img src="${story.avatar}" alt="">` : `<span>${(story.displayName || story.owner).charAt(0).toUpperCase()}</span>`}
      </div>
      <span>${escapeHtml(story.displayName || story.owner)}</span>
    </button>
  `).join("");

  window.__stories = stories;
}

function openStory(id, owner) {
  const stories = window.__stories || [];
  const story = stories.find((s) => s.id === id);
  if (!story) return;

  const body = document.getElementById("storyModalBody");
  let content = "";

  if (story.mediaType === "image") {
    content = `<img class="story-media" src="${story.mediaUrl}" alt="">`;
  } else if (story.mediaType === "video") {
    content = `<video class="story-media" controls src="${story.mediaUrl}"></video>`;
  } else {
    content = `<div class="story-text-only">${escapeHtml(story.text || "")}</div>`;
  }

  body.innerHTML = `
    <div class="story-owner">@${escapeHtml(owner)}</div>
    ${content}
    ${story.text && story.mediaType !== "text" ? `<div class="story-caption">${escapeHtml(story.text)}</div>` : ""}
  `;

  document.getElementById("storyModal").style.display = "flex";
}

function closeStoryModal() {
  document.getElementById("storyModal").style.display = "none";
}

async function checkBirthdays() {
  const res = await fetch("/api/birthdays/today", { headers: headers() });
  const users = await res.json();

  const banner = document.getElementById("birthdayBanner");
  if (!users.length) {
    if (!banner.textContent.includes("One Messenger поздравляет")) {
      banner.classList.add("hidden");
    }
    return;
  }

  const names = users.map((u) => u.displayName || u.username).join(", ");
  if (!banner.textContent.includes("One Messenger поздравляет")) {
    banner.textContent = `🎂 Сегодня день рождения у: ${names}`;
    banner.classList.remove("hidden");
  }
}

function setAvatarBlock(id, profile) {
  const el = document.getElementById(id);
  if (!el) return;

  if (profile.avatar) {
    el.innerHTML = `<img src="${profile.avatar}" alt="">`;
  } else {
    const letter = (profile.displayName || profile.username || "U").charAt(0).toUpperCase();
    el.innerHTML = `<span>${letter}</span>`;
  }
}

function toggleSidebarMobile() {
  const sidebar = document.getElementById("sidebar");
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle("active-mobile");
  }
}
