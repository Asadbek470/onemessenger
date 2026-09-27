// ================== AUTH ==================
const token = localStorage.getItem("token");
if (!token) location.href = "index.html";

let me = null;
let currentChat = "global"; // 'global' | 'support' | username | 'group:<id>' | me.username (Избранное)
let currentGroupMeta = null;
let ws = null;

let typingTimer = null;
let isTypingNow = false;

let mediaRecorder = null;
let chunks = [];
let holding = false;

let pc = null;
let localStream = null;
let remoteStream = null;
let callPeer = null;
let isMuted = false;

let incomingOffer = null;
let incomingFrom = null;

const rtcCfg = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const onlineSet = new Set();
const lastSeenMap = new Map();       // username -> timestamp (живые обновления)
const userInfoCache = new Map();     // username -> карточка (аватар, цвет имени, статус...)

let myGroups = [];
let lastSentText = "";               // чтобы подставить текст в заявку, если аккаунт официальный
let activeTagFilter = null;          // фильтр по #тегу в Избранном
let pendingTagFilter = null;

const OM_ICON = "/icon-192.png";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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

// ================== ПЕРСОНАЛИЗАЦИЯ: аватар, цвет имени, статус ==================
const LETTER_COLORS = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae", "#f5b041"];

function safeColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(String(c || "")) ? c : "";
}
function colorFromName(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LETTER_COLORS[h % LETTER_COLORS.length];
}
function isSelfChat(c) {
  return !!me && c === me.username;
}
function isPrivateChat(c) {
  return c !== "global" && c !== "support" && !isGroupChat(c) && !isSelfChat(c);
}

// Аватар: фото → если нет, цветной кружок с первой буквой.
// У «Поддержки» — фирменный значок OM.
function avatarHtml(info) {
  info = info || {};
  if (info.username === "support") return `<img src="${OM_ICON}" alt="OM">`;
  if (info.avatarUrl) return `<img src="${esc(info.avatarUrl)}" alt="">`;
  const letter = esc(String(info.displayName || info.username || "?")[0].toUpperCase());
  const bg = safeColor(info.nameColor) || colorFromName(info.username);
  return `<span class="letterava" style="background:${bg}">${letter}</span>`;
}

// Имя: цвет имени + эмодзи-статус + галочка + 🎂 в день рождения
function nameHtml(info, opts = {}) {
  info = info || {};
  const color = safeColor(info.nameColor);
  const name = esc(info.displayName || info.username || "");
  const status = info.emojiStatus ? `<span class="emojistatus" title="Статус">${esc(info.emojiStatus)}</span>` : "";
  const bday = info.birthdayToday ? `<span class="bdaymark" title="Сегодня день рождения">🎂</span>` : "";
  return `<span class="uname"${color ? ` style="color:${color}"` : ""}>${name}</span>${status}${verifiedBadge(info.verified)}${opts.noBday ? "" : bday}`;
}

function mergeUserInfo(username, info) {
  if (!username || !info) return;
  userInfoCache.set(username, { ...(userInfoCache.get(username) || {}), ...info, username });
}

function fmtSize(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}

function lastSeenText(info) {
  const u = info && info.username;
  if (u && onlineSet.has(u)) return "в сети";
  const ts = (u && lastSeenMap.get(u)) || (info && info.lastSeen);
  if (!ts) return info && info.lastSeenHidden ? "был(а) недавно" : "не в сети";

  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return "был(а) только что";
  if (diff < 60 * 60 * 1000) return `был(а) ${Math.floor(diff / 60000)} мин. назад`;

  const d = new Date(ts);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `был(а) сегодня в ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `был(а) вчера в ${time}`;
  return `был(а) ${d.toLocaleDateString("ru-RU")} в ${time}`;
}

// ================== PASSCODE LOCK (device-local) ==================
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

// ================== I18N (ru / en / uz) ==================
const LANG = {
  ru: {
    "nav.chats": "Чаты", "nav.profile": "Профиль", "nav.settings": "Настройки",
    "chats.searchPlaceholder": "Поиск @username...",
    "chats.group": "Группа", "chats.channel": "Канал", "chats.discover": "Популярное", "chats.invite": "Пригласить",
    "chats.globalChat": "Общий чат", "chats.globalChatSub": "общение со всеми",
    "chats.support": "Поддержка", "chats.supportSub": "One Messenger Support",
    "profile.title": "Профиль", "profile.editProfile": "Редактировать профиль", "profile.myStories": "Мои истории",
    "settings.title": "Настройки", "settings.profileBlock": "Профиль",
    "settings.displayName": "Display name", "settings.bio": "Bio", "settings.birthDate": "Дата рождения",
    "settings.avatar": "Аватар", "settings.fromGallery": "Из галереи", "settings.saveProfile": "Сохранить профиль",
    "settings.appearance": "Оформление", "settings.language": "Язык",
    "settings.privacy": "Приватность", "settings.friends": "Друзья",
    "settings.passcode": "Код-пароль устройства", "settings.twoFA": "Двухэтапная аутентификация",
    "settings.verification": "Официальная верификация", "settings.sessions": "Мои сессии", "settings.account": "Аккаунт",
    "settings.logout": "Выйти из аккаунта", "settings.addFriendPlaceholder": "@username", "settings.add": "Добавить",
    "settings.personalize": "Цвет имени и профиля", "settings.emojiStatus": "Эмодзи-статус",
    "group.newGroup": "Новая группа", "group.newChannel": "Новый канал", "group.name": "Название",
    "group.desc": "Описание (не обязательно)", "group.members": "Друзья/родные для добавления (через запятую, @username)",
    "group.discoverableLabel": "Показывать в публичном поиске (популярное)", "group.create": "Создать",
    "group.leave": "Покинуть группу", "group.deleteGroup": "Удалить группу", "group.deleteChannel": "Удалить канал", "group.addMemberPlaceholder": "@username",
    "list.newList": "Новый список", "list.title": "Название списка", "list.items": "Пункты",
    "list.addItem": "Добавить пункт", "list.send": "Отправить список",
    "story.newStory": "Новая сторис", "story.file": "Файл (не обязательно)", "story.text": "Текст (не обязательно)",
    "story.publish": "Опубликовать",
    "call.audioCall": "Аудиозвонок", "call.connecting": "Соединение...",
    "discover.title": "Популярные группы и каналы", "discover.searchPlaceholder": "Поиск по названию...", "discover.join": "Вступить",
    "common.messagePlaceholder": "Сообщение...", "gift.codeLabel": "Секретный код (не нужен по пятницам)"
  },
  en: {
    "nav.chats": "Chats", "nav.profile": "Profile", "nav.settings": "Settings",
    "chats.searchPlaceholder": "Search @username...",
    "chats.group": "Group", "chats.channel": "Channel", "chats.discover": "Discover", "chats.invite": "Invite",
    "chats.globalChat": "Global chat", "chats.globalChatSub": "chat with everyone",
    "chats.support": "Support", "chats.supportSub": "One Messenger Support",
    "profile.title": "Profile", "profile.editProfile": "Edit profile", "profile.myStories": "My stories",
    "settings.title": "Settings", "settings.profileBlock": "Profile",
    "settings.displayName": "Display name", "settings.bio": "Bio", "settings.birthDate": "Birth date",
    "settings.avatar": "Avatar", "settings.fromGallery": "From gallery", "settings.saveProfile": "Save profile",
    "settings.appearance": "Appearance", "settings.language": "Language",
    "settings.privacy": "Privacy", "settings.friends": "Friends",
    "settings.passcode": "Device passcode", "settings.twoFA": "Two-factor authentication",
    "settings.verification": "Official verification", "settings.sessions": "My sessions", "settings.account": "Account",
    "settings.logout": "Log out", "settings.addFriendPlaceholder": "@username", "settings.add": "Add",
    "settings.personalize": "Name and profile color", "settings.emojiStatus": "Emoji status",
    "group.newGroup": "New group", "group.newChannel": "New channel", "group.name": "Name",
    "group.desc": "Description (optional)", "group.members": "Friends/family to add (comma-separated, @username)",
    "group.discoverableLabel": "Show in public search (Discover)", "group.create": "Create",
    "group.leave": "Leave group", "group.deleteGroup": "Delete group", "group.deleteChannel": "Delete channel", "group.addMemberPlaceholder": "@username",
    "list.newList": "New list", "list.title": "List title", "list.items": "Items",
    "list.addItem": "Add item", "list.send": "Send list",
    "story.newStory": "New story", "story.file": "File (optional)", "story.text": "Text (optional)",
    "story.publish": "Publish",
    "call.audioCall": "Audio call", "call.connecting": "Connecting...",
    "discover.title": "Popular groups and channels", "discover.searchPlaceholder": "Search by name...", "discover.join": "Join",
    "common.messagePlaceholder": "Message...", "gift.codeLabel": "Secret code (not needed on Fridays)"
  },
  uz: {
    "nav.chats": "Suhbatlar", "nav.profile": "Profil", "nav.settings": "Sozlamalar",
    "chats.searchPlaceholder": "@username qidirish...",
    "chats.group": "Guruh", "chats.channel": "Kanal", "chats.discover": "Ommabop", "chats.invite": "Taklif qilish",
    "chats.globalChat": "Umumiy chat", "chats.globalChatSub": "hamma bilan muloqot",
    "chats.support": "Yordam", "chats.supportSub": "One Messenger Support",
    "profile.title": "Profil", "profile.editProfile": "Profilni tahrirlash", "profile.myStories": "Mening hikoyalarim",
    "settings.title": "Sozlamalar", "settings.profileBlock": "Profil",
    "settings.displayName": "Ko'rsatiladigan ism", "settings.bio": "O'zim haqimda", "settings.birthDate": "Tug'ilgan sana",
    "settings.avatar": "Avatar", "settings.fromGallery": "Galereyadan", "settings.saveProfile": "Profilni saqlash",
    "settings.appearance": "Ko'rinish", "settings.language": "Til",
    "settings.privacy": "Maxfiylik", "settings.friends": "Do'stlar",
    "settings.passcode": "Qurilma kodi", "settings.twoFA": "Ikki bosqichli autentifikatsiya",
    "settings.verification": "Rasmiy tasdiqlash", "settings.sessions": "Mening seanslarim", "settings.account": "Hisob",
    "settings.logout": "Hisobdan chiqish", "settings.addFriendPlaceholder": "@username", "settings.add": "Qo'shish",
    "settings.personalize": "Ism va profil rangi", "settings.emojiStatus": "Emoji-status",
    "group.newGroup": "Yangi guruh", "group.newChannel": "Yangi kanal", "group.name": "Nomi",
    "group.desc": "Tavsif (ixtiyoriy)", "group.members": "Qo'shiladigan do'stlar/oila a'zolari (vergul bilan, @username)",
    "group.discoverableLabel": "Ommaviy qidiruvda ko'rsatish (Ommabop)", "group.create": "Yaratish",
    "group.leave": "Guruhni tark etish", "group.deleteGroup": "Guruhni o'chirish", "group.deleteChannel": "Kanalni o'chirish", "group.addMemberPlaceholder": "@username",
    "list.newList": "Yangi ro'yxat", "list.title": "Ro'yxat nomi", "list.items": "Bandlar",
    "list.addItem": "Band qo'shish", "list.send": "Ro'yxatni yuborish",
    "story.newStory": "Yangi hikoya", "story.file": "Fayl (ixtiyoriy)", "story.text": "Matn (ixtiyoriy)",
    "story.publish": "Chop etish",
    "call.audioCall": "Ovozli qo'ng'iroq", "call.connecting": "Ulanmoqda...",
    "discover.title": "Ommabop guruh va kanallar", "discover.searchPlaceholder": "Nomi bo'yicha qidirish...", "discover.join": "Qo'shilish",
    "common.messagePlaceholder": "Xabar...", "gift.codeLabel": "Maxfiy kod (juma kunlari kerak emas)"
  }
};

let currentLang = localStorage.getItem("lang") || "ru";

function t(key) {
  return (LANG[currentLang] && LANG[currentLang][key]) || LANG.ru[key] || key;
}

function applyLanguage(lang) {
  if (!LANG[lang]) lang = "ru";
  currentLang = lang;
  localStorage.setItem("lang", lang);
  document.documentElement.lang = lang;

  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}

async function setLanguage(lang) {
  applyLanguage(lang);
  if (me) {
    await saveSettingsPatch({ language: lang });
    renderLanguageSection();
  }
}

function renderLanguageSection() {
  const box = document.getElementById("languageSection");
  if (!box) return;
  const langs = [["ru", "Русский"], ["en", "English"], ["uz", "O'zbekcha"]];
  box.innerHTML = `
    <div class="swatchrow">
      ${langs.map(([code, label]) => `
        <button class="btn ${currentLang === code ? "primary" : "ghost"} small" onclick="setLanguage('${code}')">${label}</button>
      `).join("")}
    </div>
  `;
}

async function initApp() {
  await loadMe();
  if (!me) return;

  applyTheme(me.settings || {});
  applyLanguage((me.settings && me.settings.language) || currentLang);
  connectWS();

  await refreshChats();
  await loadStories();
  await showBirthdays();

  document.getElementById("callBtn").style.display = "none";

  setupRealPushNotifications();

  switchTab("chats");

  // обновляем «был(а) N мин. назад» в шапке раз в минуту
  setInterval(() => { if (isPrivateChat(currentChat)) updateHeader(); }, 60 * 1000);
}

function myCard() {
  const s = (me && me.settings) || {};
  return {
    username: me.username,
    displayName: me.displayName || me.username,
    avatarUrl: me.avatarUrl || "",
    verified: !!me.verified,
    nameColor: s.nameColor || "",
    emojiStatus: s.emojiStatus || "",
    birthdayToday: isMyBirthdayToday()
  };
}

function isMyBirthdayToday() {
  if (!me || !me.birthDate) return false;
  const d = new Date();
  return me.birthDate.slice(5, 10) === `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ================== REAL PUSH NOTIFICATIONS ==================
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function setupRealPushNotifications() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    const reg = await navigator.serviceWorker.register("/sw.js");

    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
    }
    if (Notification.permission !== "granted") return;

    const keyRes = await fetch("/api/push/public-key", { headers: authHeaders() });
    const keyData = await keyRes.json();
    if (!keyData.ok || !keyData.publicKey) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
      });
    }

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub })
    });
  } catch {
    // push — не обязательная функция
  }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function loadMe() {
  for (;;) {
    try {
      const r = await fetch("/api/me", { headers: authHeaders() });
      if (r.status === 401) return logout();

      const d = await r.json();
      if (!d.ok) {
        showBootError("Не удалось загрузить профиль, пробую ещё раз...");
        await sleep(3000);
        continue;
      }

      hideBootError();
      me = d.profile;
      mergeUserInfo(me.username, myCard());
      return;
    } catch {
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
  } else if (currentChat === "support") {
    title.innerHTML = `Поддержка${verifiedBadge(true)}`;
    sub.textContent = "One Messenger Support";
  } else if (isSelfChat(currentChat)) {
    title.innerHTML = `<i class="fa-solid fa-bookmark"></i> Избранное`;
    sub.textContent = "сохранённые сообщения и #теги";
  } else if (isGroupChat(currentChat)) {
    const g = currentGroupMeta;
    title.innerHTML = (g ? esc(g.name) : "Группа") + (g && g.isChannel ? ` <i class="fa-solid fa-bullhorn" title="Канал"></i>` : "");
    sub.textContent = g ? (g.isChannel ? "канал" : `${g.memberCount || ""} участников`.trim()) : "";
  } else {
    const info = userInfoCache.get(currentChat) || { username: currentChat, displayName: currentChat };
    title.innerHTML = nameHtml(info);
    sub.textContent = lastSeenText(info);
  }

  document.getElementById("callBtn").style.display = isPrivateChat(currentChat) ? "inline-flex" : "none";
}

// ================== WS ==================
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    wsReconnectAttempts = 0;
    clearTimeout(wsReconnectTimer);
  };

  ws.onclose = () => {
    scheduleWsReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };

  ws.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "presence") {
      onlineSet.clear();
      (data.online || []).forEach(u => onlineSet.add(u));
      updateHeader();
      renderOnlineDots();
      return;
    }

    if (data.type === "lastSeen") {
      lastSeenMap.set(data.username, data.at);
      if (currentChat === data.username) updateHeader();
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

    if (data.type === "post-error") {
      if (data.gated) openContactRequest(data.to, lastSentText);
      else if (data.message) alert(data.message);
      return;
    }

    if (data.type === "wallpaperChanged") {
      if (currentChat === data.chat) applyChatWallpaper(data.value);
      toast(data.value ? `🖼 @${data.by} поставил(а) новые обои в ваш чат` : `@${data.by} сбросил(а) обои чата`);
      return;
    }

    if (data.type === "birthday") {
      toast(`🎂 Сегодня день рождения у ${data.displayName || "@" + data.username}!`);
      showBirthdays();
      return;
    }

    if (data.type === "call-error") { if (data.message) alert(data.message); return; }

    if (data.type === "call-offer") return onIncomingOffer(data);
    if (data.type === "call-answer") return onCallAnswer(data);
    if (data.type === "ice") return onIce(data);
    if (data.type === "call-end") return onCallEnd();
    if (data.type === "call-reject") return onCallReject(data);

    if (data.type === "message") {
      const msg = data.message;
      if (msg.senderInfo) mergeUserInfo(msg.sender, msg.senderInfo);
      if (shouldRender(msg)) {
        renderMessage(msg);
        if (isSelfChat(currentChat)) { renderFavTags(); applyTagFilter(); }
      }

      if (!shouldRender(msg) || document.hidden) maybeNotify(msg);

      await refreshChats();
      return;
    }
  };
}

function scheduleWsReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectAttempts++;
  const delay = Math.min(15000, 1000 * Math.pow(1.6, wsReconnectAttempts));
  wsReconnectTimer = setTimeout(() => connectWS(), delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!ws || ws.readyState > 1)) {
    wsReconnectAttempts = 0;
    clearTimeout(wsReconnectTimer);
    connectWS();
  }
});

function msgPreview(msg) {
  if (msg.mediaType === "list") return "📋 Список";
  if (msg.mediaType === "file") return "📎 " + (msg.fileName || "Файл");
  if (msg.mediaType === "image") return "🖼 Фото";
  if (msg.mediaType === "video") return "🎬 Видео";
  if (msg.mediaType === "audio") return "🎤 Голосовое";
  return msg.text || "";
}

function maybeNotify(msg) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (msg.sender === me.username) return;

    const info = msg.senderInfo || userInfoCache.get(msg.sender) || {};
    const title = msg.chatType === "global" ? "Общий чат"
      : msg.chatType === "group" ? "Группа"
      : msg.chatType === "support" ? "One Messenger"
      : (info.displayName || "@" + msg.sender);
    new Notification(title, { body: msgPreview(msg), icon: info.avatarUrl || OM_ICON });
  } catch {}
}

function typing(on) {
  if (!ws || ws.readyState !== 1) return;
  if (currentChat === "global" || isSelfChat(currentChat)) return;

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
async function getUserInfo(username, force = false) {
  if (!force && userInfoCache.has(username) && userInfoCache.get(username).fetched) return userInfoCache.get(username);
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(username)}`, { headers: authHeaders() });
    const d = await r.json();
    const info = d.ok ? { ...d.user, fetched: true } : { username, displayName: username, avatarUrl: "" };
    mergeUserInfo(username, info);
    return userInfoCache.get(username);
  } catch {
    return userInfoCache.get(username) || { username, displayName: username, avatarUrl: "" };
  }
}

async function openChat(chat) {
  currentChat = chat === "global" ? "global" : (isGroupChat(chat) ? chat : String(chat).replace(/^@+/, "").toLowerCase());
  currentGroupMeta = null;
  activeTagFilter = pendingTagFilter;
  pendingTagFilter = null;

  document.querySelectorAll(".chatitem").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.chatitem[data-chat="${currentChat}"]`);
  if (btn) btn.classList.add("active");

  document.getElementById("typingLine").classList.add("hidden");
  document.getElementById("gateNotice").classList.add("hidden");
  closeEmojiPanel();

  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("screenChat").classList.remove("hidden");
  document.getElementById("bottomNav").classList.add("hidden");

  updateHeader();

  if (isGroupChat(currentChat)) {
    const groupId = currentChat.slice(6);
    const r = await fetch(`/api/groups/${groupId}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.ok) currentGroupMeta = { ...d.group, memberCount: d.members.length, myRole: d.myRole };
  } else if (isPrivateChat(currentChat)) {
    const info = await getUserInfo(currentChat, true);
    if (info.dmGated && !info.canMessage) showGateNotice(currentChat);
  }

  updateHeader();
  loadChatWallpaper();
  await loadMessages();
}

function backToChats() {
  document.getElementById("screenChat").classList.add("hidden");
  document.getElementById("bottomNav").classList.remove("hidden");
  closeEmojiPanel();
  switchTab("chats");
}

async function loadMessages() {
  const box = document.getElementById("messages");
  box.innerHTML = "";

  const r = await fetch(`/api/messages?chat=${encodeURIComponent(currentChat)}`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return;

  if (d.users) Object.entries(d.users).forEach(([u, info]) => mergeUserInfo(u, info));
  d.messages.forEach(renderMessage);

  const tagBar = document.getElementById("favTagBar");
  if (isSelfChat(currentChat)) {
    renderFavTags();
    applyTagFilter();
    if (d.messages.length === 0) {
      box.innerHTML = `<div class="emptyhint"><i class="fa-regular fa-bookmark"></i><div>Сохраняй сюда сообщения звёздочкой ☆ в любом чате или пиши заметки себе. Добавляй #теги, чтобы потом быстро находить.</div></div>`;
    }
  } else {
    tagBar.classList.add("hidden");
  }
  scrollBottom();
}

function scrollBottom() {
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
}

// Сообщение только из 1–3 эмодзи показывается крупно и с анимацией
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*\s*){1,3}$/u;
const HASHTAG_RE = /(^|\s)#([\p{L}\p{N}_]{1,40})/gu;

function extractTags(text) {
  const out = [];
  String(text || "").replace(HASHTAG_RE, (m, sp, tag) => { out.push(tag.toLowerCase()); return m; });
  return out;
}

function formatText(text) {
  return esc(text).replace(HASHTAG_RE, (m, sp, tag) =>
    `${sp}<span class="hashtag" onclick="openTag('${tag.toLowerCase()}')">#${tag}</span>`
  );
}

function fileIcon(name) {
  const ext = (String(name || "").split(".").pop() || "").toLowerCase();
  if (["doc", "docx", "rtf", "odt"].includes(ext)) return ["fa-file-word", "word"];
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return ["fa-file-excel", "excel"];
  if (["ppt", "pptx", "odp"].includes(ext)) return ["fa-file-powerpoint", "ppt"];
  if (ext === "pdf") return ["fa-file-pdf", "pdf"];
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return ["fa-file-zipper", "zip"];
  if (["txt", "md", "json", "log"].includes(ext)) return ["fa-file-lines", "txt"];
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return ["fa-file-audio", "audio"];
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return ["fa-file-video", "video"];
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "svg", "bmp"].includes(ext)) return ["fa-file-image", "image"];
  if (["apk", "exe", "dmg", "msi"].includes(ext)) return ["fa-box-archive", "app"];
  return ["fa-file", "other"];
}

function renderFileBody(m) {
  const name = m.fileName || "файл";
  const ext = (name.includes(".") ? name.split(".").pop() : "").toUpperCase();
  const [icon, cls] = fileIcon(name);
  return `
    <a class="filecard" href="${esc(m.mediaUrl)}" download="${esc(name)}" target="_blank" rel="noopener">
      <div class="fileicon ft-${cls}"><i class="fa-solid ${icon}"></i></div>
      <div class="fileinfo">
        <div class="filename">${esc(name)}</div>
        <div class="filesize">${fmtSize(m.fileSize)}${ext ? " · " + esc(ext) : ""}</div>
      </div>
      <i class="fa-solid fa-download filedl"></i>
    </a>
    ${m.text ? `<div class="mtext">${formatText(m.text)}</div>` : ""}
  `;
}

function renderMessage(m) {
  const box = document.getElementById("messages");
  const empty = box.querySelector(".emptyhint");
  if (empty) empty.remove();

  const mine = m.sender === me.username;
  const info = m.sender === "support"
    ? { username: "support", displayName: "Поддержка One Messenger", verified: true, nameColor: "#2a9df4" }
    : (userInfoCache.get(m.sender) || m.senderInfo || { username: m.sender, displayName: m.sender });

  let body = "";
  if (m.mediaType === "image") {
    body = `<img class="mimg" src="${esc(m.mediaUrl)}" alt="" loading="lazy">`;
    if (m.text) body += `<div class="mtext">${formatText(m.text)}</div>`;
  } else if (m.mediaType === "video") {
    body = `<video class="mvid" controls playsinline src="${esc(m.mediaUrl)}"></video>`;
  } else if (m.mediaType === "audio") {
    body = renderVoiceBody(m);
  } else if (m.mediaType === "list") {
    body = renderListBody(m);
  } else if (m.mediaType === "file") {
    body = renderFileBody(m);
  } else {
    const text = m.text || "";
    body = EMOJI_ONLY_RE.test(text.trim())
      ? `<div class="mtext bigemoji">${esc(text.trim())}</div>`
      : `<div class="mtext">${formatText(text)}</div>`;
  }

  const actions = [];
  if (!isSelfChat(currentChat) && m.chatType !== "support") {
    actions.push(`<button class="mact" onclick="saveToFavorites(${m.id})" title="В избранное"><i class="fa-regular fa-star"></i></button>`);
  }
  if (mine) actions.push(`<button class="mact trash" onclick="deleteMsg(${m.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>`);

  const showName = (m.chatType === "global" || m.chatType === "group") && !mine;
  const senderLine = showName
    ? `<div class="who clickable" onclick="openProfile('${esc(m.sender)}', false)">${nameHtml(info)}</div>`
    : "";
  const fwd = m.forwardedFrom
    ? `<div class="fwd clickable" onclick="openProfile('${esc(m.forwardedFrom)}', false)"><i class="fa-solid fa-share"></i> от @${esc(m.forwardedFrom)}</div>`
    : "";
  const time = new Date(m.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const avatarClick = m.sender === "support" ? "" : `onclick="openProfile('${esc(m.sender)}', false)"`;
  const avatar = mine ? "" : `<div class="mava" ${avatarClick}>${avatarHtml(info)}</div>`;

  const row = document.createElement("div");
  row.className = "mrow " + (mine ? "mine" : "other");
  row.dataset.mid = String(m.id);
  row.dataset.tags = extractTags(m.text).join(" ");

  row.innerHTML = `
    ${avatar}
    <div class="bubble pop">
      <div class="btop">
        ${senderLine}
        <div class="mactions">${actions.join("")}</div>
      </div>
      ${fwd}
      ${body}
      <div class="mtime">${time}</div>
    </div>
  `;

  box.appendChild(row);
  if (m.mediaType === "audio") setupVoicePlayer(m.id);
  scrollBottom();
}

async function saveToFavorites(id) {
  const r = await fetch(`/api/messages/${id}/save`, { method: "POST", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Не получилось сохранить");
  toast("⭐ Сохранено в Избранное");
}

// ---------------- #теги в Избранном ----------------
function renderFavTags() {
  const bar = document.getElementById("favTagBar");
  const tags = new Map();
  document.querySelectorAll("#messages .mrow").forEach(r => {
    (r.dataset.tags || "").split(" ").filter(Boolean).forEach(tg => tags.set(tg, (tags.get(tg) || 0) + 1));
  });
  if (tags.size === 0) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }

  bar.classList.remove("hidden");
  bar.innerHTML =
    `<button class="tagchip ${!activeTagFilter ? "active" : ""}" onclick="filterByTag(null)">Все</button>` +
    [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([tg, n]) =>
      `<button class="tagchip ${activeTagFilter === tg ? "active" : ""}" onclick="filterByTag('${tg}')">#${esc(tg)} <span>${n}</span></button>`
    ).join("");
}

function filterByTag(tag) {
  activeTagFilter = tag;
  renderFavTags();
  applyTagFilter();
}

function applyTagFilter() {
  document.querySelectorAll("#messages .mrow").forEach(r => {
    const tags = (r.dataset.tags || "").split(" ");
    r.classList.toggle("hidden", !!activeTagFilter && !tags.includes(activeTagFilter));
  });
}

function openTag(tag) {
  if (isSelfChat(currentChat)) return filterByTag(tag);
  pendingTagFilter = tag;
  openChat(me.username);
}

// ---------------- custom voice message player ----------------
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

  lastSentText = text;
  ws.send(JSON.stringify({ type: "text-message", receiver: currentChat, text }));
  input.value = "";
  typing(false);
  closeEmojiPanel();
}

// Фото, видео, GIF и ЛЮБЫЕ файлы (Word, Excel, PowerPoint, PDF, ZIP...)
async function sendMedia(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    input.value = "";
    return alert("Файл больше 20 МБ — выбери файл поменьше");
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("receiver", currentChat);
  fd.append("text", "");

  toast(`Отправка: ${file.name}...`);
  const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  input.value = "";
  if (!d.ok) {
    if (d.gated) return openContactRequest(currentChat, "");
    alert(d.error || "Ошибка отправки файла");
  }
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

// ---------------- attach menu ----------------
function toggleAttachMenu() {
  document.getElementById("attachMenu").classList.toggle("hidden");
}
function attachPickMedia() {
  document.getElementById("attachMenu").classList.add("hidden");
  document.getElementById("fileInput").click();
}
function attachPickGif() {
  document.getElementById("attachMenu").classList.add("hidden");
  document.getElementById("gifInput").click();
}
function attachPickDoc() {
  document.getElementById("attachMenu").classList.add("hidden");
  document.getElementById("docInput").click();
}
function attachPickList() {
  document.getElementById("attachMenu").classList.add("hidden");
  openListComposer();
}

// ---------------- EMOJI PANEL ----------------
const EMOJI_CATEGORIES = [
  ["😀", "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😔 😢 😭 😤 😠 😡 🤯 😳 🥺 😱 🤔 🤫 🤭 🙄 😴 🤗 🤝 👍 👎 👏 🙌 🙏 💪 ✌️ 🤞 👌 👋 🫶"],
  ["❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 🔥 ✨ ⭐ 🌟 💫 💯 ✅"],
  ["🐶", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐬 🐳 🌸 🌹 🌻 🌷 🍀 🌈"],
  ["🍔", "🍏 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🍍 🥝 🍅 🥑 🍔 🍟 🍕 🌭 🌮 🍣 🍩 🍪 🎂 🍰 🍫 🍿 ☕ 🍵 🥤 🧃"],
  ["⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🥊 🎮 🎯 🎲 🎸 🎹 🎤 🎧 🎬 📚 💻 📱 🏆 🥇 🎉 🎊 🎁 🎈"],
  ["✈️", "🚗 🚕 🚌 🏎️ 🚓 🚑 ✈️ 🚀 🛸 🚁 ⛵ 🏠 🏫 🏥 🕌 🗽 🗼 🏖️ 🏔️ 🌍 🌙 ☀️ ⛄ ⚡ 🌊"]
];
let emojiCategory = 0;

function toggleEmojiPanel() {
  const panel = document.getElementById("emojiPanel");
  if (panel.classList.contains("hidden")) {
    renderEmojiPanel();
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}
function closeEmojiPanel() {
  const panel = document.getElementById("emojiPanel");
  if (panel) panel.classList.add("hidden");
}
function renderEmojiPanel() {
  const panel = document.getElementById("emojiPanel");
  const tabs = EMOJI_CATEGORIES.map(([icon], i) =>
    `<button class="emojitab ${i === emojiCategory ? "active" : ""}" onclick="pickEmojiCategory(${i})">${icon}</button>`
  ).join("");
  const grid = EMOJI_CATEGORIES[emojiCategory][1].split(" ").map(e =>
    `<button class="emojibtn" onclick="insertEmoji('${e}')">${e}</button>`
  ).join("");
  panel.innerHTML = `<div class="emojitabs">${tabs}</div><div class="emojigrid">${grid}</div>`;
}
function pickEmojiCategory(i) {
  emojiCategory = i;
  renderEmojiPanel();
}
function insertEmoji(e) {
  const input = document.getElementById("textInput");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + e + input.value.slice(end);
  const pos = start + e.length;
  input.focus();
  try { input.setSelectionRange(pos, pos); } catch {}
}

// ================== CHAT LIST ==================
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

  // «Избранное» всегда сверху
  const savedBtn = document.createElement("button");
  savedBtn.className = "chatitem";
  savedBtn.dataset.chat = me.username;
  savedBtn.onclick = () => openChat(me.username);
  savedBtn.innerHTML = `
    <div class="avatar circle saved"><i class="fa-solid fa-bookmark"></i></div>
    <div class="meta">
      <div class="name">Избранное</div>
      <div class="preview">сохранённые сообщения и #теги</div>
    </div>
  `;
  wrap.appendChild(savedBtn);

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
    chatsData.chats.filter(c => c.username !== me.username).forEach(c => {
      mergeUserInfo(c.username, c);
      const btn = document.createElement("button");
      btn.className = "chatitem";
      btn.dataset.chat = c.username;
      btn.onclick = () => openChat(c.username);

      const isOn = onlineSet.has(c.username);

      btn.innerHTML = `
        <div class="avatar">${avatarHtml(c)}</div>
        <div class="meta">
          <div class="name">${nameHtml(c)}</div>
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
  document.getElementById("groupModalTitle").textContent = isChannel ? t("group.newChannel") : t("group.newGroup");
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
  const discoverable = document.getElementById("groupDiscoverable").checked;
  const members = document.getElementById("groupMembers").value
    .split(",").map(s => s.trim().replace(/^@+/, "")).filter(Boolean);

  if (!name) return alert("Введи название");

  const r = await fetch("/api/groups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, isChannel, discoverable, members })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка создания");

  closeCreateGroupModal();
  await refreshChats();
  openChat(`group:${d.id}`);
}

function openDiscoverModal() {
  document.getElementById("discoverModal").classList.remove("hidden");
  document.getElementById("discoverSearchInput").value = "";
  searchDiscover("");
}
function closeDiscoverModal() {
  document.getElementById("discoverModal").classList.add("hidden");
}
let discoverDebounce = null;
function searchDiscover(q) {
  clearTimeout(discoverDebounce);
  discoverDebounce = setTimeout(async () => {
    const r = await fetch(`/api/groups/discover?q=${encodeURIComponent(q.trim())}`, { headers: authHeaders() });
    const d = await r.json();
    const box = document.getElementById("discoverList");
    if (!d.ok || d.groups.length === 0) { box.innerHTML = `<div class="hint">Ничего не нашлось</div>`; return; }

    box.innerHTML = d.groups.map(g => `
      <div class="chatitem">
        <div class="avatar circle ${g.isChannel ? "" : "group"}">${g.avatarUrl ? `<img src="${esc(g.avatarUrl)}" alt="">` : `<i class="fa-solid ${g.isChannel ? "fa-bullhorn" : "fa-users"}"></i>`}</div>
        <div class="meta">
          <div class="name">${esc(g.name)}</div>
          <div class="preview">${g.isChannel ? "канал" : "группа"} · ${g.memberCount} участников</div>
        </div>
        <button class="btn ghost small" onclick="joinDiscoveredGroup(${g.id})">Вступить</button>
      </div>
    `).join("");
  }, 250);
}
async function joinDiscoveredGroup(groupId) {
  const r = await fetch(`/api/groups/${groupId}/join`, { method: "POST", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка вступления");

  closeDiscoverModal();
  await refreshChats();
  openChat(`group:${groupId}`);
  toast("Вступил(а) в группу ✅");
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
  const isOwner = d.myRole === "owner";
  const list = document.getElementById("groupMembersList");
  list.innerHTML = d.members.map(mem => {
    mergeUserInfo(mem.username, mem);
    const isSelf = mem.username === me.username;
    const outranked = d.myRole === "admin" && mem.role === "admin";
    const roleButtons = (isOwner && mem.role !== "owner" && !isSelf)
      ? (mem.role === "admin"
          ? `<button class="iconbtn" onclick="event.stopPropagation(); setGroupMemberRole('${groupId}','${esc(mem.username)}','member')" title="Снять админку"><i class="fa-solid fa-user-minus"></i></button>`
          : `<button class="iconbtn" onclick="event.stopPropagation(); setGroupMemberRole('${groupId}','${esc(mem.username)}','admin')" title="Сделать админом (модератор)"><i class="fa-solid fa-user-shield"></i></button>`)
      : "";
    const removeButton = (canManage && mem.role !== "owner" && !isSelf && !outranked)
      ? `<button class="iconbtn" onclick="event.stopPropagation(); removeGroupMember('${groupId}','${esc(mem.username)}')" title="Убрать"><i class="fa-solid fa-user-xmark"></i></button>`
      : "";
    const banButton = (canManage && mem.role !== "owner" && !isSelf && !outranked)
      ? `<button class="iconbtn danger" onclick="event.stopPropagation(); banGroupMember('${groupId}','${esc(mem.username)}')" title="Забанить"><i class="fa-solid fa-ban"></i></button>`
      : "";
    return `
      <div class="memberrow clickable" onclick="openProfile('${esc(mem.username)}', ${isSelf})">
        <div class="avatar">${avatarHtml(mem)}</div>
        <div class="meta">
          <div class="name">${nameHtml(mem)}</div>
          <div class="preview">@${esc(mem.username)} · ${mem.role === "owner" ? "владелец" : mem.role === "admin" ? "админ (модератор)" : "участник"}</div>
        </div>
        ${roleButtons}${removeButton}${banButton}
      </div>
    `;
  }).join("");

  const bansBox = document.getElementById("groupBansList");
  if (canManage && d.bans && d.bans.length > 0) {
    bansBox.classList.remove("hidden");
    bansBox.innerHTML = `<h4 class="sectiontitle small">Забаненные</h4>` + d.bans.map(b => `
      <div class="memberrow">
        <div class="avatar">${avatarHtml(b)}</div>
        <div class="meta">
          <div class="name">${esc(b.displayName || b.username)}</div>
          <div class="preview">@${esc(b.username)} · забанил @${esc(b.bannedBy)}</div>
        </div>
        <button class="iconbtn" onclick="unbanGroupMember('${groupId}','${esc(b.username)}')" title="Разбанить"><i class="fa-solid fa-rotate-left"></i></button>
      </div>
    `).join("");
  } else {
    bansBox.classList.add("hidden");
    bansBox.innerHTML = "";
  }

  document.getElementById("groupAddMemberRow").classList.toggle("hidden", !canManage);
  document.getElementById("groupLeaveBtn").onclick = () => removeGroupMember(groupId, me.username, true);

  const deleteBtn = document.getElementById("groupDeleteBtn");
  deleteBtn.classList.toggle("hidden", !isOwner);
  deleteBtn.textContent = d.group.isChannel ? t("group.deleteChannel") : t("group.deleteGroup");
  deleteBtn.onclick = () => deleteGroup(groupId, d.group.isChannel);
}
async function setGroupMemberRole(groupId, username, role) {
  const r = await fetch(`/api/groups/${groupId}/members/${encodeURIComponent(username)}/role`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ role })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast(role === "admin" ? `@${username} теперь админ` : `@${username} больше не админ`);
  openGroupInfo();
}
async function banGroupMember(groupId, username) {
  if (!confirm(`Забанить @${username} в этой группе/канале?`)) return;
  const r = await fetch(`/api/groups/${groupId}/members/${encodeURIComponent(username)}/ban`, {
    method: "POST", headers: authHeaders()
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast(`@${username} забанен(а)`);
  openGroupInfo();
}
async function unbanGroupMember(groupId, username) {
  const r = await fetch(`/api/groups/${groupId}/members/${encodeURIComponent(username)}/unban`, {
    method: "POST", headers: authHeaders()
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast(`@${username} разбанен(а)`);
  openGroupInfo();
}
async function deleteGroup(groupId, isChannel) {
  const label = isChannel ? "канал" : "группу";
  if (!confirm(`Удалить этот ${label} навсегда? Это действие необратимо для всех участников.`)) return;

  const r = await fetch(`/api/groups/${groupId}`, { method: "DELETE", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка удаления");

  closeGroupInfo();
  await refreshChats();
  backToChats();
  toast(`${label[0].toUpperCase()}${label.slice(1)} удалён(а)`);
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

  if (d.users.length === 0) {
    results.innerHTML = `
      <div class="chatitem invite-hint">
        <div class="meta">
          <div class="name">@${esc(q)} не найден(а)</div>
          <div class="preview">Его/её ещё нет в One Messenger</div>
        </div>
        <button class="btn ghost small" onclick="inviteToMessenger()"><i class="fa-solid fa-user-plus"></i> Пригласить</button>
      </div>
    `;
    return;
  }

  d.users.forEach(u => {
    mergeUserInfo(u.username, u);
    const btn = document.createElement("button");
    btn.className = "chatitem";
    btn.onclick = () => { results.innerHTML = ""; document.getElementById("searchInput").value = ""; openChat(u.username); };
    btn.innerHTML = `
      <div class="avatar">${avatarHtml(u)}</div>
      <div class="meta">
        <div class="name">${nameHtml(u)}</div>
        <div class="preview">@${esc(u.username)}</div>
      </div>
      <span class="dot ${onlineSet.has(u.username) ? "online" : "offline"}"></span>
    `;
    results.appendChild(btn);
  });
}

// ================== INVITE ==================
function buildInviteText() {
  const inviteUrl = `${location.origin}/index.html`;
  return `Я в One Messenger — общаемся без сим-карты и без слежки за данными. Голосовые, звонки, группы, каналы, сторис — всё в одном месте. Присоединяйся: ${inviteUrl}`;
}

async function inviteToMessenger() {
  const text = buildInviteText();

  if (navigator.share) {
    try {
      await navigator.share({ title: "One Messenger", text });
    } catch {}
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    toast("Текст приглашения скопирован — вставь его в любой чат");
  } catch {
    prompt("Скопируй текст приглашения и отправь тому, кого хочешь позвать:", text);
  }
}

// ================== OFFICIAL ACCOUNTS: заявка через администрацию ==================
let contactRequestTarget = null;

function showGateNotice(username) {
  const box = document.getElementById("gateNotice");
  box.innerHTML = `
    <i class="fa-solid fa-circle-check verified-badge"></i>
    <div class="gatetext">Этот аккаунт официально подтверждён. Написать можно через администрацию.</div>
    <button class="btn primary small" onclick="openContactRequest('${esc(username)}', '')">Отправить заявку</button>
  `;
  box.classList.remove("hidden");
}

function openContactRequest(username, prefill) {
  contactRequestTarget = username;
  document.getElementById("contactRequestModal").classList.remove("hidden");
  document.getElementById("contactRequestTitle").innerHTML = `Написать @${esc(username)}${verifiedBadge(true)}`;
  document.getElementById("contactRequestText").value = prefill || "";
  document.getElementById("contactRequestText").focus();
}
function closeContactRequest() {
  document.getElementById("contactRequestModal").classList.add("hidden");
  contactRequestTarget = null;
}
async function submitContactRequest() {
  const text = document.getElementById("contactRequestText").value.trim();
  if (!text) return alert("Напиши, по какому вопросу обращаешься");

  const r = await fetch("/api/contact-requests", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ to: contactRequestTarget, text })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  closeContactRequest();
  toast("Заявка отправлена. Ответ придёт в чат «Поддержка»");
}

// ================== PROFILE VIEW ==================
async function openCurrentProfile() {
  if (currentChat === "global" || isSelfChat(currentChat)) {
    switchTab("profile");
  } else if (currentChat === "support") {
    return;
  } else if (isGroupChat(currentChat)) {
    openGroupInfo();
  } else {
    await openProfile(currentChat, false);
  }
}

async function openProfile(username, isMe) {
  if (username === "support") return;
  if (isMe || (me && username === me.username)) { switchTab("profile"); return; }

  const modal = document.getElementById("profileModal");
  modal.classList.remove("hidden");
  document.getElementById("giftPickerBox").classList.add("hidden");

  const title = document.getElementById("profileTitle");
  const avatar = document.getElementById("profileAvatar");
  const name = document.getElementById("profileName");
  const user = document.getElementById("profileUser");
  const bio = document.getElementById("profileBio");
  const birth = document.getElementById("profileBirth");
  const seen = document.getElementById("profileLastSeen");
  const banner = document.getElementById("profileBanner");
  const official = document.getElementById("profileOfficial");
  const actions = document.getElementById("profileActions");

  title.textContent = "Профиль";
  actions.innerHTML = "";

  const p = await getUserInfo(username, true);
  if (!p.fetched) { alert("Не найден"); return closeProfile(); }

  const profCol = safeColor(p.profileColor);
  banner.style.background = profCol ? `linear-gradient(135deg, ${profCol}, ${profCol}55)` : "";
  banner.classList.toggle("hidden", !profCol);

  avatar.innerHTML = avatarHtml(p);
  name.innerHTML = nameHtml(p, { noBday: true });
  user.textContent = "@" + p.username;
  bio.textContent = p.bio ? p.bio : "";
  birth.textContent = p.birthdayToday ? "🎂 Сегодня день рождения!" : "";
  seen.textContent = lastSeenText(p);

  official.classList.toggle("hidden", !p.verified);
  official.innerHTML = p.verified ? `<i class="fa-solid fa-circle-check"></i> Этот аккаунт официально подтверждён` : "";

  if (p.dmGated && !p.canMessage) {
    const reqBtn = document.createElement("button");
    reqBtn.className = "btn primary full";
    reqBtn.innerHTML = `<i class="fa-solid fa-envelope"></i> Написать через администрацию`;
    reqBtn.onclick = () => { closeProfile(); openContactRequest(p.username, ""); };
    actions.appendChild(reqBtn);
  } else {
    const openChatBtn = document.createElement("button");
    openChatBtn.className = "btn primary full";
    openChatBtn.textContent = "Открыть чат";
    openChatBtn.onclick = () => { closeProfile(); openChat(p.username); };
    actions.appendChild(openChatBtn);
  }

  if (p.birthdayToday) {
    const bdBtn = document.createElement("button");
    bdBtn.className = "btn ghost full";
    bdBtn.innerHTML = `🎉 Поздравить`;
    bdBtn.onclick = () => { closeProfile(); congratulate(p.username); };
    actions.appendChild(bdBtn);
  }

  const giftBtn = document.createElement("button");
  giftBtn.className = "btn ghost full";
  giftBtn.innerHTML = `🎁 Подарить`;
  giftBtn.onclick = () => openGiftPicker(p.username);
  actions.appendChild(giftBtn);

  const friendBtn = document.createElement("button");
  friendBtn.className = "btn ghost full";
  friendBtn.innerHTML = `<i class="fa-solid fa-user-plus"></i> Добавить в друзья`;
  friendBtn.onclick = async () => {
    const r2 = await fetch("/api/friends", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ username: p.username })
    });
    const d2 = await r2.json();
    if (!d2.ok) return alert(d2.error || "Ошибка");
    toast(`@${p.username} добавлен(а) в друзья ✅`);
  };
  actions.appendChild(friendBtn);

  await loadGifts(username, "profileGiftsRow");
  await loadUserStoriesIntoProfile(username);
}

async function loadUserStoriesIntoProfile(username) {
  const box = document.getElementById("profileStoriesGrid");
  const r = await fetch(`/api/stories/user/${encodeURIComponent(username)}`, { headers: authHeaders() });
  const d = await r.json();

  if (!d.ok || d.stories.length === 0) { box.innerHTML = ""; return; }

  box.innerHTML = `<h3 class="sectiontitle">Истории</h3><div class="stories-grid">` +
    d.stories.map(s => {
      const thumb = s.mediaType === "image" ? `<img src="${esc(s.mediaUrl)}" alt="">`
        : s.mediaType === "video" ? `<video src="${esc(s.mediaUrl)}" muted></video>`
        : `<div class="storythumb-text">${esc((s.text || "").slice(0, 40))}</div>`;
      return `<button class="storythumb" onclick='viewStory(${JSON.stringify(s).replace(/'/g, "&#39;")})'>${thumb}</button>`;
    }).join("") +
    `</div>`;
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
  renderPersonalizeSection();
  renderEmojiStatusSection();
  renderLanguageSection();
  renderPrivacySection();
  renderFriendsSection();
  renderVerificationSection();
  renderSessionsSection();
  renderDeleteAccountSection();
}

// ---------------- SESSIONS ----------------
async function renderSessionsSection() {
  const box = document.getElementById("sessionsSection");
  box.innerHTML = `<div class="hint">Загрузка...</div>`;

  const r = await fetch("/api/me/sessions", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok || d.sessions.length === 0) { box.innerHTML = `<div class="hint">Пока нет истории входов</div>`; return; }

  box.innerHTML = d.sessions.map(s => `
    <div class="memberrow">
      <div class="meta">
        <div class="name">${new Date(s.createdAt).toLocaleString("ru-RU")} ${s.current ? '<span class="hint">(это устройство)</span>' : ""}</div>
        <div class="preview">${esc(s.ip || "IP неизвестен")} · ${esc(shortenUA(s.userAgent))}</div>
      </div>
      ${!s.current ? `<button class="iconbtn danger" onclick="endSession(${s.id})" title="Завершить сессию"><i class="fa-solid fa-power-off"></i></button>` : ""}
    </div>
  `).join("");
}
async function endSession(id) {
  if (!confirm("Завершить эту сессию? Устройство будет разлогинено.")) return;
  const r = await fetch(`/api/me/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast("Сессия завершена");
  renderSessionsSection();
}
function shortenUA(ua) {
  if (!ua) return "устройство неизвестно";
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Macintosh")) return "Mac";
  if (ua.includes("Windows")) return "Windows";
  return ua.slice(0, 40);
}

// ---------------- PRIVACY ----------------
function renderPrivacySection() {
  const box = document.getElementById("privacySection");
  const s = me.settings || {};
  const storyPrivacy = s.storyPrivacy || "everyone";
  const bioPrivacy = s.bioPrivacy || "everyone";
  const lastSeenPrivacy = s.lastSeenPrivacy || "everyone";

  const opt = (value, current) => `<option value="${value}" ${value === current ? "selected" : ""}>${
    value === "everyone" ? "Все" : value === "friends" ? "Только друзья" : "Никто"
  }</option>`;

  box.innerHTML = `
    <label>Кому показывать мои истории</label>
    <select id="privStoryPrivacy" onchange="savePrivacy()">
      ${opt("everyone", storyPrivacy)}${opt("friends", storyPrivacy)}${opt("nobody", storyPrivacy)}
    </select>

    <label>Кому показывать мою анкету (bio)</label>
    <select id="privBioPrivacy" onchange="savePrivacy()">
      ${opt("everyone", bioPrivacy)}${opt("friends", bioPrivacy)}${opt("nobody", bioPrivacy)}
    </select>

    <label>Кому показывать, когда я был(а) в сети</label>
    <select id="privLastSeenPrivacy" onchange="savePrivacy()">
      ${opt("everyone", lastSeenPrivacy)}${opt("friends", lastSeenPrivacy)}${opt("nobody", lastSeenPrivacy)}
    </select>
    <div class="hint">«Друзья» — это список ниже. @username всегда виден всем, иначе поиск и переписка перестанут работать.</div>
  `;
}

async function savePrivacy() {
  const storyPrivacy = document.getElementById("privStoryPrivacy").value;
  const bioPrivacy = document.getElementById("privBioPrivacy").value;
  const lastSeenPrivacy = document.getElementById("privLastSeenPrivacy").value;
  const d = await saveSettingsPatch({ storyPrivacy, bioPrivacy, lastSeenPrivacy });
  if (d && d.ok) toast("Приватность обновлена ✅");
}

// ---------------- FRIENDS ----------------
async function renderFriendsSection() {
  const box = document.getElementById("friendsSection");
  box.innerHTML = `
    <div class="row">
      <input id="addFriendInput" placeholder="@username">
      <button class="btn ghost" onclick="addFriend()">Добавить</button>
    </div>
    <div id="friendsList" class="hint">Загрузка...</div>
  `;

  const r = await fetch("/api/friends", { headers: authHeaders() });
  const d = await r.json();
  const list = document.getElementById("friendsList");
  if (!d.ok || d.friends.length === 0) { list.innerHTML = `<div class="hint">Список друзей пуст</div>`; return; }

  list.innerHTML = d.friends.map(f => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml(f)}</div>
      <div class="meta">
        <div class="name">${nameHtml(f)}</div>
        <div class="preview">@${esc(f.username)}</div>
      </div>
      <button class="iconbtn" onclick="removeFriend('${esc(f.username)}')" title="Убрать"><i class="fa-solid fa-user-minus"></i></button>
    </div>
  `).join("");
}

async function addFriend() {
  const username = document.getElementById("addFriendInput").value.trim().replace(/^@+/, "");
  if (!username) return;
  const r = await fetch("/api/friends", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  renderFriendsSection();
}

async function removeFriend(username) {
  await fetch(`/api/friends/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() });
  renderFriendsSection();
}

// ---------------- DELETE ACCOUNT ----------------
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
  mergeUserInfo(me.username, myCard());
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
  el._hideTimer = setTimeout(() => el.classList.remove("show"), 2600);
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
  mergeUserInfo(me.username, myCard());
  toast("Профиль обновлён ✅");
  updateHeader();
  refreshChats();
  showBirthdays();
}

// ---------------- THEME / WALLPAPER ----------------
const WALLPAPER_PRESETS = [
  { id: "default", label: "Стандартные" },
  { id: "night", label: "Ночь" },
  { id: "ocean", label: "Океан" },
  { id: "sunset", label: "Закат" },
  { id: "forest", label: "Лес" },
  { id: "aurora", label: "Северное сияние" },
  { id: "rose", label: "Роза" },
  { id: "graphite", label: "Графит" },
  { id: "lavender", label: "Лаванда" },
  { id: "mint", label: "Мята" }
];
const ACCENT_PRESETS = ["#2a9df4", "#29d17d", "#ff8a3d", "#ff4d9d", "#a06bff", "#f5c542", "#00c2c7", "#ff5c5c", "#7c8cff", "#8bd450"];
const NAME_COLORS = [
  "#ff5c5c", "#ff7a45", "#ffa940", "#ffc53d", "#fadb14", "#d3f261", "#95de64", "#52c41a",
  "#36cfc9", "#13c2c2", "#69c0ff", "#2a9df4", "#597ef7", "#85a5ff", "#9254de", "#b37feb",
  "#d3adf7", "#f759ab", "#ff85c0", "#eb2f96", "#ff9c6e", "#e6c79c", "#bfbfbf", "#ffffff"
];
const PROFILE_COLORS = [
  "#2a9df4", "#1f3b5a", "#7b3fe4", "#c2185b", "#e65100", "#2e7d32",
  "#00897b", "#455a64", "#6d4c41", "#ad1457", "#283593", "#f9a825"
];
const STATUS_EMOJIS = ["😎", "🔥", "⭐", "💎", "👑", "🎮", "🎧", "📚", "💼", "✈️", "🏖️", "❤️", "🌙", "☕", "🚀", "⚽", "🎨", "💻", "🤔", "😴", "🎉", "🍀", "🌸", "🐱", "🦁", "⚡", "🌈", "🎵"];

function applyTheme(settings) {
  const wp = settings.wallpaper || "default";
  if (wp.startsWith("/media/")) {
    document.body.dataset.wallpaper = "custom";
    document.documentElement.style.setProperty("--custom-wp", `url("${wp}")`);
  } else {
    document.body.dataset.wallpaper = wp;
    document.documentElement.style.removeProperty("--custom-wp");
  }
  if (settings.accent) document.documentElement.style.setProperty("--blue", settings.accent);
}

function renderWallpaperSection() {
  const box = document.getElementById("wallpaperSection");
  const current = (me.settings || {}).wallpaper || "default";
  const currentAccent = (me.settings || {}).accent || "#2a9df4";
  const isCustom = current.startsWith("/media/");

  box.innerHTML = `
    <label>Обои для всех чатов</label>
    <div class="swatchrow">
      ${WALLPAPER_PRESETS.map(w => `
        <button class="wallswatch wp-${w.id} ${current === w.id ? "active" : ""}" onclick="pickWallpaper('${w.id}')" title="${w.label}"></button>
      `).join("")}
      <button class="wallswatch wallupload ${isCustom ? "active" : ""}" onclick="document.getElementById('globalWpInput').click()" title="Своё фото"
        ${isCustom ? `style="background-image:url('${esc(current)}')"` : ""}><i class="fa-solid fa-image"></i></button>
    </div>
    <input id="globalWpInput" type="file" hidden accept="image/*" onchange="uploadGlobalWallpaper(this)">
    <div class="hint">Для отдельного чата обои меняются кнопкой <i class="fa-solid fa-palette"></i> в шапке переписки.</div>
    <label>Акцентный цвет</label>
    <div class="swatchrow">
      ${ACCENT_PRESETS.map(c => `
        <button class="colorswatch ${currentAccent === c ? "active" : ""}" style="background:${c}" onclick="pickAccent('${c}')"></button>
      `).join("")}
    </div>
  `;
}

async function uploadImage(file) {
  if (file.size > MAX_UPLOAD_BYTES) { alert("Картинка больше 20 МБ"); return null; }
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/upload-image", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  if (!d.ok) { alert(d.error || "Ошибка загрузки"); return null; }
  return d.url;
}

async function uploadGlobalWallpaper(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const url = await uploadImage(file);
  if (!url) return;
  await saveSettingsPatch({ wallpaper: url });
  renderWallpaperSection();
  toast("Обои установлены ✅");
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
    mergeUserInfo(me.username, myCard());
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

// ---------------- ЦВЕТ ИМЕНИ И ПРОФИЛЯ ----------------
function renderPersonalizeSection() {
  const box = document.getElementById("personalizeSection");
  if (!box) return;
  const s = me.settings || {};
  const nameColor = safeColor(s.nameColor);
  const profileColor = safeColor(s.profileColor);

  box.innerHTML = `
    <div class="namepreview" style="${profileColor ? `background:linear-gradient(135deg, ${profileColor}, ${profileColor}55)` : ""}">
      <div class="avatar">${avatarHtml(myCard())}</div>
      <div>${nameHtml(myCard(), { noBday: true })}<div class="hint">так тебя видят другие</div></div>
    </div>

    <label>Цвет имени</label>
    <div class="swatchrow">
      <button class="colorswatch reset ${!nameColor ? "active" : ""}" onclick="pickNameColor('')" title="Обычный"><i class="fa-solid fa-ban"></i></button>
      ${NAME_COLORS.map(c => `<button class="colorswatch ${nameColor.toLowerCase() === c ? "active" : ""}" style="background:${c}" onclick="pickNameColor('${c}')"></button>`).join("")}
      <label class="colorswatch custompick" title="Любой цвет"><i class="fa-solid fa-eye-dropper"></i><input type="color" value="${nameColor || "#2a9df4"}" onchange="pickNameColor(this.value)"></label>
    </div>

    <label>Цвет профиля</label>
    <div class="swatchrow">
      <button class="colorswatch reset ${!profileColor ? "active" : ""}" onclick="pickProfileColor('')" title="Без цвета"><i class="fa-solid fa-ban"></i></button>
      ${PROFILE_COLORS.map(c => `<button class="colorswatch ${profileColor.toLowerCase() === c ? "active" : ""}" style="background:linear-gradient(135deg, ${c}, ${c}66)" onclick="pickProfileColor('${c}')"></button>`).join("")}
      <label class="colorswatch custompick" title="Любой цвет"><i class="fa-solid fa-eye-dropper"></i><input type="color" value="${profileColor || "#2a9df4"}" onchange="pickProfileColor(this.value)"></label>
    </div>
  `;
}

async function pickNameColor(c) {
  await saveSettingsPatch({ nameColor: c });
  renderPersonalizeSection();
  refreshChats();
}
async function pickProfileColor(c) {
  await saveSettingsPatch({ profileColor: c });
  renderPersonalizeSection();
}

// ---------------- ЭМОДЗИ-СТАТУС (значок рядом с именем) ----------------
function renderEmojiStatusSection() {
  const box = document.getElementById("emojiStatusSection");
  if (!box) return;
  const cur = (me.settings || {}).emojiStatus || "";
  box.innerHTML = `
    <div class="hint">Значок рядом с твоим именем — его видят все в чатах и в профиле.</div>
    <div class="statusgrid">
      <button class="statusbtn ${!cur ? "active" : ""}" onclick="pickEmojiStatus('')" title="Без статуса"><i class="fa-solid fa-ban"></i></button>
      ${STATUS_EMOJIS.map(e => `<button class="statusbtn ${cur === e ? "active" : ""}" onclick="pickEmojiStatus('${e}')">${e}</button>`).join("")}
    </div>
    <div class="row">
      <input id="customStatusInput" maxlength="8" placeholder="Свой эмодзи" value="${esc(cur)}">
      <button class="btn ghost" onclick="pickEmojiStatus(document.getElementById('customStatusInput').value)">Поставить</button>
    </div>
  `;
}
async function pickEmojiStatus(e) {
  const d = await saveSettingsPatch({ emojiStatus: e });
  if (d && d.ok) toast(e ? `Статус ${e} установлен` : "Статус убран");
  renderEmojiStatusSection();
  renderPersonalizeSection();
  refreshChats();
}

// ---------------- ОБОИ ДЛЯ КОНКРЕТНОГО ЧАТА ----------------
async function loadChatWallpaper() {
  applyChatWallpaper("");
  try {
    const r = await fetch(`/api/wallpaper?chat=${encodeURIComponent(currentChat)}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.ok) applyChatWallpaper(d.value);
  } catch {}
}

function applyChatWallpaper(v) {
  const box = document.getElementById("messages");
  box.removeAttribute("data-wp");
  box.style.background = "";
  if (!v) return;
  if (v.startsWith("/media/")) {
    box.style.background = `linear-gradient(rgba(0,0,0,.28), rgba(0,0,0,.28)), url("${v}") center / cover no-repeat`;
  } else {
    box.dataset.wp = v;
  }
}

function openChatWallpaperModal() {
  const modal = document.getElementById("wallpaperModal");
  modal.classList.remove("hidden");
  const canShare = isPrivateChat(currentChat);
  document.getElementById("wpForBothRow").classList.toggle("hidden", !canShare);
  document.getElementById("wpForBoth").checked = false;
  document.getElementById("wpPresetRow").innerHTML = WALLPAPER_PRESETS.map(w => `
    <button class="wallswatch wp-${w.id}" onclick="saveChatWallpaper('${w.id}')" title="${w.label}"></button>
  `).join("");
}
function closeChatWallpaperModal() {
  document.getElementById("wallpaperModal").classList.add("hidden");
}
async function saveChatWallpaper(value) {
  const forBoth = document.getElementById("wpForBoth").checked;
  const r = await fetch("/api/wallpaper", {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ chat: currentChat, value, forBoth })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  applyChatWallpaper(value);
  closeChatWallpaperModal();
  toast(value ? (forBoth ? "Обои установлены для вас обоих ✅" : "Обои чата установлены ✅") : "Обои чата сброшены");
}
async function uploadChatWallpaper(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const url = await uploadImage(file);
  if (url) saveChatWallpaper(url);
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

// ---------------- VERIFICATION + НАСТРОЙКИ ОФИЦИАЛЬНОГО АККАУНТА ----------------
function renderVerificationSection() {
  const box = document.getElementById("verificationSection");
  if (me.verified) {
    const on = (me.settings || {}).dmGate !== false;
    box.innerHTML = `
      <div class="hint">Аккаунт официально подтверждён ✅</div>
      <label class="checkrow"><input type="checkbox" id="dmGateToggle" ${on ? "checked" : ""} onchange="toggleDmGate(this.checked)">
        Незнакомые пишут мне только через администрацию</label>
      <div class="hint">Когда включено, человек увидит «Этот аккаунт официально подтверждён» и сможет отправить заявку — администрация передаст её тебе. Люди из исключений и те, кому ты уже писал(а) сам(а), пишут напрямую.</div>
      <label>Исключения — могут писать напрямую</label>
      <div class="row">
        <input id="dmExceptionInput" placeholder="@username">
        <button class="btn ghost" onclick="addDmException()">Добавить</button>
      </div>
      <div id="dmExceptionsList" class="hint">Загрузка...</div>
    `;
    loadDmExceptions();
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

async function toggleDmGate(on) {
  const d = await saveSettingsPatch({ dmGate: !!on });
  if (d && d.ok) toast(on ? "Теперь незнакомые пишут через администрацию" : "Теперь писать тебе могут все");
}

async function loadDmExceptions() {
  const box = document.getElementById("dmExceptionsList");
  if (!box) return;
  const r = await fetch("/api/me/dm-exceptions", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok || d.users.length === 0) { box.innerHTML = `<div class="hint">Исключений пока нет</div>`; return; }
  box.innerHTML = d.users.map(u => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml(u)}</div>
      <div class="meta"><div class="name">${nameHtml(u)}</div><div class="preview">@${esc(u.username)}</div></div>
      <button class="iconbtn" onclick="removeDmException('${esc(u.username)}')" title="Убрать"><i class="fa-solid fa-xmark"></i></button>
    </div>
  `).join("");
}
async function addDmException() {
  const username = document.getElementById("dmExceptionInput").value.trim().replace(/^@+/, "");
  if (!username) return;
  const r = await fetch("/api/me/dm-exceptions", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  document.getElementById("dmExceptionInput").value = "";
  loadDmExceptions();
}
async function removeDmException(username) {
  await fetch(`/api/me/dm-exceptions/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() });
  loadDmExceptions();
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
        if (!d.ok) {
          if (d.gated) openContactRequest(currentChat, "");
          else alert(d.error || "Ошибка голосового");
        }
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
  const card = myCard();
  const profCol = safeColor((me.settings || {}).profileColor);
  const banner = document.getElementById("myProfileBanner");
  banner.style.background = profCol ? `linear-gradient(135deg, ${profCol}, ${profCol}55)` : "";
  banner.classList.toggle("hidden", !profCol);

  document.getElementById("myProfileAvatar").innerHTML = avatarHtml(card);
  document.getElementById("myProfileName").innerHTML = nameHtml(card);
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
      <div class="storythumb ${s.active ? "" : "expired"}" onclick='viewStory(${JSON.stringify(s).replace(/'/g, "&#39;")})'>
        ${thumb}
        ${!s.active ? '<span class="storythumb-badge">истекла</span>' : ""}
        <button class="storythumb-del" onclick="event.stopPropagation(); deleteStory(${s.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
  }).join("");
}

async function deleteStory(id) {
  if (!confirm("Удалить эту историю?")) return;
  const r = await fetch(`/api/stories/${id}`, { method: "DELETE", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка удаления");
  toast("История удалена");
  loadMyProfileTab();
  loadStories();
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
      <div class="storyava">${avatarHtml({ username: s.owner, displayName: s.displayName, avatarUrl: s.avatarUrl })}</div>
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

let storyTimer = null;
const STORY_DURATION_MS = 6000;

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
  avatarBox.innerHTML = avatarHtml({ username: s.owner, displayName: s.displayName, avatarUrl: s.avatarUrl });
  document.getElementById("storyViewerName").innerHTML = esc(s.displayName || s.owner) + verifiedBadge(s.verified);
  document.getElementById("storyViewerCaption").textContent = s.text || "";

  const mediaBox = document.getElementById("storyViewerMedia");
  mediaBox.innerHTML = "";
  clearTimeout(storyTimer);

  const bar = document.getElementById("storyProgressBar");
  bar.style.transition = "none";
  bar.style.width = "0%";
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

  const list = (d.list || []).filter(x => x.username !== me.username);
  const mine = isMyBirthdayToday();

  if (!mine && list.length === 0) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }

  banner.classList.remove("hidden");
  banner.innerHTML = `
    ${mine ? `<div class="bdayline">🎉 С днём рождения, ${esc(me.displayName || me.username)}!</div>` : ""}
    ${list.map(x => `
      <div class="bdayrow">
        <div class="avatar">${avatarHtml(x)}</div>
        <div class="meta"><div class="name">🎂 ${esc(x.displayName || x.username)}</div><div class="preview">сегодня день рождения</div></div>
        <button class="btn primary small" onclick="congratulate('${esc(x.username)}')">Поздравить</button>
      </div>
    `).join("")}
  `;

  if (mine) showMyBirthdayCelebration();
}

async function congratulate(username) {
  await openChat(username);
  const input = document.getElementById("textInput");
  input.value = "С днём рождения! 🎉🎂 Счастья, здоровья и всего самого лучшего!";
  input.focus();
}

function showMyBirthdayCelebration() {
  const key = `bdayShown-${new Date().getFullYear()}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, "1");

  document.getElementById("bdayTitle").textContent = `С днём рождения, ${me.displayName || me.username}!`;
  const confetti = document.getElementById("confetti");
  const colors = ["#2a9df4", "#ff4d9d", "#ffc53d", "#29d17d", "#a06bff", "#ff8a3d"];
  confetti.innerHTML = Array.from({ length: 70 }, () => {
    const left = Math.random() * 100;
    const delay = Math.random() * 1.5;
    const dur = 2.5 + Math.random() * 2;
    const c = colors[Math.floor(Math.random() * colors.length)];
    const rot = Math.floor(Math.random() * 360);
    return `<span style="left:${left}%;background:${c};animation-delay:${delay}s;animation-duration:${dur}s;transform:rotate(${rot}deg)"></span>`;
  }).join("");
  document.getElementById("bdayModal").classList.remove("hidden");
}

function closeBdayModal() {
  document.getElementById("bdayModal").classList.add("hidden");
  document.getElementById("confetti").innerHTML = "";
}

// ================== AUDIO CALL (WebRTC) ==================
let callTimerInterval = null;
let callStartedAt = null;
let isSpeakerOn = false;

function renderCallAvatar(el, info) {
  el.innerHTML = avatarHtml(info);
}

async function openIncoming(username) {
  const info = await getUserInfo(username);
  document.getElementById("incomingCallText").textContent = `${info.displayName || "@" + username} звонит тебе`;
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
  if (!isPrivateChat(currentChat)) return alert("Звонок только в личном чате");
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
