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

const OM_ICON = "/icon-192.png?v=2";
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

// ================== АВАТАРЫ И ИМЕНА ==================
const LETTER_COLORS = ["#ff4d5e", "#ff8a1f", "#8b5cf6", "#16c25b", "#06b6d4", "#2f80ff", "#ec4899", "#f5a500"];

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

// ----- цвета: светлее / темнее, градиенты -----
function shade(hex, amt) {
  const n = parseInt(String(hex).slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => {
    const out = amt < 0 ? v * (1 + amt / 100) : v + (255 - v) * (amt / 100);
    return Math.max(0, Math.min(255, Math.round(out))).toString(16).padStart(2, "0");
  });
  return "#" + ch.join("");
}
function avatarGradient(c) {
  return `linear-gradient(140deg, ${shade(c, 22)} 0%, ${c} 45%, ${shade(c, -28)} 100%)`;
}
// Аватар: фото → если нет, круг с первой буквой (как в Телеграме).
// У «Поддержки» — фирменный значок OM. Размеры заданы прямо в разметке,
// поэтому картинка никогда не растянется на весь экран.
const AVA_IMG_STYLE = "width:100%;height:100%;object-fit:cover;display:block;border-radius:50%";
function avatarHtml(info) {
  info = info || {};
  if (info.username === "support") return `<img src="${OM_ICON}" alt="UM" style="${AVA_IMG_STYLE}">`;
  if (info.avatarUrl) return `<img src="${esc(info.avatarUrl)}" alt="" style="${AVA_IMG_STYLE}">`;
  const letter = esc(String(info.displayName || info.username || "?")[0].toUpperCase());
  const bg = colorFromName(info.username);
  return `<span class="letterava" style="width:100%;height:100%;display:grid;place-items:center;border-radius:50%;color:#fff;font-weight:800;background:${avatarGradient(bg)}">${letter}</span>`;
}

// Имя: цвет имени + эмодзи-статус + галочка + 🎂 в день рождения
function nameHtml(info, opts = {}) {
  info = info || {};
  const name = esc(info.displayName || info.username || "");
  const status = info.emojiStatus ? `<span class="emojistatus" title="Статус">${esc(info.emojiStatus)}</span>` : "";
  const bday = info.birthdayToday ? `<span class="bdaymark" title="Сегодня день рождения">🎂</span>` : "";
  return `<span class="uname">${name}</span>${status}${verifiedBadge(info.verified)}${opts.noBday ? "" : bday}`;
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
    err.textContent = t("passcode.wrong");
    input.value = "";
  }
}

function passcodeKeydown(e) {
  if (e.key === "Enter") unlockAttempt();
}

async function setPasscodeFromSettings() {
  const p1 = document.getElementById("newPasscode").value.trim();
  const p2 = document.getElementById("newPasscodeConfirm").value.trim();
  if (!/^\d{4,8}$/.test(p1)) return alert(t("passcode.badFormat"));
  if (p1 !== p2) return alert(t("passcode.mismatch"));
  localStorage.setItem("passcodeHash", await sha256Hex(p1));
  document.getElementById("newPasscode").value = "";
  document.getElementById("newPasscodeConfirm").value = "";
  renderPasscodeSection();
  toast(t("passcode.setToast"));
}

function removePasscodeFromSettings() {
  if (!confirm(t("passcode.confirmRemove"))) return;
  localStorage.removeItem("passcodeHash");
  renderPasscodeSection();
}

function lockNow() {
  if (!passcodeEnabled()) return alert(t("passcode.setFirst"));
  document.getElementById("passcodeOverlay").classList.remove("hidden");
}

function renderPasscodeSection() {
  const box = document.getElementById("passcodeSection");
  if (!box) return;
  if (passcodeEnabled()) {
    box.innerHTML = `
      <div class="hint">${t("passcode.enabledHint")}</div>
      <div class="row">
        <button class="btn ghost" onclick="lockNow()">${t("passcode.lockNow")}</button>
        <button class="btn danger" onclick="removePasscodeFromSettings()">${t("passcode.removeBtn")}</button>
      </div>
    `;
  } else {
    box.innerHTML = `
      <label>${t("passcode.newCode")}</label>
      <input id="newPasscode" type="password" inputmode="numeric" maxlength="8">
      <label>${t("passcode.repeatCode")}</label>
      <input id="newPasscodeConfirm" type="password" inputmode="numeric" maxlength="8">
      <button class="btn primary full" onclick="setPasscodeFromSettings()">${t("passcode.setBtn")}</button>
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
    "chats.support": "Поддержка", "chats.supportSub": "UzMessenger Support",
    "profile.title": "Профиль", "profile.editProfile": "Редактировать профиль", "profile.myStories": "Мои истории",
    "settings.title": "Настройки", "settings.profileBlock": "Профиль",
    "settings.displayName": "Display name", "settings.bio": "Bio", "settings.birthDate": "Дата рождения",
    "settings.avatar": "Аватар", "settings.fromGallery": "Из галереи", "settings.saveProfile": "Сохранить профиль",
    "settings.appearance": "Оформление", "settings.language": "Язык",
    "settings.privacy": "Приватность", "settings.friends": "Друзья",
    "settings.passcode": "Код-пароль устройства", "settings.twoFA": "Двухэтапная аутентификация",
    "settings.verification": "Официальная верификация", "settings.sessions": "Мои сессии", "settings.account": "Аккаунт",
    "settings.logout": "Выйти из аккаунта", "settings.addFriendPlaceholder": "@username", "settings.add": "Добавить",
    "settings.emojiStatus": "Эмодзи-статус",
    "group.newGroup": "Новая группа", "group.newChannel": "Новый канал", "group.name": "Название",
    "group.desc": "Описание (не обязательно)", "group.members": "Друзья/родные для добавления (через запятую, @username)",
    "group.discoverableLabel": "Показывать в публичном поиске (популярное)", "group.create": "Создать",
    "group.leave": "Покинуть группу", "group.deleteGroup": "Удалить группу", "group.deleteChannel": "Удалить канал", "group.addMemberPlaceholder": "@username",
    "list.newList": "Новый список", "list.title": "Название списка", "list.items": "Пункты",
    "list.addItem": "Добавить пункт", "list.send": "Отправить список",
    "story.newStory": "Новая сторис", "story.file": "Файл (не обязательно)", "story.text": "Текст (не обязательно)",
    "story.publish": "Опубликовать",
    "story.viewersTitle": "Просмотры", "story.noViewers": "Пока никто не посмотрел эту историю",
    "story.reactedToast": "отреагировал(а) на твою историю",
    "call.audioCall": "Аудиозвонок", "call.connecting": "Соединение...",
    "discover.title": "Популярные группы и каналы", "discover.searchPlaceholder": "Поиск по названию...", "discover.join": "Вступить",
    "common.messagePlaceholder": "Сообщение...", "gift.codeLabel": "Секретный код (не нужен по пятницам)",

    "passcode.enter": "Введи код-пароль", "passcode.unlock": "Разблокировать", "passcode.wrong": "Неверный код",
    "common.back": "Назад", "common.close": "Закрыть", "common.send": "Отправить", "common.save": "Сохранить",
    "common.typing": "печатает…", "common.cancel": "Отмена", "common.delete": "Удалить", "common.edit": "Изменить",
    "common.loading": "Загрузка...", "common.error": "Ошибка", "common.notFound": "Не найден",
    "profile.openProfile": "Открыть профиль",
    "wallpaper.chatTitle": "Обои для этого чата", "wallpaper.presets": "Готовые", "wallpaper.ownPhoto": "Своё фото из галереи",
    "wallpaper.forBoth": "Поставить эти обои и собеседнику", "wallpaper.reset": "Сбросить обои чата",
    "attach.title": "Прикрепить", "attach.photoVideo": "Фото/Видео", "attach.location": "Геолокация", "attach.gif": "GIF",
    "attach.doc": "Документ или файл", "attach.list": "Список (покупки, дела)", "attach.emoji": "Эмодзи", "attach.voice": "Голосовое (удерживай)",
    "reply.title": "Ответ",
    "round.title": "Видеосообщение (кружочек)", "round.flip": "Перевернуть камеру", "round.record": "Записать",
    "round.stop": "Стоп", "round.retake": "Ещё раз",
    "gift.pickerHint": "Подарить эмодзи-подарок на профиль:",
    "readInfo.title": "Прочитано", "readInfo.empty": "Пока никто не прочитал",
    "forward.title": "Переслать", "forward.self": "Избранное (себе)", "forward.sent": "Переслано",
    "contact.title": "Сохранить контакт", "contact.username": "Юзернейм", "contact.name": "Имя контакта",
    "contact.namePlaceholder": "Например, Мама", "contact.note": "Заметка (необязательно)",
    "contact.notePlaceholder": "Например, близкий человек", "contact.needName": "Введи имя контакта",
    "contact.saved": "сохранён", "contact.confirmDelete": "Удалить контакт?", "contact.empty": "Пока нет сохранённых контактов. Открой чей-нибудь профиль и нажми «Контакт», чтобы сохранить.",
    "contact.action": "Контакт",
    "legal.title": "Политика использования", "legal.tabTerms": "Условия использования", "legal.tabPrivacy": "Конфиденциальность",
    "legal.accepted": "Принято", "legal.notAccepted": "Ты ещё не принял(а) политику условий", "legal.accept": "Принять",
    "legal.acceptedToast": "Спасибо! Политика принята ✅",
    "reply.toSelf": "себе", "reply.editing": "Редактирование сообщения",
    "msgact.copied": "Скопировано", "msgact.copyFailed": "Не удалось скопировать",
    "forward.failed": "Ошибка пересылки",
    "passcode.enabledHint": "Пароль на переписки включён", "passcode.lockNow": "Заблокировать сейчас",
    "passcode.removeBtn": "Отключить пароль", "passcode.newCode": "Новый код (4-6 цифр)",
    "passcode.repeatCode": "Повтори код", "passcode.setBtn": "Установить пароль",
    "passcode.badFormat": "Код должен быть из 4-6 цифр", "passcode.mismatch": "Коды не совпадают",
    "passcode.setToast": "Пароль на переписки установлен ✅", "passcode.confirmRemove": "Отключить пароль на переписки?",
    "passcode.setFirst": "Сначала установи пароль в Настройках",
    "settings.patternReset": "Узор сброшен", "settings.emojiStatusHint": "Значок рядом с твоим именем — его видят все в чатах и в профиле.",
    "settings.noStatus": "Без статуса", "settings.statusSetPrefix": "Статус", "settings.statusRemoved": "Статус убран",
    "profile.blocked": "Заблокирован", "profile.request": "Заявка", "profile.write": "Написать",
    "profile.gift": "Подарить", "profile.congratulate": "Поздравить", "profile.addFriend": "В друзья",
    "sessions.empty": "Пока нет истории входов", "sessions.thisDevice": "это устройство", "sessions.ipUnknown": "IP неизвестен",
    "sessions.endSession": "Завершить сессию", "sessions.confirmEnd": "Завершить эту сессию? Устройство будет разлогинено.",
    "sessions.ended": "Сессия завершена", "sessions.unknownDevice": "устройство неизвестно",
    "privacy.everyone": "Все", "privacy.friendsOnly": "Только друзья", "privacy.nobody": "Никто",
    "privacy.stories": "Кому показывать мои истории", "privacy.bio": "Кому показывать мою анкету (bio)",
    "privacy.lastSeen": "Кому показывать, когда я был(а) в сети", "privacy.birthday": "Кому показывать день рождения",
    "privacy.photo": "Кому показывать фото профиля", "privacy.forward": "Кто может пересылать мои сообщения",
    "privacy.calls": "Кто может мне звонить", "privacy.gifts": "Кто может дарить мне подарки",
    "privacy.hint": "«Друзья» — это список ниже. @username всегда виден всем, иначе поиск и переписка перестанут работать.",
    "username.current": "Текущий юзернейм", "username.new": "Новый юзернейм", "username.passwordConfirm": "Пароль (для подтверждения)",
    "username.changeBtn": "Изменить юзернейм", "username.fillBoth": "Заполни оба поля", "username.changeError": "Ошибка смены юзернейма",
    "username.changed": "Юзернейм изменён на",
    "google.loadFailed": "Не удалось загрузить", "google.linkedAs": "Привязан аккаунт", "google.unlink": "Отвязать Google-аккаунт",
    "google.linkHint": "Привяжи Google-аккаунт, чтобы можно было входить в", "google.viaGoogle": "через Google.",
    "google.notConfigured": "Google-вход пока не настроен на сервере", "google.linkFailed": "Не получилось привязать Google-аккаунт",
    "google.linked": "Google-аккаунт привязан ✅", "google.confirmUnlink": "Отвязать Google-аккаунт? Вход по Google для этого профиля перестанет работать.",
    "google.unlinked": "Google-аккаунт отвязан",
    "deleteAcc.deleteBtn": "Удалить аккаунт навсегда", "deleteAcc.warning": "Это необратимо: удалятся твой профиль, все сообщения и участие в группах/каналах. Подтверди паролем.",
    "deleteAcc.password": "Пароль", "deleteAcc.confirmBtn": "Подтвердить удаление", "deleteAcc.enterPassword": "Введи пароль",
    "deleteAcc.confirmFinal": "Точно удалить аккаунт навсегда? Это нельзя отменить.", "deleteAcc.deleteError": "Ошибка удаления",
    "twofa.enabled": "Двухэтапная аутентификация включена", "twofa.passwordToDisable": "Пароль (для отключения)",
    "twofa.disableBtn": "Отключить 2FA", "twofa.hint": "Защити вход кодом из приложения-аутентификатора (Google Authenticator, Authy и т.п.)",
    "twofa.enableBtn": "Включить 2FA", "twofa.scanHint": "Отсканируй QR в приложении-аутентификаторе или введи ключ вручную:",
    "twofa.codeFromApp": "Код из приложения", "twofa.confirmBtn": "Подтвердить и включить", "twofa.badCode": "Неверный код",
    "twofa.enabledToast": "2FA включена ✅", "twofa.disabledToast": "2FA отключена",
    "settings.catProfile": "Профиль", "settings.catContacts": "Контакты", "settings.catAppearance": "Оформление",
    "settings.catPrivacy": "Конфиденциальность", "settings.catSecurity": "Безопасность", "settings.catAccount": "Аккаунт",
    "settings.username": "Юзернейм", "settings.google": "Google-аккаунт", "settings.savedContacts": "Сохранённые контакты",
    "settings.profileHeader": "Шапка профиля", "settings.blacklist": "Чёрный список",
    "settings.removeBtn": "Убрать", "settings.blockBtn": "Заблокировать", "settings.unblockBtn": "Разблокировать",
    "settings.emptyFriends": "Список друзей пуст", "settings.emptyBlacklist": "Чёрный список пуст",
    "settings.headerHint": "Цвет и узор шапки твоего профиля — их видят все, кто открывает твою страницу.",
    "settings.headerTop": "Цвет сверху", "settings.headerBottom": "Цвет снизу", "settings.headerPattern": "Узор фона",
    "settings.customEmoji": "Свой эмодзи", "settings.set": "Поставить",
    "contactReq.hint": "Этот аккаунт официально подтверждён. Напиши сообщение — администрация проверит его и передаст. Ответ придёт в чат «Поддержка».",
    "contactReq.placeholder": "Здравствуйте! Пишу по вопросу...", "contactReq.send": "Отправить через администрацию",
    "bday.title": "С днём рождения!", "bday.text": "UzMessenger поздравляет тебя! Пусть этот год будет самым счастливым 🎉",
    "bday.thanks": "Спасибо! 🎈",
    "call.someoneCalling": "Кто-то звонит…", "call.decline": "Отклонить", "call.accept": "Принять",
    "call.mic": "Микрофон", "call.end": "Завершить", "call.speaker": "Звук",
    "msgact.reply": "Ответить", "msgact.copy": "Копировать", "msgact.forward": "Переслать", "msgact.edit": "Изменить",
    "msgact.readInfo": "Прочитано", "msgact.delete": "Удалить"
  },
  en: {
    "nav.chats": "Chats", "nav.profile": "Profile", "nav.settings": "Settings",
    "chats.searchPlaceholder": "Search @username...",
    "chats.group": "Group", "chats.channel": "Channel", "chats.discover": "Discover", "chats.invite": "Invite",
    "chats.globalChat": "Global chat", "chats.globalChatSub": "chat with everyone",
    "chats.support": "Support", "chats.supportSub": "UzMessenger Support",
    "profile.title": "Profile", "profile.editProfile": "Edit profile", "profile.myStories": "My stories",
    "settings.title": "Settings", "settings.profileBlock": "Profile",
    "settings.displayName": "Display name", "settings.bio": "Bio", "settings.birthDate": "Birth date",
    "settings.avatar": "Avatar", "settings.fromGallery": "From gallery", "settings.saveProfile": "Save profile",
    "settings.appearance": "Appearance", "settings.language": "Language",
    "settings.privacy": "Privacy", "settings.friends": "Friends",
    "settings.passcode": "Device passcode", "settings.twoFA": "Two-factor authentication",
    "settings.verification": "Official verification", "settings.sessions": "My sessions", "settings.account": "Account",
    "settings.logout": "Log out", "settings.addFriendPlaceholder": "@username", "settings.add": "Add",
    "settings.emojiStatus": "Emoji status",
    "group.newGroup": "New group", "group.newChannel": "New channel", "group.name": "Name",
    "group.desc": "Description (optional)", "group.members": "Friends/family to add (comma-separated, @username)",
    "group.discoverableLabel": "Show in public search (Discover)", "group.create": "Create",
    "group.leave": "Leave group", "group.deleteGroup": "Delete group", "group.deleteChannel": "Delete channel", "group.addMemberPlaceholder": "@username",
    "list.newList": "New list", "list.title": "List title", "list.items": "Items",
    "list.addItem": "Add item", "list.send": "Send list",
    "story.newStory": "New story", "story.file": "File (optional)", "story.text": "Text (optional)",
    "story.publish": "Publish",
    "story.viewersTitle": "Views", "story.noViewers": "No one has viewed this story yet",
    "story.reactedToast": "reacted to your story",
    "call.audioCall": "Audio call", "call.connecting": "Connecting...",
    "discover.title": "Popular groups and channels", "discover.searchPlaceholder": "Search by name...", "discover.join": "Join",
    "common.messagePlaceholder": "Message...", "gift.codeLabel": "Secret code (not needed on Fridays)",

    "passcode.enter": "Enter passcode", "passcode.unlock": "Unlock", "passcode.wrong": "Wrong code",
    "common.back": "Back", "common.close": "Close", "common.send": "Send", "common.save": "Save",
    "common.typing": "typing…", "common.cancel": "Cancel", "common.delete": "Delete", "common.edit": "Edit",
    "common.loading": "Loading...", "common.error": "Error", "common.notFound": "Not found",
    "profile.openProfile": "Open profile",
    "wallpaper.chatTitle": "Wallpaper for this chat", "wallpaper.presets": "Presets", "wallpaper.ownPhoto": "Custom photo from gallery",
    "wallpaper.forBoth": "Set this wallpaper for the other person too", "wallpaper.reset": "Reset chat wallpaper",
    "attach.title": "Attach", "attach.photoVideo": "Photo/Video", "attach.location": "Location", "attach.gif": "GIF",
    "attach.doc": "Document or file", "attach.list": "List (shopping, to-do)", "attach.emoji": "Emoji", "attach.voice": "Voice (hold)",
    "reply.title": "Reply",
    "round.title": "Video message (round)", "round.flip": "Flip camera", "round.record": "Record",
    "round.stop": "Stop", "round.retake": "Retake",
    "gift.pickerHint": "Gift an emoji to this profile:",
    "readInfo.title": "Read by", "readInfo.empty": "No one has read it yet",
    "forward.title": "Forward", "forward.self": "Saved Messages (to self)", "forward.sent": "Forwarded",
    "contact.title": "Save contact", "contact.username": "Username", "contact.name": "Contact name",
    "contact.namePlaceholder": "e.g. Mom", "contact.note": "Note (optional)",
    "contact.notePlaceholder": "e.g. close friend", "contact.needName": "Enter a contact name",
    "contact.saved": "saved", "contact.confirmDelete": "Delete this contact?", "contact.empty": "No saved contacts yet. Open someone's profile and tap «Contact» to save them.",
    "contact.action": "Contact",
    "legal.title": "Terms of use", "legal.tabTerms": "Terms of Use", "legal.tabPrivacy": "Privacy",
    "legal.accepted": "Accepted", "legal.notAccepted": "You haven't accepted the terms policy yet", "legal.accept": "Accept",
    "legal.acceptedToast": "Thank you! Terms accepted ✅",
    "reply.toSelf": "yourself", "reply.editing": "Editing message",
    "msgact.copied": "Copied", "msgact.copyFailed": "Couldn't copy",
    "forward.failed": "Forward failed",
    "passcode.enabledHint": "Chat lock passcode is enabled", "passcode.lockNow": "Lock now",
    "passcode.removeBtn": "Disable passcode", "passcode.newCode": "New code (4-6 digits)",
    "passcode.repeatCode": "Repeat the code", "passcode.setBtn": "Set passcode",
    "passcode.badFormat": "Code must be 4-6 digits", "passcode.mismatch": "Codes don't match",
    "passcode.setToast": "Chat lock passcode set ✅", "passcode.confirmRemove": "Disable the chat lock passcode?",
    "passcode.setFirst": "Set a passcode in Settings first",
    "settings.patternReset": "Pattern reset", "settings.emojiStatusHint": "A badge next to your name — visible to everyone in chats and on your profile.",
    "settings.noStatus": "No status", "settings.statusSetPrefix": "Status", "settings.statusRemoved": "Status removed",
    "profile.blocked": "Blocked", "profile.request": "Request", "profile.write": "Message",
    "profile.gift": "Send gift", "profile.congratulate": "Congratulate", "profile.addFriend": "Add friend",
    "sessions.empty": "No login history yet", "sessions.thisDevice": "this device", "sessions.ipUnknown": "IP unknown",
    "sessions.endSession": "End session", "sessions.confirmEnd": "End this session? The device will be logged out.",
    "sessions.ended": "Session ended", "sessions.unknownDevice": "unknown device",
    "privacy.everyone": "Everyone", "privacy.friendsOnly": "Friends only", "privacy.nobody": "Nobody",
    "privacy.stories": "Who can see my stories", "privacy.bio": "Who can see my bio",
    "privacy.lastSeen": "Who can see when I was last online", "privacy.birthday": "Who can see my birthday",
    "privacy.photo": "Who can see my profile photo", "privacy.forward": "Who can forward my messages",
    "privacy.calls": "Who can call me", "privacy.gifts": "Who can send me gifts",
    "privacy.hint": "\"Friends\" is the list below. Your @username is always visible to everyone, otherwise search and messaging would stop working.",
    "username.current": "Current username", "username.new": "New username", "username.passwordConfirm": "Password (to confirm)",
    "username.changeBtn": "Change username", "username.fillBoth": "Fill in both fields", "username.changeError": "Failed to change username",
    "username.changed": "Username changed to",
    "google.loadFailed": "Failed to load", "google.linkedAs": "Linked account", "google.unlink": "Unlink Google account",
    "google.linkHint": "Link a Google account so you can sign in to", "google.viaGoogle": "with Google.",
    "google.notConfigured": "Google sign-in isn't configured on the server yet", "google.linkFailed": "Couldn't link the Google account",
    "google.linked": "Google account linked ✅", "google.confirmUnlink": "Unlink the Google account? Signing in with Google for this profile will stop working.",
    "google.unlinked": "Google account unlinked",
    "deleteAcc.deleteBtn": "Delete account permanently", "deleteAcc.warning": "This is irreversible: your profile, all messages, and group/channel membership will be deleted. Confirm with your password.",
    "deleteAcc.password": "Password", "deleteAcc.confirmBtn": "Confirm deletion", "deleteAcc.enterPassword": "Enter your password",
    "deleteAcc.confirmFinal": "Really delete the account permanently? This can't be undone.", "deleteAcc.deleteError": "Deletion failed",
    "twofa.enabled": "Two-factor authentication is enabled", "twofa.passwordToDisable": "Password (to disable)",
    "twofa.disableBtn": "Disable 2FA", "twofa.hint": "Protect your login with a code from an authenticator app (Google Authenticator, Authy, etc.)",
    "twofa.enableBtn": "Enable 2FA", "twofa.scanHint": "Scan the QR code in your authenticator app, or enter the key manually:",
    "twofa.codeFromApp": "Code from the app", "twofa.confirmBtn": "Confirm and enable", "twofa.badCode": "Incorrect code",
    "twofa.enabledToast": "2FA enabled ✅", "twofa.disabledToast": "2FA disabled",
    "settings.catProfile": "Profile", "settings.catContacts": "Contacts", "settings.catAppearance": "Appearance",
    "settings.catPrivacy": "Privacy", "settings.catSecurity": "Security", "settings.catAccount": "Account",
    "settings.username": "Username", "settings.google": "Google account", "settings.savedContacts": "Saved contacts",
    "settings.profileHeader": "Profile header", "settings.blacklist": "Blocked list",
    "settings.removeBtn": "Remove", "settings.blockBtn": "Block", "settings.unblockBtn": "Unblock",
    "settings.emptyFriends": "Friends list is empty", "settings.emptyBlacklist": "Blocked list is empty",
    "settings.headerHint": "Your profile header's color and pattern — visible to everyone who opens your page.",
    "settings.headerTop": "Top color", "settings.headerBottom": "Bottom color", "settings.headerPattern": "Background pattern",
    "settings.customEmoji": "Custom emoji", "settings.set": "Set",
    "contactReq.hint": "This account is officially verified. Write a message — the administration will review and pass it on. The reply will arrive in the «Support» chat.",
    "contactReq.placeholder": "Hello! I'm writing about...", "contactReq.send": "Send via administration",
    "bday.title": "Happy Birthday!", "bday.text": "UzMessenger wishes you all the best! May this be your happiest year yet 🎉",
    "bday.thanks": "Thanks! 🎈",
    "call.someoneCalling": "Someone is calling…", "call.decline": "Decline", "call.accept": "Accept",
    "call.mic": "Microphone", "call.end": "End call", "call.speaker": "Speaker",
    "msgact.reply": "Reply", "msgact.copy": "Copy", "msgact.forward": "Forward", "msgact.edit": "Edit",
    "msgact.readInfo": "Read by", "msgact.delete": "Delete"
  },
  uz: {
    "nav.chats": "Suhbatlar", "nav.profile": "Profil", "nav.settings": "Sozlamalar",
    "chats.searchPlaceholder": "@username qidirish...",
    "chats.group": "Guruh", "chats.channel": "Kanal", "chats.discover": "Ommabop", "chats.invite": "Taklif qilish",
    "chats.globalChat": "Umumiy chat", "chats.globalChatSub": "hamma bilan muloqot",
    "chats.support": "Yordam", "chats.supportSub": "UzMessenger Support",
    "profile.title": "Profil", "profile.editProfile": "Profilni tahrirlash", "profile.myStories": "Mening hikoyalarim",
    "settings.title": "Sozlamalar", "settings.profileBlock": "Profil",
    "settings.displayName": "Ko'rsatiladigan ism", "settings.bio": "O'zim haqimda", "settings.birthDate": "Tug'ilgan sana",
    "settings.avatar": "Avatar", "settings.fromGallery": "Galereyadan", "settings.saveProfile": "Profilni saqlash",
    "settings.appearance": "Ko'rinish", "settings.language": "Til",
    "settings.privacy": "Maxfiylik", "settings.friends": "Do'stlar",
    "settings.passcode": "Qurilma kodi", "settings.twoFA": "Ikki bosqichli autentifikatsiya",
    "settings.verification": "Rasmiy tasdiqlash", "settings.sessions": "Mening seanslarim", "settings.account": "Hisob",
    "settings.logout": "Hisobdan chiqish", "settings.addFriendPlaceholder": "@username", "settings.add": "Qo'shish",
    "settings.emojiStatus": "Emoji-status",
    "group.newGroup": "Yangi guruh", "group.newChannel": "Yangi kanal", "group.name": "Nomi",
    "group.desc": "Tavsif (ixtiyoriy)", "group.members": "Qo'shiladigan do'stlar/oila a'zolari (vergul bilan, @username)",
    "group.discoverableLabel": "Ommaviy qidiruvda ko'rsatish (Ommabop)", "group.create": "Yaratish",
    "group.leave": "Guruhni tark etish", "group.deleteGroup": "Guruhni o'chirish", "group.deleteChannel": "Kanalni o'chirish", "group.addMemberPlaceholder": "@username",
    "list.newList": "Yangi ro'yxat", "list.title": "Ro'yxat nomi", "list.items": "Bandlar",
    "list.addItem": "Band qo'shish", "list.send": "Ro'yxatni yuborish",
    "story.newStory": "Yangi hikoya", "story.file": "Fayl (ixtiyoriy)", "story.text": "Matn (ixtiyoriy)",
    "story.publish": "Chop etish",
    "story.viewersTitle": "Ko'rishlar", "story.noViewers": "Bu hikoyani hali hech kim ko'rmagan",
    "story.reactedToast": "hikoyangizga reaksiya bildirdi",
    "call.audioCall": "Ovozli qo'ng'iroq", "call.connecting": "Ulanmoqda...",
    "discover.title": "Ommabop guruh va kanallar", "discover.searchPlaceholder": "Nomi bo'yicha qidirish...", "discover.join": "Qo'shilish",
    "common.messagePlaceholder": "Xabar...", "gift.codeLabel": "Maxfiy kod (juma kunlari kerak emas)",

    "passcode.enter": "Kod-parolni kiriting", "passcode.unlock": "Ochish", "passcode.wrong": "Noto'g'ri kod",
    "common.back": "Orqaga", "common.close": "Yopish", "common.send": "Yuborish", "common.save": "Saqlash",
    "common.typing": "yozmoqda…", "common.cancel": "Bekor qilish", "common.delete": "O'chirish", "common.edit": "Tahrirlash",
    "common.loading": "Yuklanmoqda...", "common.error": "Xato", "common.notFound": "Topilmadi",
    "profile.openProfile": "Profilni ochish",
    "wallpaper.chatTitle": "Ushbu chat uchun fon", "wallpaper.presets": "Tayyor variantlar", "wallpaper.ownPhoto": "Galereyadan o'z rasmi",
    "wallpaper.forBoth": "Bu fonni suhbatdoshga ham qo'yish", "wallpaper.reset": "Chat fonini tiklash",
    "attach.title": "Biriktirish", "attach.photoVideo": "Foto/Video", "attach.location": "Geolokatsiya", "attach.gif": "GIF",
    "attach.doc": "Hujjat yoki fayl", "attach.list": "Ro'yxat (xarid, ishlar)", "attach.emoji": "Emoji", "attach.voice": "Ovozli xabar (bosib turing)",
    "reply.title": "Javob",
    "round.title": "Video xabar (doira)", "round.flip": "Kamerani almashtirish", "round.record": "Yozib olish",
    "round.stop": "To'xtatish", "round.retake": "Qayta yozish",
    "gift.pickerHint": "Profilga emoji-sovg'a berish:",
    "readInfo.title": "O'qildi", "readInfo.empty": "Hali hech kim o'qimadi",
    "forward.title": "Yuborish", "forward.self": "Saqlangan xabarlar (o'zimga)", "forward.sent": "Yuborildi",
    "contact.title": "Kontaktni saqlash", "contact.username": "Foydalanuvchi nomi", "contact.name": "Kontakt ismi",
    "contact.namePlaceholder": "Masalan, Oyi", "contact.note": "Izoh (ixtiyoriy)",
    "contact.notePlaceholder": "Masalan, yaqin inson", "contact.needName": "Kontakt ismini kiriting",
    "contact.saved": "saqlandi", "contact.confirmDelete": "Kontaktni o'chirasizmi?", "contact.empty": "Hali saqlangan kontaktlar yo'q. Kimningdir profilini oching va uni saqlash uchun «Kontakt» tugmasini bosing.",
    "contact.action": "Kontakt",
    "legal.title": "Foydalanish shartlari", "legal.tabTerms": "Foydalanish shartlari", "legal.tabPrivacy": "Maxfiylik",
    "legal.accepted": "Qabul qilindi", "legal.notAccepted": "Siz hali shartlar siyosatini qabul qilmagansiz", "legal.accept": "Qabul qilish",
    "legal.acceptedToast": "Rahmat! Shartlar qabul qilindi ✅",
    "reply.toSelf": "o'zingizga", "reply.editing": "Xabarni tahrirlash",
    "msgact.copied": "Nusxalandi", "msgact.copyFailed": "Nusxalab bo'lmadi",
    "forward.failed": "Yuborishda xatolik",
    "passcode.enabledHint": "Yozishmalar uchun parol yoqilgan", "passcode.lockNow": "Hozir bloklash",
    "passcode.removeBtn": "Parolni o'chirish", "passcode.newCode": "Yangi kod (4-6 raqam)",
    "passcode.repeatCode": "Kodni qayta kiriting", "passcode.setBtn": "Parolni o'rnatish",
    "passcode.badFormat": "Kod 4-6 raqamdan iborat bo'lishi kerak", "passcode.mismatch": "Kodlar mos kelmadi",
    "passcode.setToast": "Yozishmalar uchun parol o'rnatildi ✅", "passcode.confirmRemove": "Yozishmalar uchun parolni o'chirasizmi?",
    "passcode.setFirst": "Avval Sozlamalarda parol o'rnating",
    "settings.patternReset": "Uslub bekor qilindi", "settings.emojiStatusHint": "Ismingiz yonidagi belgi — uni chatlarda va profilda hamma ko'radi.",
    "settings.noStatus": "Status yo'q", "settings.statusSetPrefix": "Status", "settings.statusRemoved": "Status olib tashlandi",
    "profile.blocked": "Bloklangan", "profile.request": "So'rov", "profile.write": "Yozish",
    "profile.gift": "Sovg'a berish", "profile.congratulate": "Tabriklash", "profile.addFriend": "Do'stga qo'shish",
    "sessions.empty": "Hali kirish tarixi yo'q", "sessions.thisDevice": "shu qurilma", "sessions.ipUnknown": "IP noma'lum",
    "sessions.endSession": "Seansni tugatish", "sessions.confirmEnd": "Ushbu seansni tugatasizmi? Qurilma tizimdan chiqadi.",
    "sessions.ended": "Seans tugatildi", "sessions.unknownDevice": "qurilma noma'lum",
    "privacy.everyone": "Hammaga", "privacy.friendsOnly": "Faqat do'stlar", "privacy.nobody": "Hech kimga",
    "privacy.stories": "Hikoyalarimni kim ko'rishi mumkin", "privacy.bio": "Bio ma'lumotimni kim ko'rishi mumkin",
    "privacy.lastSeen": "Oxirgi onlayn vaqtimni kim ko'rishi mumkin", "privacy.birthday": "Tug'ilgan kunimni kim ko'rishi mumkin",
    "privacy.photo": "Profil rasmimni kim ko'rishi mumkin", "privacy.forward": "Xabarlarimni kim ulashishi mumkin",
    "privacy.calls": "Menga kim qo'ng'iroq qila oladi", "privacy.gifts": "Menga kim sovg'a bera oladi",
    "privacy.hint": "«Do'stlar» — bu pastdagi ro'yxat. @username har doim hammaga ko'rinadi, aks holda qidiruv va yozishma ishlamay qoladi.",
    "username.current": "Joriy foydalanuvchi nomi", "username.new": "Yangi foydalanuvchi nomi", "username.passwordConfirm": "Parol (tasdiqlash uchun)",
    "username.changeBtn": "Foydalanuvchi nomini o'zgartirish", "username.fillBoth": "Ikkala maydonni ham to'ldiring", "username.changeError": "Foydalanuvchi nomini o'zgartirishda xatolik",
    "username.changed": "Foydalanuvchi nomi o'zgartirildi:",
    "google.loadFailed": "Yuklab bo'lmadi", "google.linkedAs": "Ulangan hisob", "google.unlink": "Google hisobini uzish",
    "google.linkHint": "Google hisobini ulang, shunda quyidagiga Google orqali kirishingiz mumkin:", "google.viaGoogle": "",
    "google.notConfigured": "Google orqali kirish hali serverda sozlanmagan", "google.linkFailed": "Google hisobini ulab bo'lmadi",
    "google.linked": "Google hisobi ulandi ✅", "google.confirmUnlink": "Google hisobini uzasizmi? Bu profil uchun Google orqali kirish ishlamay qoladi.",
    "google.unlinked": "Google hisobi uzildi",
    "deleteAcc.deleteBtn": "Hisobni butunlay o'chirish", "deleteAcc.warning": "Bu qaytarib bo'lmaydi: profilingiz, barcha xabarlaringiz va guruh/kanallardagi a'zoligingiz o'chiriladi. Parol bilan tasdiqlang.",
    "deleteAcc.password": "Parol", "deleteAcc.confirmBtn": "O'chirishni tasdiqlash", "deleteAcc.enterPassword": "Parolni kiriting",
    "deleteAcc.confirmFinal": "Hisobni butunlay o'chirishga aminmisiz? Buni bekor qilib bo'lmaydi.", "deleteAcc.deleteError": "O'chirishda xatolik",
    "twofa.enabled": "Ikki bosqichli autentifikatsiya yoqilgan", "twofa.passwordToDisable": "Parol (o'chirish uchun)",
    "twofa.disableBtn": "2FA ni o'chirish", "twofa.hint": "Kirishni autentifikator ilovasidagi kod bilan himoyalang (Google Authenticator, Authy va h.k.)",
    "twofa.enableBtn": "2FA ni yoqish", "twofa.scanHint": "Autentifikator ilovasida QR kodni skanerlang yoki kalitni qo'lda kiriting:",
    "twofa.codeFromApp": "Ilovadagi kod", "twofa.confirmBtn": "Tasdiqlash va yoqish", "twofa.badCode": "Noto'g'ri kod",
    "twofa.enabledToast": "2FA yoqildi ✅", "twofa.disabledToast": "2FA o'chirildi",
    "settings.catProfile": "Profil", "settings.catContacts": "Kontaktlar", "settings.catAppearance": "Ko'rinish",
    "settings.catPrivacy": "Maxfiylik", "settings.catSecurity": "Xavfsizlik", "settings.catAccount": "Hisob",
    "settings.username": "Foydalanuvchi nomi", "settings.google": "Google hisobi", "settings.savedContacts": "Saqlangan kontaktlar",
    "settings.profileHeader": "Profil sarlavhasi", "settings.blacklist": "Qora ro'yxat",
    "settings.removeBtn": "Olib tashlash", "settings.blockBtn": "Bloklash", "settings.unblockBtn": "Blokdan chiqarish",
    "settings.emptyFriends": "Do'stlar ro'yxati bo'sh", "settings.emptyBlacklist": "Qora ro'yxat bo'sh",
    "settings.headerHint": "Profilingiz sarlavhasining rangi va uslubi — sizning sahifangizni ochgan har bir kishi buni ko'radi.",
    "settings.headerTop": "Yuqori rang", "settings.headerBottom": "Pastki rang", "settings.headerPattern": "Fon uslubi",
    "settings.customEmoji": "O'z emojingiz", "settings.set": "O'rnatish",
    "contactReq.hint": "Bu hisob rasmiy tasdiqlangan. Xabar yozing — administratsiya ko'rib chiqib yetkazadi. Javob «Yordam» chatiga keladi.",
    "contactReq.placeholder": "Assalomu alaykum! Savolim shu bo'yicha...", "contactReq.send": "Administratsiya orqali yuborish",
    "bday.title": "Tug'ilgan kuningiz bilan!", "bday.text": "UzMessenger sizni tabriklaydi! Bu yil eng baxtli yilingiz bo'lsin 🎉",
    "bday.thanks": "Rahmat! 🎈",
    "call.someoneCalling": "Kimdir qo'ng'iroq qilyapti…", "call.decline": "Rad etish", "call.accept": "Qabul qilish",
    "call.mic": "Mikrofon", "call.end": "Tugatish", "call.speaker": "Ovoz",
    "msgact.reply": "Javob berish", "msgact.copy": "Nusxalash", "msgact.forward": "Yuborish", "msgact.edit": "Tahrirlash",
    "msgact.readInfo": "O'qildi", "msgact.delete": "O'chirish"
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
  reRenderDynamicSections();
  if (me) {
    await saveSettingsPatch({ language: lang });
    renderLanguageSection();
  }
}

// Re-render dynamically-built (JS-generated) UI sections so they pick up
// the newly selected language immediately, without needing to reopen them.
function reRenderDynamicSections() {
  const fns = [
    "renderLanguageSection", "renderContactsSection", "renderFriendsSection",
    "renderBlacklistSection", "renderLegalSection", "renderProfileHeaderSection",
    "renderEmojiStatusSection", "renderPasscodeSection", "renderUsernameSection",
    "renderGoogleSection", "render2FASection", "renderVerificationSection",
    "renderSessionsSection", "renderDeleteAccountSection", "renderPrivacySection"
  ];
  for (const fnName of fns) {
    try {
      if (typeof window[fnName] === "function") window[fnName]();
    } catch {}
  }
  // If the legal modal is currently open, keep it in sync with the UI language too.
  try {
    const legalModal = document.getElementById("legalModal");
    if (legalModal && !legalModal.classList.contains("hidden")) {
      legalLang = currentLang;
      localStorage.setItem("legalLang", legalLang);
      renderLegalBody();
    }
  } catch {}
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
  refreshContactInbox();

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
    emojiStatus: s.emojiStatus || "",
    birthdayToday: isMyBirthdayToday(),
    headerTop: s.headerTop || "",
    headerBottom: s.headerBottom || "",
    headerPattern: s.headerPattern || ""
  };
}

// ---------------- ШАПКА ПРОФИЛЯ (градиент + узор) ----------------
function headerPatternImage(emoji) {
  if (!emoji) return null;
  const glyph = String(emoji).trim().slice(0, 4);
  if (!glyph) return null;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'>`
    + `<text x='28' y='38' font-size='24' text-anchor='middle' opacity='0.55'>${glyph}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
function applyProfileHeader(el, info) {
  if (!el) return;
  info = info || {};
  if (info.headerTop) el.style.setProperty("--hd-top", info.headerTop);
  else el.style.removeProperty("--hd-top");
  if (info.headerBottom) el.style.setProperty("--hd-bottom", info.headerBottom);
  else el.style.removeProperty("--hd-bottom");
  const img = headerPatternImage(info.headerPattern);
  if (img) {
    el.style.setProperty("--hd-pattern-img", img);
    el.style.setProperty("--hd-pattern-size", "56px 56px");
    el.style.setProperty("--hd-pattern-pos", "0 0");
  } else {
    el.style.removeProperty("--hd-pattern-img");
    el.style.removeProperty("--hd-pattern-size");
    el.style.removeProperty("--hd-pattern-pos");
  }
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
  const ava = document.getElementById("chatHeadAvatar");

  if (currentChat === "global") {
    title.textContent = "Общий чат";
    sub.textContent = "общение со всеми";
    ava.innerHTML = `<span class="headicon act-blue"><i class="fa-solid fa-earth-americas"></i></span>`;
  } else if (currentChat === "support") {
    title.innerHTML = `Поддержка${verifiedBadge(true)}`;
    sub.textContent = "UzMessenger Support";
    ava.innerHTML = avatarHtml({ username: "support" });
  } else if (isSelfChat(currentChat)) {
    title.innerHTML = `Избранное`;
    sub.textContent = "сохранённые сообщения и #теги";
    ava.innerHTML = `<span class="headicon act-violet"><i class="fa-solid fa-bookmark"></i></span>`;
  } else if (isGroupChat(currentChat)) {
    const g = currentGroupMeta;
    title.innerHTML = (g ? esc(g.name) : "Группа") + (g && g.isChannel ? ` <i class="fa-solid fa-bullhorn" title="Канал"></i>` : "");
    sub.textContent = g ? (g.isChannel ? "канал" : `${g.memberCount || ""} участников`.trim()) : "";
    ava.innerHTML = g && g.avatarUrl
      ? `<img src="${esc(g.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : `<span class="headicon act-orange"><i class="fa-solid ${g && g.isChannel ? "fa-bullhorn" : "fa-users"}"></i></span>`;
  } else {
    const info = userInfoCache.get(currentChat) || { username: currentChat, displayName: currentChat };
    title.innerHTML = nameHtml(info);
    sub.textContent = lastSeenText(info);
    ava.innerHTML = avatarHtml(info);
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

    if (data.type === "messageEdited") {
      const el = document.querySelector(`[data-mid="${data.id}"] .mtext`);
      if (el) el.innerHTML = formatText(data.text);
      const row = document.querySelector(`[data-mid="${data.id}"]`);
      if (row && !row.querySelector(".editedmark")) {
        const timeEl = row.querySelector(".mtime");
        if (timeEl) timeEl.insertAdjacentHTML("beforebegin", `<span class="editedmark">изменено</span>`);
      }
      return;
    }

    if (data.type === "read") {
      if (data.chatKey === currentChat) markTicksRead(data.upToId);
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

    if (data.type === "contactRequest") {
      toast("📨 Тебе хотят написать — проверь список чатов");
      refreshContactInbox();
      return;
    }

    if (data.type === "birthday") {
      toast(`🎂 Сегодня день рождения у ${data.displayName || "@" + data.username}!`);
      showBirthdays();
      return;
    }

    if (data.type === "storyReaction") {
      toast(`${data.reaction} @${data.from} ${t("story.reactedToast")}`);
      // если список просмотров этой истории сейчас открыт — обновим его
      const viewersModal = document.getElementById("storyViewersModal");
      if (viewersModal && !viewersModal.classList.contains("hidden")) {
        openStoryViewersModal(data.storyId);
      }
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
        if (msg.sender !== me.username && !document.hidden) markRead(msg.id);
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
  if (msg.mediaType === "gift") return "🎁 Подарок";
  if (msg.mediaType === "round") return "⭕ Видеосообщение";
  if (msg.mediaType === "list") return "📋 Список";
  if (msg.mediaType === "location") return "📍 Геолокация";
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
      : msg.chatType === "support" ? "UzMessenger"
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

  const lastIncoming = [...d.messages].reverse().find(m => m.sender !== me.username);
  if (lastIncoming) markRead(lastIncoming.id);

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

function renderGiftBody(m) {
  let emoji = "🎁";
  try { emoji = JSON.parse(m.text || "{}").emoji || "🎁"; } catch {}
  return `
    <div class="giftmsg">
      <span class="gift-badge">${esc(emoji)}</span>
      <div class="giftmsg-label">Подарок</div>
    </div>
  `;
}

const messageCache = new Map(); // id -> последнее известное сообщение (для меню действий/ответа/редактирования)

function replyQuoteHtml(preview) {
  if (!preview) return "";
  const who = preview.sender === me.username ? "Вы" : ("@" + preview.sender);
  const snippet = preview.mediaType === "text" ? esc((preview.text || "").slice(0, 80)) : esc(msgPreview(preview));
  return `<div class="replyquote">
    <div class="replyquote-line"></div>
    <div class="replyquote-body"><div class="replyquote-who">${who}</div><div class="replyquote-text">${snippet}</div></div>
  </div>`;
}

function renderMessage(m) {
  messageCache.set(m.id, m);

  const box = document.getElementById("messages");
  const empty = box.querySelector(".emptyhint");
  if (empty) empty.remove();

  const mine = m.sender === me.username;
  const info = m.sender === "support"
    ? { username: "support", displayName: "Поддержка UzMessenger", verified: true }
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
  } else if (m.mediaType === "location") {
    body = renderLocationBody(m);
  } else if (m.mediaType === "gift") {
    body = renderGiftBody(m);
  } else if (m.mediaType === "round") {
    body = renderRoundBody(m);
  } else {
    const text = m.text || "";
    body = EMOJI_ONLY_RE.test(text.trim())
      ? `<div class="mtext bigemoji">${esc(text.trim())}</div>`
      : `<div class="mtext">${formatText(text)}</div>`;
  }

  const actions = [];
  if (["image", "video", "round", "audio", "file"].includes(m.mediaType) && m.mediaUrl) {
    const dlName = esc(m.fileName || (m.mediaType === "round" ? "video_message.webm" : m.mediaType));
    actions.push(`<a class="mact" href="${esc(m.mediaUrl)}" download="${dlName}" title="Скачать"><i class="fa-solid fa-download"></i></a>`);
    actions.push(`<button class="mact" onclick="openForwardPicker(${m.id})" title="Переслать"><i class="fa-solid fa-share"></i></button>`);
  }
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
  const avatar = mine ? "" : `<div class="mava" ${avatarClick} style="width:34px;height:34px;min-width:34px;overflow:hidden;border-radius:50%">${avatarHtml(info)}</div>`;

  const reply = replyQuoteHtml(m.replyPreview);
  const editedMark = m.edited ? `<span class="editedmark">изменено</span>` : "";
  const ticks = mine && m.chatType !== "support"
    ? `<span class="ticks ${m.readCount > 0 ? "read" : ""}"><i class="fa-solid fa-check"></i><i class="fa-solid fa-check"></i></span>`
    : "";

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
      ${reply}
      ${body}
      <div class="mtime">${editedMark}${time}${ticks}</div>
    </div>
  `;

  box.appendChild(row);
  if (m.mediaType === "audio") setupVoicePlayer(m.id);
  attachLongPress(row.querySelector(".bubble"), m.id);
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
  if (!d.ok) return alert(d.error || "Ошибка удаления");
  messageCache.delete(id);
}

function onEnter(e) {
  if (e.key === "Enter") sendText();
}

// ---------------- ОТВЕТ / РЕДАКТИРОВАНИЕ ----------------
let replyToId = null;
let editingMsgId = null;

function startReply(id) {
  const m = messageCache.get(id);
  if (!m) return;
  editingMsgId = null;
  replyToId = id;
  document.getElementById("replyBarTitle").textContent = t("reply.title") + " " + (m.sender === me.username ? t("reply.toSelf") : "@" + m.sender);
  document.getElementById("replyBarText").textContent = m.mediaType === "text" ? (m.text || "") : msgPreview(m);
  document.getElementById("replyBar").classList.remove("hidden");
  document.getElementById("textInput").focus();
}

function startEdit(id) {
  const m = messageCache.get(id);
  if (!m || m.mediaType !== "text") return;
  replyToId = null;
  editingMsgId = id;
  document.getElementById("replyBarTitle").textContent = t("reply.editing");
  document.getElementById("replyBarText").textContent = m.text || "";
  document.getElementById("replyBar").classList.remove("hidden");
  const input = document.getElementById("textInput");
  input.value = m.text || "";
  input.focus();
}

function cancelReplyOrEdit() {
  replyToId = null;
  editingMsgId = null;
  document.getElementById("replyBar").classList.add("hidden");
  document.getElementById("textInput").value = "";
}

function sendText() {
  const input = document.getElementById("textInput");
  const text = input.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");

  if (editingMsgId) {
    ws.send(JSON.stringify({ type: "edit-message", id: editingMsgId, text }));
    cancelReplyOrEdit();
    return;
  }

  lastSentText = text;
  const payload = { type: "text-message", receiver: currentChat, text };
  if (replyToId) payload.replyTo = replyToId;
  ws.send(JSON.stringify(payload));
  input.value = "";
  typing(false);
  closeEmojiPanel();
  cancelReplyOrEdit();
}

// ---------------- ПРОЧИТАНО (галочки) ----------------
function markRead(upToId) {
  if (!ws || ws.readyState !== 1 || !upToId) return;
  ws.send(JSON.stringify({ type: "mark-read", to: currentChat, upToId }));
}

function markTicksRead(upToId) {
  document.querySelectorAll(".mrow.mine").forEach(row => {
    const id = Number(row.dataset.mid);
    if (id && id <= upToId) {
      const t = row.querySelector(".ticks");
      if (t) t.classList.add("read");
    }
  });
}

// ---------------- ДОЛГОЕ НАЖАТИЕ НА СООБЩЕНИЕ → МЕНЮ ДЕЙСТВИЙ ----------------
function attachLongPress(el, id) {
  if (!el) return;
  let timer = null, moved = false, startX = 0, startY = 0;

  const start = (x, y) => {
    moved = false;
    startX = x; startY = y;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!moved) openMsgActions(id); }, 420);
  };
  const move = (x, y) => {
    if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) { moved = true; clearTimeout(timer); }
  };
  const end = () => clearTimeout(timer);

  el.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
  el.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  el.addEventListener("mouseup", end);
  el.addEventListener("mouseleave", end);
  el.addEventListener("touchstart", (e) => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener("touchmove", (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener("touchend", end);
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); openMsgActions(id); });
}

function openMsgActions(id) {
  const m = messageCache.get(id);
  if (!m) return;
  const mine = m.sender === me.username;

  const items = [];
  items.push({ icon: "fa-reply", label: t("msgact.reply"), fn: `startReply(${id}); closeMsgActions();` });
  if (m.mediaType === "text" && m.text) {
    items.push({ icon: "fa-copy", label: t("msgact.copy"), fn: `copyMsgText(${id}); closeMsgActions();` });
  }
  items.push({ icon: "fa-share", label: t("msgact.forward"), fn: `openForwardPicker(${id}); closeMsgActions();` });
  if (mine && m.mediaType === "text") {
    items.push({ icon: "fa-pen", label: t("msgact.edit"), fn: `startEdit(${id}); closeMsgActions();` });
  }
  if (mine && m.chatType !== "support") {
    items.push({ icon: "fa-eye", label: t("msgact.readInfo"), fn: `openReadInfo(${id}); closeMsgActions();` });
  }
  if (mine) {
    items.push({ icon: "fa-trash", label: t("msgact.delete"), fn: `closeMsgActions(); deleteMsg(${id});`, danger: true });
  }

  document.getElementById("msgActionsList").innerHTML = items.map(it => `
    <button class="msgaction ${it.danger ? "danger" : ""}" onclick="${it.fn}">
      <i class="fa-solid ${it.icon}"></i><span>${it.label}</span>
    </button>
  `).join("");
  document.getElementById("msgActionsSheet").classList.remove("hidden");
}

function closeMsgActions() {
  document.getElementById("msgActionsSheet").classList.add("hidden");
}

function copyMsgText(id) {
  const m = messageCache.get(id);
  if (!m) return;
  navigator.clipboard?.writeText(m.text || "").then(
    () => toast(t("msgact.copied")),
    () => alert(t("msgact.copyFailed"))
  );
}

// ---------------- ПРОЧИТАНО: КТО И КОГДА ----------------
async function openReadInfo(id) {
  const box = document.getElementById("readInfoBody");
  box.innerHTML = `<div class="hint">${t("common.loading")}</div>`;
  document.getElementById("readInfoModal").classList.remove("hidden");

  const r = await fetch(`/api/messages/${id}/reads`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok || d.reads.length === 0) {
    box.innerHTML = `<div class="hint">${t("readInfo.empty")}</div>`;
    return;
  }
  box.innerHTML = d.reads.map(r => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml({ avatarUrl: r.avatarUrl, displayName: r.displayName, username: r.reader })}</div>
      <div class="meta">
        <div class="name">${esc(r.displayName || r.reader)}</div>
        <div class="preview">@${esc(r.reader)}</div>
      </div>
      <div class="hint">${new Date(r.readAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
  `).join("");
}

function closeReadInfo() {
  document.getElementById("readInfoModal").classList.add("hidden");
}

// ---------------- ПЕРЕСЛАТЬ В ЛЮБОЙ ЧАТ ----------------
let forwardMsgId = null;

function openForwardPicker(id) {
  forwardMsgId = id;
  const box = document.getElementById("forwardList");

  const extra = Array.from(document.querySelectorAll(".chatitem[data-chat]"))
    .map(b => b.dataset.chat)
    .filter(c => c !== "global" && c !== "support" && c !== me.username)
    .map(c => {
      const btn = document.querySelector(`.chatitem[data-chat="${c}"]`);
      const label = c.startsWith("group:") ? (btn?.querySelector(".name")?.textContent || c) : "@" + c;
      return { chat: c, label };
    });

  const chats = [{ chat: "global", label: t("chats.globalChat") }, { chat: "self", label: "⭐ " + t("forward.self") }].concat(extra);

  box.innerHTML = chats.map(c => `
    <button class="btn ghost full" style="text-align:left;margin-bottom:6px" onclick="doForward('${esc(c.chat)}')">${esc(c.label)}</button>
  `).join("");

  document.getElementById("forwardModal").classList.remove("hidden");
}

function closeForwardPicker() {
  document.getElementById("forwardModal").classList.add("hidden");
  forwardMsgId = null;
}

async function doForward(to) {
  if (!forwardMsgId) return;
  const target = to === "self" ? me.username : to;
  const r = await fetch(`/api/messages/${forwardMsgId}/forward`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ to: target })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("forward.failed"));
  toast(t("forward.sent") + " ✅");
  closeForwardPicker();
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

// ---------------- ВИДЕОСООБЩЕНИЯ-КРУЖОЧКИ (как в Telegram) ----------------
// Пишем не сырое видео с камеры, а холст (canvas), на который каждый кадр
// рисуется уже обрезанным в круг — поэтому итоговый файл САМ по себе кружочек
// (с чёрными "уголками" вместо прозрачных — надёжно работает во всех браузерах),
// а не просто квадратное видео, обрезанное в круг одним CSS.
const ROUND_MAX_MS = 60000;
const ROUND_SIZE = 480;
let roundStream = null, roundRecorder = null, roundChunks = [], roundBlob = null;
let roundTimerInterval = null, roundStartedAt = 0;
let roundFacing = "user";
let roundDrawing = false, roundDrawRAF = null;
let roundMixedStream = null;

function pickRoundMime() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function openCameraStream(facing) {
  const opts = { video: { facingMode: { ideal: facing }, width: { ideal: ROUND_SIZE }, height: { ideal: ROUND_SIZE }, aspectRatio: 1 }, audio: true };
  return navigator.mediaDevices.getUserMedia(opts);
}

async function openRoundRecorder() {
  if (currentChat === "support") return alert("В поддержку видеосообщения отправлять нельзя");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alert("Этот браузер не поддерживает запись видео");

  resetRoundUI();
  document.getElementById("roundRecorderModal").classList.remove("hidden");
  roundFacing = "user";

  try {
    roundStream = await openCameraStream(roundFacing);
  } catch {
    alert("Нет доступа к камере или микрофону — разреши его в настройках браузера");
    closeRoundRecorder();
    return;
  }

  const v = document.getElementById("roundLiveVideo");
  v.srcObject = roundStream;
  v.muted = true;
  try { await v.play(); } catch {}

  roundDrawing = true;
  roundDrawFrame();
}

// рисуем текущий кадр камеры в круге на холсте — именно это и попадает в запись
function roundDrawFrame() {
  if (!roundDrawing) return;
  const v = document.getElementById("roundLiveVideo");
  const c = document.getElementById("roundCanvas");
  if (v && c) {
    const ctx = c.getContext("2d");
    const size = c.width;

    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();

    const vw = v.videoWidth, vh = v.videoHeight;
    if (vw && vh) {
      const scale = Math.max(size / vw, size / vh);
      const dw = vw * scale, dh = vh * scale;
      const dx = (size - dw) / 2, dy = (size - dh) / 2;

      if (roundFacing === "user") {
        ctx.translate(size, 0);
        ctx.scale(-1, 1); // зеркалим фронталку, как в любой камере
      }
      ctx.drawImage(v, dx, dy, dw, dh);
    }
    ctx.restore();
  }
  roundDrawRAF = requestAnimationFrame(roundDrawFrame);
}

async function flipRoundCamera() {
  if (!roundStream) return;
  const newFacing = roundFacing === "user" ? "environment" : "user";
  let newStream;
  try {
    newStream = await openCameraStream(newFacing);
  } catch {
    toast("Не удалось переключить камеру");
    return;
  }

  const oldVideoTrack = roundStream.getVideoTracks()[0];
  const newVideoTrack = newStream.getVideoTracks()[0];
  if (oldVideoTrack) { roundStream.removeTrack(oldVideoTrack); oldVideoTrack.stop(); }
  roundStream.addTrack(newVideoTrack);
  newStream.getAudioTracks().forEach((t) => t.stop()); // звук уже есть в roundStream, второй микрофон не нужен

  roundFacing = newFacing;
  const v = document.getElementById("roundLiveVideo");
  v.srcObject = null;
  v.srcObject = roundStream;
  try { await v.play(); } catch {}
  // запись не прерывается — canvas продолжает рисовать уже новую камеру
}

function startRoundRecording() {
  const canvas = document.getElementById("roundCanvas");
  if (!canvas || !roundStream) return;

  roundChunks = [];
  const canvasStream = canvas.captureStream(30);
  roundMixedStream = new MediaStream([...canvasStream.getVideoTracks(), ...roundStream.getAudioTracks()]);

  const mime = pickRoundMime();
  try {
    roundRecorder = mime ? new MediaRecorder(roundMixedStream, { mimeType: mime }) : new MediaRecorder(roundMixedStream);
  } catch {
    alert("Запись видео не поддерживается этим браузером");
    return;
  }
  roundRecorder.ondataavailable = (e) => { if (e.data && e.data.size) roundChunks.push(e.data); };
  roundRecorder.onstop = onRoundStop;
  roundRecorder.start();
  roundStartedAt = Date.now();

  document.getElementById("roundRecordBtn").classList.add("hidden");
  document.getElementById("roundStopBtn").classList.remove("hidden");
  document.getElementById("roundTimer").classList.remove("hidden");
  tickRoundTimer();
  roundTimerInterval = setInterval(tickRoundTimer, 200);
}

function tickRoundTimer() {
  const ms = Date.now() - roundStartedAt;
  const s = Math.floor(ms / 1000);
  document.getElementById("roundTimer").textContent =
    String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  if (ms >= ROUND_MAX_MS) stopRoundRecording();
}

function stopRoundRecording() {
  clearInterval(roundTimerInterval);
  roundTimerInterval = null;
  if (roundRecorder && roundRecorder.state !== "inactive") roundRecorder.stop();
}

function onRoundStop() {
  roundDrawing = false;
  cancelAnimationFrame(roundDrawRAF);

  const mime = (roundRecorder && roundRecorder.mimeType) || "video/webm";
  roundBlob = new Blob(roundChunks, { type: mime });
  const url = URL.createObjectURL(roundBlob);

  const v = document.getElementById("roundLiveVideo");
  v.srcObject = null;
  v.src = url;
  v.muted = false;
  v.loop = true;
  document.getElementById("roundCanvas").classList.add("hidden");
  v.classList.remove("roundsrc");
  v.classList.add("roundpreviewvid");
  v.play().catch(() => {});

  document.getElementById("roundStopBtn").classList.add("hidden");
  document.getElementById("roundFlipBtn").classList.add("hidden");
  document.getElementById("roundTimer").classList.add("hidden");
  document.getElementById("roundPreviewActions").classList.remove("hidden");
}

function retakeRound() {
  roundBlob = null;
  roundChunks = [];
  const v = document.getElementById("roundLiveVideo");
  v.src = "";
  v.classList.remove("roundpreviewvid");
  v.classList.add("roundsrc");
  v.srcObject = roundStream;
  v.muted = true;
  v.loop = false;
  v.play().catch(() => {});

  document.getElementById("roundCanvas").classList.remove("hidden");
  document.getElementById("roundFlipBtn").classList.remove("hidden");
  document.getElementById("roundPreviewActions").classList.add("hidden");
  document.getElementById("roundRecordBtn").classList.remove("hidden");

  roundDrawing = true;
  roundDrawFrame();
}

async function sendRoundVideo() {
  if (!roundBlob) return;
  const blob = roundBlob;
  closeRoundRecorder();

  const fd = new FormData();
  fd.append("file", blob, "round.webm");
  fd.append("receiver", currentChat);
  fd.append("text", "");
  fd.append("kind", "round");

  toast("Отправка видеосообщения...");
  const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
  const d = await r.json();
  if (!d.ok) {
    if (d.gated) return openContactRequest(currentChat, "");
    alert(d.error || "Ошибка отправки видеосообщения");
  }
}

function resetRoundUI() {
  document.getElementById("roundRecordBtn").classList.remove("hidden");
  document.getElementById("roundStopBtn").classList.add("hidden");
  document.getElementById("roundFlipBtn").classList.remove("hidden");
  document.getElementById("roundTimer").classList.add("hidden");
  document.getElementById("roundTimer").textContent = "00:00";
  document.getElementById("roundPreviewActions").classList.add("hidden");
  document.getElementById("roundCanvas").classList.remove("hidden");
  const v = document.getElementById("roundLiveVideo");
  v.classList.remove("roundpreviewvid");
  v.classList.add("roundsrc");
}

function closeRoundRecorder() {
  document.getElementById("roundRecorderModal").classList.add("hidden");
  clearInterval(roundTimerInterval);
  roundTimerInterval = null;
  roundDrawing = false;
  cancelAnimationFrame(roundDrawRAF);

  if (roundRecorder && roundRecorder.state !== "inactive") {
    try { roundRecorder.stop(); } catch {}
  }
  roundRecorder = null;
  roundChunks = [];
  roundBlob = null;

  if (roundMixedStream) { roundMixedStream.getTracks().forEach((t) => t.stop()); roundMixedStream = null; }
  if (roundStream) { roundStream.getTracks().forEach((t) => t.stop()); roundStream = null; }

  const v = document.getElementById("roundLiveVideo");
  if (v) { v.pause(); v.srcObject = null; v.removeAttribute("src"); v.load(); }
}

function renderRoundBody(m) {
  return `
    <div class="roundmsg" onclick="toggleRoundPlay(this)">
      <video class="roundvid" src="${esc(m.mediaUrl)}" playsinline preload="metadata"
        onended="this.closest('.roundmsg').classList.remove('playing')"></video>
      <div class="roundplay"><i class="fa-solid fa-play"></i></div>
    </div>
  `;
}

function toggleRoundPlay(wrap) {
  const v = wrap.querySelector("video");
  if (!v) return;
  if (v.paused) {
    document.querySelectorAll(".roundvid").forEach((o) => {
      if (o !== v) { o.pause(); o.currentTime = 0; o.closest(".roundmsg")?.classList.remove("playing"); }
    });
    v.play().catch(() => {});
    wrap.classList.add("playing");
  } else {
    v.pause();
    wrap.classList.remove("playing");
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
function attachPickLocation() {
  document.getElementById("attachMenu").classList.add("hidden");
  sendLocation();
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
          <div class="preview">Его/её ещё нет в UzMessenger</div>
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
  return `Я в UzMessenger — общаемся без сим-карты и без слежки за данными. Голосовые, звонки, группы, каналы, сторис — всё в одном месте. Присоединяйся: ${inviteUrl}`;
}

async function inviteToMessenger() {
  const text = buildInviteText();

  if (navigator.share) {
    try {
      await navigator.share({ title: "UzMessenger", text });
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

  const p = await getUserInfo(username, true);
  if (!p.fetched) { alert(t("common.notFound")); return closeProfile(); }

  document.getElementById("profileAvatar").innerHTML = avatarHtml(p);
  document.getElementById("profileName").innerHTML = nameHtml(p, { noBday: true });
  document.getElementById("profileLastSeen").textContent = lastSeenText(p);
  applyProfileHeader(document.querySelector("#profileModal .tghead"), p);

  // круглые кнопки действий — как в Телеграме
  const acts = [];
  if (p.blocked) {
    acts.push(actionBtn("fa-ban", t("profile.blocked"), `void 0`, "act-blue"));
  } else if (p.dmGated && !p.canMessage) {
    acts.push(actionBtn("fa-envelope", t("profile.request"), `closeProfile(); openContactRequest('${esc(p.username)}', '')`, "act-blue"));
  } else {
    acts.push(actionBtn("fa-comment", t("profile.write"), `closeProfile(); openChat('${esc(p.username)}')`, "act-blue"));
    acts.push(actionBtn("fa-phone", t("call.audioCall"), `closeProfile(); callFromProfile('${esc(p.username)}')`, "act-green"));
    acts.push(actionBtn("fa-gift", t("profile.gift"), `openGiftPicker('${esc(p.username)}')`, "act-pink"));
  }
  if (p.birthdayToday) acts.push(actionBtn("fa-cake-candles", t("profile.congratulate"), `closeProfile(); congratulate('${esc(p.username)}')`, "act-orange"));
  if (!p.blocked) acts.push(actionBtn("fa-user-plus", t("profile.addFriend"), `addFriendByName('${esc(p.username)}')`, "act-violet"));
  if (!p.blocked) acts.push(actionBtn("fa-address-book", t("contact.action"), `openSaveContactModal('${esc(p.username)}')`, "act-blue"));
  if (p.iBlockedThem) {
    acts.push(actionBtn("fa-user-check", t("settings.unblockBtn"), `unblockFromProfile('${esc(p.username)}')`, "act-orange"));
  } else {
    acts.push(actionBtn("fa-user-slash", t("settings.blockBtn"), `blockFromProfile('${esc(p.username)}')`, "act-orange"));
  }
  document.getElementById("profileActions").innerHTML = acts.join("");

  const rows = [];
  rows.push(infoRow("юзернейм", `<span class="tglink">@${esc(p.username)}</span>`));
  if (p.bio) rows.push(infoRow("о себе", esc(p.bio)));
  if (p.verified) rows.push(infoRow("статус", `<span class="tgverified"><i class="fa-solid fa-circle-check"></i> Официально подтверждён</span>`));
  if (p.birthdayToday) rows.push(infoRow("день рождения", "🎂 Сегодня!"));
  document.getElementById("profileInfo").innerHTML =
    `<div class="tgcard">${rows.join("")}</div><div class="tgcard giftcard"><div class="tgcardtitle">Подарки</div><div id="profileGiftsRow" class="gifts-row"></div></div>`;

  await loadGifts(username, "profileGiftsRow");
  await loadUserStoriesIntoProfile(username);
}

async function blockFromProfile(username) {
  if (!confirm(`Заблокировать @${username}? Переписка и звонки станут недоступны.`)) return;
  const r = await fetch("/api/me/blocked", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast("Пользователь заблокирован");
  userInfoCache.delete(username);
  openProfile(username, false);
}

async function unblockFromProfile(username) {
  await fetch(`/api/me/blocked/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() });
  toast("Пользователь разблокирован");
  userInfoCache.delete(username);
  openProfile(username, false);
}

// кнопка-кружок с подписью
function actionBtn(icon, label, onclick, cls) {
  return `<button class="tgact ${cls || ""}" onclick="${onclick}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;
}
// строка «подпись + значение» в карточке
function infoRow(label, valueHtml) {
  return `<div class="tgrow"><div class="tglabel">${label}</div><div class="tgvalue">${valueHtml}</div></div>`;
}

async function callFromProfile(username) {
  await openChat(username);
  startAudioCall();
}

async function addFriendByName(username) {
  const r = await fetch("/api/friends", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast(`@${username} добавлен(а) в друзья ✅`);
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
function toggleSettingsCategory(btn) {
  const cat = btn.closest(".settingscategory");
  if (!cat) return;
  cat.classList.toggle("open");
}

function openSettings() {
  document.getElementById("setDisplayName").value = me.displayName || "";
  document.getElementById("setBio").value = me.bio || "";
  document.getElementById("setBirthDate").value = me.birthDate || "";
  document.getElementById("setAvatarUrl").value = me.avatarUrl || "";

  renderPasscodeSection();
  render2FASection();
  renderWallpaperSection();
  renderProfileHeaderSection();
  renderEmojiStatusSection();
  renderLanguageSection();
  renderPrivacySection();
  renderFriendsSection();
  renderBlacklistSection();
  renderContactsSection();
  renderUsernameSection();
  renderGoogleSection();
  renderVerificationSection();
  renderSessionsSection();
  renderLegalSection();
  renderDeleteAccountSection();
}

// ---------------- SESSIONS ----------------
async function renderSessionsSection() {
  const box = document.getElementById("sessionsSection");
  box.innerHTML = `<div class="hint">${t("common.loading")}</div>`;

  const r = await fetch("/api/me/sessions", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok || d.sessions.length === 0) { box.innerHTML = `<div class="hint">${t("sessions.empty")}</div>`; return; }

  const localeMap = { ru: "ru-RU", uz: "uz-UZ", en: "en-US" };
  box.innerHTML = d.sessions.map(s => `
    <div class="memberrow">
      <div class="meta">
        <div class="name">${new Date(s.createdAt).toLocaleString(localeMap[currentLang] || "ru-RU")} ${s.current ? `<span class="hint">(${t("sessions.thisDevice")})</span>` : ""}</div>
        <div class="preview">${esc(s.ip || t("sessions.ipUnknown"))} · ${esc(shortenUA(s.userAgent))}</div>
      </div>
      ${!s.current ? `<button class="iconbtn danger" onclick="endSession(${s.id})" title="${t("sessions.endSession")}"><i class="fa-solid fa-power-off"></i></button>` : ""}
    </div>
  `).join("");
}
async function endSession(id) {
  if (!confirm(t("sessions.confirmEnd"))) return;
  const r = await fetch(`/api/me/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("common.error"));
  toast(t("sessions.ended"));
  renderSessionsSection();
}
function shortenUA(ua) {
  if (!ua) return t("sessions.unknownDevice");
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
  const birthdayPrivacy = s.birthdayPrivacy || "everyone";
  const photoPrivacy = s.photoPrivacy || "everyone";
  const forwardPrivacy = s.forwardPrivacy || "everyone";
  const callsPrivacy = s.callsPrivacy || "everyone";
  const giftsPrivacy = s.giftsPrivacy || "everyone";

  const opt = (value, current) => `<option value="${value}" ${value === current ? "selected" : ""}>${
    value === "everyone" ? t("privacy.everyone") : value === "friends" ? t("privacy.friendsOnly") : t("privacy.nobody")
  }</option>`;
  const row = (id, label, current) => `
    <label>${label}</label>
    <select id="${id}" onchange="savePrivacy()">
      ${opt("everyone", current)}${opt("friends", current)}${opt("nobody", current)}
    </select>
  `;

  box.innerHTML = `
    ${row("privStoryPrivacy", t("privacy.stories"), storyPrivacy)}
    ${row("privBioPrivacy", t("privacy.bio"), bioPrivacy)}
    ${row("privLastSeenPrivacy", t("privacy.lastSeen"), lastSeenPrivacy)}
    ${row("privBirthdayPrivacy", t("privacy.birthday"), birthdayPrivacy)}
    ${row("privPhotoPrivacy", t("privacy.photo"), photoPrivacy)}
    ${row("privForwardPrivacy", t("privacy.forward"), forwardPrivacy)}
    ${row("privCallsPrivacy", t("privacy.calls"), callsPrivacy)}
    ${row("privGiftsPrivacy", t("privacy.gifts"), giftsPrivacy)}
    <div class="hint">${t("privacy.hint")}</div>
  `;
}

async function savePrivacy() {
  const storyPrivacy = document.getElementById("privStoryPrivacy").value;
  const bioPrivacy = document.getElementById("privBioPrivacy").value;
  const lastSeenPrivacy = document.getElementById("privLastSeenPrivacy").value;
  const birthdayPrivacy = document.getElementById("privBirthdayPrivacy").value;
  const photoPrivacy = document.getElementById("privPhotoPrivacy").value;
  const forwardPrivacy = document.getElementById("privForwardPrivacy").value;
  const callsPrivacy = document.getElementById("privCallsPrivacy").value;
  const giftsPrivacy = document.getElementById("privGiftsPrivacy").value;
  const d = await saveSettingsPatch({
    storyPrivacy, bioPrivacy, lastSeenPrivacy,
    birthdayPrivacy, photoPrivacy, forwardPrivacy, callsPrivacy, giftsPrivacy
  });
  if (d && d.ok) toast("Приватность обновлена ✅");
}

// ---------------- FRIENDS ----------------
async function renderFriendsSection() {
  const box = document.getElementById("friendsSection");
  box.innerHTML = `
    <div class="row">
      <input id="addFriendInput" placeholder="@username">
      <button class="btn ghost" onclick="addFriend()">${t("settings.add")}</button>
    </div>
    <div id="friendsList" class="hint">${t("common.loading")}</div>
  `;

  const r = await fetch("/api/friends", { headers: authHeaders() });
  const d = await r.json();
  const list = document.getElementById("friendsList");
  if (!d.ok || d.friends.length === 0) { list.innerHTML = `<div class="hint">${t("settings.emptyFriends")}</div>`; return; }

  list.innerHTML = d.friends.map(f => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml(f)}</div>
      <div class="meta">
        <div class="name">${nameHtml(f)}</div>
        <div class="preview">@${esc(f.username)}</div>
      </div>
      <button class="iconbtn" onclick="removeFriend('${esc(f.username)}')" title="${t("settings.removeBtn")}"><i class="fa-solid fa-user-minus"></i></button>
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
  if (!d.ok) return alert(d.error || t("common.error"));
  renderFriendsSection();
}

async function removeFriend(username) {
  await fetch(`/api/friends/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() });
  renderFriendsSection();
}

// ---------------- ЛИЧНЫЕ КОНТАКТЫ (свой ярлык на юзернейм, как в телефонной книге) ----------------
async function renderContactsSection() {
  const box = document.getElementById("contactsSection");
  if (!box) return;
  box.innerHTML = `<div class="hint">${t("common.loading")}</div>`;

  const r = await fetch("/api/contacts", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok || d.contacts.length === 0) {
    box.innerHTML = `<div class="hint">${t("contact.empty")}</div>`;
    return;
  }

  box.innerHTML = d.contacts.map(c => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml(c)}</div>
      <div class="meta">
        <div class="name">${esc(c.contactName)}</div>
        <div class="preview">@${esc(c.username)}${c.note ? " · " + esc(c.note) : ""}</div>
      </div>
      <button class="iconbtn" onclick="openSaveContactModal('${esc(c.username)}','${esc(c.contactName).replace(/'/g, "&#39;")}','${esc(c.note).replace(/'/g, "&#39;")}')" title="${t("common.edit")}"><i class="fa-solid fa-pen"></i></button>
      <button class="iconbtn" onclick="deleteContact('${esc(c.username)}')" title="${t("common.delete")}"><i class="fa-solid fa-trash"></i></button>
    </div>
  `).join("");
}

function openSaveContactModal(username, name, note) {
  document.getElementById("saveContactUsername").value = username;
  document.getElementById("saveContactUsernameLabel").textContent = "@" + username;
  document.getElementById("saveContactName").value = name || "";
  document.getElementById("saveContactNote").value = note || "";
  document.getElementById("saveContactModal").classList.remove("hidden");
}
function closeSaveContactModal() {
  document.getElementById("saveContactModal").classList.add("hidden");
}
async function submitSaveContact() {
  const username = document.getElementById("saveContactUsername").value;
  const name = document.getElementById("saveContactName").value.trim();
  const note = document.getElementById("saveContactNote").value.trim();
  if (!name) return alert(t("contact.needName"));

  const r = await fetch("/api/contacts", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username, name, note })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("common.error"));

  closeSaveContactModal();
  toast(`${t("contact.name")} «${name}» ${t("contact.saved")} ✅`);
  renderContactsSection();
}
async function deleteContact(username) {
  if (!confirm(t("contact.confirmDelete"))) return;
  await fetch(`/api/contacts/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() });
  renderContactsSection();
}

// ---------------- ПОЛИТИКА ИСПОЛЬЗОВАНИЯ / КОНФИДЕНЦИАЛЬНОСТИ ----------------
const LEGAL_TEXT = {
  ru: {
    terms: `Условия использования UzMessenger

1. Общие положения
UzMessenger — мессенджер для обмена сообщениями, звонков и медиа. Регистрируясь, ты подтверждаешь, что тебе не менее 13 лет и ты принимаешь эти условия.

2. Аккаунт
Юзернейм и пароль придумываешь сам(а). Ты несёшь ответственность за сохранность пароля и за всё, что происходит через твой аккаунт. Рекомендуем включить двухфакторную аутентификацию в Настройках.

3. Правила поведения
Запрещены: спам и массовая рассылка нежелательных сообщений, угрозы и травля, публикация незаконного контента, выдача себя за другого человека, попытки взлома сервиса. За нарушение администрация вправе удалить контент, ограничить (мут) или заблокировать (бан) аккаунт без предупреждения.

4. Разрешения устройства
Приложение может запрашивать доступ к камере и микрофону — для фото/видео-сообщений, круглых видеосообщений и аудио/видеозвонков; к уведомлениям — чтобы присылать пуш-уведомления о новых сообщениях и входящих звонках (по аналогии с экраном входящего вызова, как в FaceTime); к геолокации — только когда ты сам(а) решаешь отправить точку на карте. Ничего из этого не включается без действия, инициированного тобой, и ты в любой момент можешь отозвать разрешения в настройках браузера/устройства.

5. Контент
Ты сохраняешь права на публикуемый контент, но несёшь за него полную ответственность. Администрация может удалить отдельное сообщение или весь аккаунт при нарушении правил.

6. Ограничение ответственности
Сервис предоставляется «как есть». Мы стараемся обеспечивать стабильную работу, но не гарантируем отсутствие сбоев или потери данных.

7. Изменения условий
Мы можем обновлять эти условия. О существенных изменениях сообщим через уведомление в приложении.

8. Контакты
По любым вопросам — через раздел «Поддержка» внутри приложения.`,
    privacy: `Политика конфиденциальности UzMessenger

1. Какие данные мы собираем
Юзернейм, отображаемое имя, био, дата рождения (опционально), аватар; текст и медиа (фото, видео, голосовые, файлы, геометки) отправляемых сообщений; служебные данные — время отправки/прочтения, IP-адрес и user-agent сессий входа (для защиты аккаунта).

2. Как мы используем данные
Для работы функций мессенджера (доставка сообщений, звонки, уведомления, сторис), для защиты аккаунта от несанкционированного доступа и для ответа на обращения в поддержку.

3. Хранение медиа
Фото, видео и голосовые сообщения хранятся на сервере и доступны только участникам переписки.

4. Доступ администрации
Модераторы не могут открыть профиль или переписку пользователя без отдельного, дополнительного кода подтверждения — обычного входа в панель администратора для этого недостаточно.

5. Передача третьим лицам
Мы не продаём и не передаём твои данные третьим лицам, за исключением случаев, прямо предусмотренных законом.

6. Твои права
В любой момент можно скачать список своих данных через поддержку или полностью удалить аккаунт со всеми данными — Настройки → Аккаунт → Удалить аккаунт. Удаление необратимо.

7. Безопасность
Пароли хранятся в хэшированном виде (bcrypt), доступна двухфакторная аутентификация (TOTP).

8. Возрастные ограничения
Сервисом могут пользоваться лица не младше 13 лет либо старше возраста, установленного законодательством страны проживания.

9. Изменения политики
Мы можем обновлять эту политику. О существенных изменениях сообщим через уведомление в приложении.

10. Контакты
По вопросам, связанным с персональными данными — через раздел «Поддержка» внутри приложения.`
  },
  uz: {
    terms: `UzMessenger foydalanish shartlari

1. Umumiy qoidalar
UzMessenger — xabar almashish, qo'ng'iroqlar va media uchun messenjer. Ro'yxatdan o'tish orqali siz kamida 13 yoshda ekaningizni va ushbu shartlarni qabul qilishingizni tasdiqlaysiz.

2. Hisob
Foydalanuvchi nomi va parolni o'zingiz tanlaysiz. Parolning xavfsizligi va hisobingiz orqali sodir bo'ladigan barcha harakatlar uchun javobgarlik sizda. Sozlamalarda ikki bosqichli autentifikatsiyani yoqishni tavsiya qilamiz.

3. Xatti-harakat qoidalari
Taqiqlangan: spam va keraksiz xabarlar yuborish, tahdid va bezorilik, noqonuniy kontent joylashtirish, boshqa shaxs sifatida ko'rinish, xizmatni buzishga urinish. Qoidabuzarlik uchun administratsiya ogohlantirishsiz kontentni o'chirish, hisobni cheklash (mute) yoki bloklash (ban) huquqiga ega.

4. Qurilma ruxsatlari
Ilova kamera va mikrofonga kirishni so'rashi mumkin — foto/video xabarlar, doira shaklidagi video xabarlar hamda audio/video qo'ng'iroqlar uchun; bildirishnomalarga — yangi xabarlar va kiruvchi qo'ng'iroqlar haqida push-bildirishnoma yuborish uchun (FaceTime kabi kiruvchi qo'ng'iroq ekraniga o'xshash); geolokatsiyaga — faqat siz xaritada nuqta yuborishga qaror qilganingizda. Bularning hech biri sizning bevosita amalingizsiz yoqilmaydi va istalgan vaqtda brauzer/qurilma sozlamalarida ruxsatlarni bekor qilishingiz mumkin.

5. Kontent
Siz joylashtirgan kontentga bo'lgan huquqlaringiz sizda qoladi, ammo unga to'liq javobgarlik ham sizda. Administratsiya qoidabuzarlik yuz berganda alohida xabarni yoki butun hisobni o'chirishi mumkin.

6. Javobgarlikni cheklash
Xizmat "bor holicha" taqdim etiladi. Biz barqaror ishlashga harakat qilamiz, biroq nosozliklar yoki ma'lumot yo'qolishining oldini to'liq kafolatlay olmaymiz.

7. Shartlardagi o'zgarishlar
Biz ushbu shartlarni yangilashimiz mumkin. Muhim o'zgarishlar haqida ilova ichida bildirishnoma orqali xabar beramiz.

8. Aloqa
Har qanday savol bo'yicha — ilovadagi «Qo'llab-quvvatlash» bo'limi orqali.`,
    privacy: `UzMessenger maxfiylik siyosati

1. Biz qanday ma'lumotlarni to'playmiz
Foydalanuvchi nomi, ko'rsatiladigan ism, bio, tug'ilgan sana (ixtiyoriy), avatar; yuborilgan xabarlarning matni va mediasi (foto, video, ovozli xabarlar, fayllar, geometkalar); xizmat ma'lumotlari — yuborilgan/o'qilgan vaqti, kirish seanslarining IP-manzili va user-agent (hisobni himoya qilish uchun).

2. Ma'lumotlardan qanday foydalanamiz
Messenjer funksiyalarining ishlashi (xabarlarni yetkazish, qo'ng'iroqlar, bildirishnomalar, hikoyalar) uchun, hisobni ruxsatsiz kirishdan himoya qilish va qo'llab-quvvatlash xizmatiga javob berish uchun.

3. Media saqlash
Foto, video va ovozli xabarlar serverda saqlanadi va faqat yozishma ishtirokchilariga ochiq.

4. Administratsiya kirishi
Moderatorlar alohida, qo'shimcha tasdiqlash kodisiz foydalanuvchi profili yoki yozishmasini ocha olmaydi — administrator panelga oddiy kirish buning uchun yetarli emas.

5. Uchinchi shaxslarga uzatish
Biz sizning ma'lumotlaringizni sotmaymiz va qonun tomonidan aniq belgilangan holatlar bundan mustasno, uchinchi shaxslarga uzatmaymiz.

6. Sizning huquqlaringiz
Istalgan vaqtda qo'llab-quvvatlash orqali o'z ma'lumotlaringiz ro'yxatini so'rashingiz yoki hisobingizni barcha ma'lumotlar bilan butunlay o'chirishingiz mumkin — Sozlamalar → Hisob → Hisobni o'chirish. O'chirish qaytarib bo'lmaydi.

7. Xavfsizlik
Parollar xeshlangan holda saqlanadi (bcrypt), ikki bosqichli autentifikatsiya (TOTP) mavjud.

8. Yosh cheklovi
Xizmatdan kamida 13 yoshli yoki yashash mamlakati qonunchiligida belgilangan yoshdan katta shaxslar foydalanishi mumkin.

9. Siyosatdagi o'zgarishlar
Biz ushbu siyosatni yangilashimiz mumkin. Muhim o'zgarishlar haqida ilova ichida bildirishnoma orqali xabar beramiz.

10. Aloqa
Shaxsiy ma'lumotlar bilan bog'liq savollar bo'yicha — ilovadagi «Qo'llab-quvvatlash» bo'limi orqali.`
  },
  en: {
    terms: `UzMessenger Terms of Use

1. General
UzMessenger is a messenger app for chatting, calls and media sharing. By registering, you confirm you are at least 13 years old and accept these terms.

2. Account
You choose your own username and password. You are responsible for keeping your password safe and for everything that happens through your account. We recommend enabling two-factor authentication in Settings.

3. Rules of conduct
Prohibited: spam and mass unwanted messaging, threats and harassment, posting illegal content, impersonating another person, attempting to hack the service. For violations, the administration may remove content, restrict (mute) or block (ban) an account without prior notice.

4. Device permissions
The app may request access to the camera and microphone — for photo/video messages, round video messages and audio/video calls; to notifications — to send push notifications about new messages and incoming calls (similar to an incoming-call screen, like FaceTime); to location — only when you choose to send a location pin. None of this is enabled without an action initiated by you, and you can revoke permissions at any time in your browser/device settings.

5. Content
You retain rights to the content you post, but you are fully responsible for it. The administration may remove an individual message or an entire account for rule violations.

6. Limitation of liability
The service is provided "as is". We strive for stable operation but do not guarantee against outages or data loss.

7. Changes to these terms
We may update these terms. We'll notify you of significant changes via an in-app notification.

8. Contact
For any questions — via the "Support" section inside the app.`,
    privacy: `UzMessenger Privacy Policy

1. What data we collect
Username, display name, bio, birth date (optional), avatar; the text and media (photos, videos, voice messages, files, location pins) of messages you send; service data — send/read timestamps, IP address and user-agent of login sessions (for account security).

2. How we use your data
To operate the messenger's features (delivering messages, calls, notifications, stories), to protect your account from unauthorized access, and to respond to support requests.

3. Media storage
Photos, videos and voice messages are stored on the server and are only accessible to the participants of that conversation.

4. Administration access
Moderators cannot open a user's profile or conversation without a separate, additional confirmation code — a regular login to the admin panel is not enough.

5. Sharing with third parties
We do not sell or share your data with third parties, except where explicitly required by law.

6. Your rights
At any time you can request a list of your data via Support, or permanently delete your account along with all data — Settings → Account → Delete account. Deletion is irreversible.

7. Security
Passwords are stored hashed (bcrypt); two-factor authentication (TOTP) is available.

8. Age restriction
The service may be used by individuals at least 13 years old, or older where required by the laws of their country of residence.

9. Changes to this policy
We may update this policy. We'll notify you of significant changes via an in-app notification.

10. Contact
For questions related to personal data — via the "Support" section inside the app.`
  }
};

let legalLang = localStorage.getItem("legalLang") || currentLang || "ru";
let legalTab = "terms";

function renderLegalSection() {
  const box = document.getElementById("legalSection");
  if (!box) return;
  const accepted = !!(me && me.tosAcceptedAt);
  const localeMap = { ru: "ru-RU", uz: "uz-UZ", en: "en-US" };
  box.innerHTML = `
    <div class="row">
      <button class="btn ghost full" onclick="openLegalModal('terms')">${t("legal.tabTerms")}</button>
    </div>
    <div class="row">
      <button class="btn ghost full" onclick="openLegalModal('privacy')">${t("legal.tabPrivacy")}</button>
    </div>
    ${accepted
      ? `<div class="hint">✅ ${t("legal.accepted")} ${new Date(me.tosAcceptedAt).toLocaleDateString(localeMap[currentLang] || "ru-RU")}</div>`
      : `<div class="hint" style="color:#ff8a3d">⚠️ ${t("legal.notAccepted")}</div>
         <button class="btn primary full" onclick="acceptTerms()">${t("legal.accept")}</button>`}
  `;
}
function openLegalModal(tab) {
  legalTab = tab || "terms";
  legalLang = currentLang || legalLang || "ru";
  renderLegalBody();
  document.getElementById("legalModal").classList.remove("hidden");
}
function closeLegalModal() {
  document.getElementById("legalModal").classList.add("hidden");
}
function switchLegalTab(tab) {
  legalTab = tab;
  renderLegalBody();
}
function switchLegalLang(lang) {
  legalLang = lang;
  localStorage.setItem("legalLang", lang);
  renderLegalBody();
}
function renderLegalBody() {
  const lt = LEGAL_TEXT[legalLang] || LEGAL_TEXT.ru;
  document.getElementById("legalTermsBody").textContent = lt.terms;
  document.getElementById("legalPrivacyBody").textContent = lt.privacy;
  document.getElementById("legalTabTerms").classList.toggle("active", legalTab === "terms");
  document.getElementById("legalTabPrivacy").classList.toggle("active", legalTab === "privacy");
  document.getElementById("legalTermsBody").classList.toggle("hidden", legalTab !== "terms");
  document.getElementById("legalPrivacyBody").classList.toggle("hidden", legalTab !== "privacy");
  const ruBtn = document.getElementById("legalLangRu");
  const uzBtn = document.getElementById("legalLangUz");
  const enBtn = document.getElementById("legalLangEn");
  if (ruBtn) ruBtn.classList.toggle("active", legalLang === "ru");
  if (uzBtn) uzBtn.classList.toggle("active", legalLang === "uz");
  if (enBtn) enBtn.classList.toggle("active", legalLang === "en");
}
async function acceptTerms() {
  const r = await fetch("/api/me/accept-terms", { method: "POST", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("common.error"));
  me.tosAcceptedAt = d.tosAcceptedAt;
  toast(t("legal.acceptedToast"));
  renderLegalSection();
}

// ---------------- ЧЁРНЫЙ СПИСОК ----------------
async function renderBlacklistSection() {
  const box = document.getElementById("blacklistSection");
  if (!box) return;
  box.innerHTML = `
    <div class="row">
      <input id="addBlockedInput" placeholder="@username">
      <button class="btn ghost" onclick="addToBlacklist()">${t("settings.blockBtn")}</button>
    </div>
    <div id="blockedList" class="hint">${t("common.loading")}</div>
  `;

  const r = await fetch("/api/me/blocked", { headers: authHeaders() });
  const d = await r.json();
  const list = document.getElementById("blockedList");
  if (!d.ok || d.blocked.length === 0) { list.innerHTML = `<div class="hint">${t("settings.emptyBlacklist")}</div>`; return; }

  list.innerHTML = d.blocked.map(f => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml(f)}</div>
      <div class="meta">
        <div class="name">${nameHtml(f)}</div>
        <div class="preview">@${esc(f.username)}</div>
      </div>
      <button class="iconbtn" onclick="removeFromBlacklist('${esc(f.username)}')" title="${t("settings.unblockBtn")}"><i class="fa-solid fa-user-check"></i></button>
    </div>
  `).join("");
}

async function addToBlacklist() {
  const username = document.getElementById("addBlockedInput").value.trim().replace(/^@+/, "");
  if (!username) return;
  const r = await fetch("/api/me/blocked", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("common.error"));
  renderBlacklistSection();
  renderFriendsSection();
}

async function removeFromBlacklist(username) {
  await fetch(`/api/me/blocked/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() });
  renderBlacklistSection();
}

// ---------------- СМЕНА ЮЗЕРНЕЙМА ----------------
function renderUsernameSection() {
  const box = document.getElementById("usernameSection");
  if (!box) return;
  box.innerHTML = `
    <div class="hint">${t("username.current")}: @${esc(me.username)}</div>
    <label>${t("username.new")}</label>
    <input id="newUsernameInput" placeholder="new_username">
    <label>${t("username.passwordConfirm")}</label>
    <input id="usernameChangePassword" type="password">
    <button class="btn ghost full" onclick="changeUsername()">${t("username.changeBtn")}</button>
  `;
}

async function changeUsername() {
  const username = document.getElementById("newUsernameInput").value.trim().replace(/^@+/, "").toLowerCase();
  const password = document.getElementById("usernameChangePassword").value;
  if (!username || !password) return alert(t("username.fillBoth"));

  const r = await fetch("/api/me/username", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("username.changeError"));

  if (d.token) localStorage.setItem("token", d.token);
  me = { ...me, ...d.profile };
  toast(t("username.changed") + " @" + me.username + " ✅");
  renderUsernameSection();
  updateHeader();
  location.reload();
}

// ---------------- GOOGLE-АККАУНТ (привязка к уже существующему аккаунту) ----------------
async function renderGoogleSection() {
  const box = document.getElementById("googleSection");
  if (!box) return;

  const r = await fetch("/api/me/google", { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) { box.innerHTML = `<div class="hint">${t("google.loadFailed")}</div>`; return; }

  if (d.linked) {
    box.innerHTML = `
      <div class="hint">${t("google.linkedAs")}: ${esc(d.email)}</div>
      <button class="btn ghost full" onclick="unlinkGoogle()"><i class="fa-brands fa-google"></i> ${t("google.unlink")}</button>
    `;
    return;
  }

  box.innerHTML = `
    <div class="hint">${t("google.linkHint")} @${esc(me.username)} ${t("google.viaGoogle")}</div>
    <div id="googleLinkBtn"></div>
  `;

  const waitGoogle = setInterval(() => {
    if (!(window.google && window.google.accounts)) return;
    clearInterval(waitGoogle);
    initGoogleLinkButton();
  }, 100);
}

async function initGoogleLinkButton() {
  const r = await fetch("/api/oauth/google-client-id");
  const d = await r.json();
  const container = document.getElementById("googleLinkBtn");
  if (!container) return;
  if (!d.ok || !d.clientId) { container.innerHTML = `<div class="hint">${t("google.notConfigured")}</div>`; return; }

  google.accounts.id.initialize({ client_id: d.clientId, callback: onGoogleLinkCredential });
  google.accounts.id.renderButton(container, { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 260 });
}

async function onGoogleLinkCredential(response) {
  const r = await fetch("/api/me/google", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ credential: response.credential })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("google.linkFailed"));
  toast(t("google.linked"));
  renderGoogleSection();
}

async function unlinkGoogle() {
  if (!confirm(t("google.confirmUnlink"))) return;
  await fetch("/api/me/google", { method: "DELETE", headers: authHeaders() });
  toast(t("google.unlinked"));
  renderGoogleSection();
}

// ---------------- DELETE ACCOUNT ----------------
function renderDeleteAccountSection() {
  const box = document.getElementById("deleteAccountSection");
  box.innerHTML = `<button class="btn small-link" onclick="revealDeleteAccountForm()">${t("deleteAcc.deleteBtn")}</button>`;
}

function revealDeleteAccountForm() {
  const box = document.getElementById("deleteAccountSection");
  box.innerHTML = `
    <div class="hint">${t("deleteAcc.warning")}</div>
    <label>${t("deleteAcc.password")}</label>
    <input id="deleteAccountPassword" type="password">
    <button class="btn danger full" onclick="confirmDeleteAccount()">${t("deleteAcc.confirmBtn")}</button>
    <button class="btn ghost full" onclick="renderDeleteAccountSection()">${t("common.cancel")}</button>
  `;
}

async function confirmDeleteAccount() {
  const password = document.getElementById("deleteAccountPassword").value;
  if (!password) return alert(t("deleteAcc.enterPassword"));
  if (!confirm(t("deleteAcc.confirmFinal"))) return;

  const r = await fetch("/api/me", {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("deleteAcc.deleteError"));

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

// ---------------- ШАПКА ПРОФИЛЯ: настройки ----------------
const HEADER_COLOR_PRESETS = ["#6a5cff", "#4b8bff", "#2a9df4", "#29d17d", "#ff8a3d", "#ff4d9d", "#a06bff", "#f5c542", "#00c2c7", "#ff5c5c", "#0e1621", "#7c8cff"];
const HEADER_PATTERN_PRESETS = [
  { e: "", label: "Точки (по умолчанию)" },
  { e: "⭐", label: "Звёзды" },
  { e: "✨", label: "Блёстки" },
  { e: "❤️", label: "Сердца" },
  { e: "🔥", label: "Огонь" },
  { e: "🌙", label: "Луна" },
  { e: "🍀", label: "Клевер" },
  { e: "🎉", label: "Конфетти" },
  { e: "💎", label: "Кристаллы" },
  { e: "⚡", label: "Молнии" }
];
function renderProfileHeaderSection() {
  const box = document.getElementById("profileHeaderSection");
  if (!box) return;
  const s = (me.settings || {});
  const top = s.headerTop || "#6a5cff";
  const bottom = s.headerBottom || "#2a9df4";
  const pattern = s.headerPattern || "";

  box.innerHTML = `
    <div class="hint">${t("settings.headerHint")}</div>
    <div class="hdpreview" id="hdPreviewBox"></div>

    <label>${t("settings.headerTop")}</label>
    <div class="swatchrow">
      ${HEADER_COLOR_PRESETS.map(c => `
        <button class="colorswatch ${top === c ? "active" : ""}" style="background:${c}" onclick="pickHeaderColor('top','${c}')"></button>
      `).join("")}
    </div>

    <label>${t("settings.headerBottom")}</label>
    <div class="swatchrow">
      ${HEADER_COLOR_PRESETS.map(c => `
        <button class="colorswatch ${bottom === c ? "active" : ""}" style="background:${c}" onclick="pickHeaderColor('bottom','${c}')"></button>
      `).join("")}
    </div>

    <label>${t("settings.headerPattern")}</label>
    <div class="statusgrid">
      ${HEADER_PATTERN_PRESETS.map(p => `
        <button class="statusbtn ${pattern === p.e ? "active" : ""}" title="${esc(p.label)}" onclick="pickHeaderPattern('${esc(p.e)}')">${p.e || '<i class="fa-solid fa-ellipsis"></i>'}</button>
      `).join("")}
    </div>
    <div class="row">
      <input id="customHeaderPatternInput" maxlength="4" placeholder="${t("settings.customEmoji")}">
      <button class="btn ghost" onclick="pickHeaderPattern(document.getElementById('customHeaderPatternInput').value)">${t("settings.set")}</button>
    </div>
  `;
  applyProfileHeader(document.getElementById("hdPreviewBox"), { headerTop: top, headerBottom: bottom, headerPattern: pattern });
}
async function pickHeaderColor(which, color) {
  await saveSettingsPatch(which === "top" ? { headerTop: color } : { headerBottom: color });
  renderProfileHeaderSection();
}
async function pickHeaderPattern(e) {
  const d = await saveSettingsPatch({ headerPattern: e || "" });
  if (d && d.ok) toast(e ? `${t("settings.headerPattern")}: ${e}` : t("settings.patternReset"));
  renderProfileHeaderSection();
}

// ---------------- ЭМОДЗИ-СТАТУС (значок рядом с именем) ----------------
function renderEmojiStatusSection() {
  const box = document.getElementById("emojiStatusSection");
  if (!box) return;
  const cur = (me.settings || {}).emojiStatus || "";
  box.innerHTML = `
    <div class="hint">${t("settings.emojiStatusHint")}</div>
    <div class="statusgrid">
      <button class="statusbtn ${!cur ? "active" : ""}" onclick="pickEmojiStatus('')" title="${t("settings.noStatus")}"><i class="fa-solid fa-ban"></i></button>
      ${STATUS_EMOJIS.map(e => `<button class="statusbtn ${cur === e ? "active" : ""}" onclick="pickEmojiStatus('${e}')">${e}</button>`).join("")}
    </div>
    <div class="row">
      <input id="customStatusInput" maxlength="8" placeholder="${t("settings.customEmoji")}" value="${esc(cur)}">
      <button class="btn ghost" onclick="pickEmojiStatus(document.getElementById('customStatusInput').value)">${t("settings.set")}</button>
    </div>
  `;
}
async function pickEmojiStatus(e) {
  const d = await saveSettingsPatch({ emojiStatus: e });
  if (d && d.ok) toast(e ? `${t("settings.statusSetPrefix")} ${e}` : t("settings.statusRemoved"));
  renderEmojiStatusSection();
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
      <div class="hint">${t("twofa.enabled")} ✅</div>
      <label>${t("twofa.passwordToDisable")}</label>
      <input id="disable2FAPassword" type="password">
      <button class="btn danger full" onclick="disable2FA()">${t("twofa.disableBtn")}</button>
    `;
  } else {
    box.innerHTML = `
      <div class="hint">${t("twofa.hint")}</div>
      <button class="btn primary full" onclick="start2FASetup()">${t("twofa.enableBtn")}</button>
      <div id="twoFASetupBox"></div>
    `;
  }
}

async function start2FASetup() {
  const r = await fetch("/api/2fa/setup", { method: "POST", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || t("common.error"));

  const box = document.getElementById("twoFASetupBox");
  box.innerHTML = `
    <div class="hint">${t("twofa.scanHint")}</div>
    <div id="totpQr" class="totpqr"></div>
    <div class="totpsecret">${esc(d.secret)}</div>
    <label>${t("twofa.codeFromApp")}</label>
    <input id="confirm2FACode" inputmode="numeric" maxlength="6" placeholder="000000">
    <button class="btn primary full" onclick="confirm2FASetup()">${t("twofa.confirmBtn")}</button>
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
  if (!d.ok) return alert(d.error || t("twofa.badCode"));

  me.totpEnabled = true;
  toast(t("twofa.enabledToast"));
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
  if (!d.ok) return alert(d.error || t("common.error"));

  me.totpEnabled = false;
  toast(t("twofa.disabledToast"));
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
      <div class="hint">Когда включено, человек увидит «Этот аккаунт официально подтверждён» и сможет отправить заявку. Сначала её проверит администрация, а потом ты сам(а) решишь — «Принять» или «Отклонить» (кнопки появятся вверху списка чатов). Люди из исключений и те, кому ты уже писал(а) сам(а), пишут напрямую.</div>
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

  document.getElementById("myProfileAvatar").innerHTML = avatarHtml(card);
  document.getElementById("myProfileName").innerHTML = nameHtml(card);
  document.getElementById("myProfileStatus").textContent = "в сети";
  applyProfileHeader(document.querySelector("#screenProfile .tghead"), card);

  document.getElementById("myProfileActions").innerHTML = [
    actionBtn("fa-camera", "История", "openStoryComposer()", "act-blue"),
    actionBtn("fa-pen", "Изменить", "switchTab('settings')", "act-violet"),
    actionBtn("fa-bookmark", "Избранное", "openChat(me.username)", "act-orange"),
    actionBtn("fa-share-nodes", "Пригласить", "inviteToMessenger()", "act-green")
  ].join("");

  const rows = [infoRow("юзернейм", `<span class="tglink">@${esc(me.username)}</span>`)];
  if (me.bio) rows.push(infoRow("о себе", esc(me.bio)));
  if (me.birthDate) rows.push(infoRow("день рождения", esc(formatBirthDate(me.birthDate))));
  if (me.verified) rows.push(infoRow("статус", `<span class="tgverified"><i class="fa-solid fa-circle-check"></i> Официально подтверждён</span>`));
  document.getElementById("myProfileInfo").innerHTML =
    `<div class="tgcard">${rows.join("")}</div><div class="tgcard giftcard"><div class="tgcardtitle">Подарки</div><div id="myGiftsRow" class="gifts-row"></div></div>`;

  await loadGifts(me.username, "myGiftsRow");

  const r = await fetch("/api/stories/mine", { headers: authHeaders() });
  const d = await r.json();
  const grid = document.getElementById("myStoriesGrid");
  if (!d.ok || d.stories.length === 0) {
    grid.innerHTML = `<div class="hint">Ты ещё не публиковал(а) историй</div>`;
    return;
  }

  grid.innerHTML = d.stories.map(st => {
    const thumb = st.mediaType === "image" ? `<img src="${esc(st.mediaUrl)}" alt="">`
      : st.mediaType === "video" ? `<video src="${esc(st.mediaUrl)}" muted></video>`
      : `<div class="storythumb-text">${esc((st.text || "").slice(0, 40))}</div>`;
    return `
      <div class="storythumb ${st.active ? "" : "expired"}" onclick='viewStory(${JSON.stringify(st).replace(/'/g, "&#39;")})'>
        ${thumb}
        ${!st.active ? '<span class="storythumb-badge">истекла</span>' : ""}
        <button class="storythumb-del" onclick="event.stopPropagation(); deleteStory(${st.id})" title="Удалить"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
  }).join("");
}

function formatBirthDate(bd) {
  const M = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bd);
  if (!m) return bd;
  return `${Number(m[3])} ${M[Number(m[2]) - 1]} ${m[1]}`;
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
let currentStory = null;
const STORY_QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "👏", "🔥"];

function closeStoryViewer() {
  const modal = document.getElementById("storyViewerModal");
  modal.classList.add("hidden");
  document.getElementById("storyViewerMedia").innerHTML = "";
  document.getElementById("storyViewerFooter").innerHTML = "";
  clearTimeout(storyTimer);
  storyTimer = null;
  currentStory = null;
}

function viewStory(s) {
  const modal = document.getElementById("storyViewerModal");
  modal.classList.remove("hidden");
  currentStory = s;

  const avatarBox = document.getElementById("storyViewerAvatar");
  avatarBox.innerHTML = avatarHtml({ username: s.owner, displayName: s.displayName, avatarUrl: s.avatarUrl });
  document.getElementById("storyViewerName").innerHTML = esc(s.displayName || s.owner) + verifiedBadge(s.verified);
  document.getElementById("storyViewerCaption").textContent = s.text || "";
  renderStoryFooter(s);

  const isOwner = me && s.owner === me.username;
  if (!isOwner) {
    fetch(`/api/stories/${s.id}/view`, { method: "POST", headers: authHeaders() }).catch(() => {});
  }

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

// ---------------- РЕАКЦИИ И ПРОСМОТРЫ ИСТОРИЙ ----------------
function renderStoryFooter(s) {
  const box = document.getElementById("storyViewerFooter");
  if (!box) return;
  const isOwner = me && s.owner === me.username;

  if (isOwner) {
    const views = s.viewCount || 0;
    const reactions = s.reactionCount || 0;
    box.innerHTML = `
      <button class="storyviewer-viewsbtn" onclick="openStoryViewersModal(${s.id})">
        <i class="fa-solid fa-eye"></i> ${views}
        ${reactions ? `<span class="storyviewer-reactcount">· ${reactions} ❤️</span>` : ""}
        <span class="storyviewer-viewslabel">${t("story.viewersTitle")}</span>
      </button>
    `;
    return;
  }

  const mine = s.myReaction || "";
  box.innerHTML = `
    <div class="storyviewer-reactbar">
      ${STORY_QUICK_REACTIONS.map(e => `
        <button class="storyviewer-reactbtn ${mine === e ? "active" : ""}" onclick="reactToStory(${s.id}, '${e}')">${e}</button>
      `).join("")}
    </div>
  `;
}

async function reactToStory(id, emoji) {
  if (!currentStory || currentStory.id !== id) return;
  const removing = currentStory.myReaction === emoji;
  try {
    if (removing) {
      await fetch(`/api/stories/${id}/react`, { method: "DELETE", headers: authHeaders() });
      currentStory.myReaction = "";
    } else {
      const r = await fetch(`/api/stories/${id}/react`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ reaction: emoji })
      });
      const d = await r.json();
      if (!d.ok) return alert(d.error || t("common.error"));
      currentStory.myReaction = emoji;
    }
  } catch {
    return;
  }
  renderStoryFooter(currentStory);
}

async function openStoryViewersModal(storyId) {
  clearTimeout(storyTimer); // пауза автопролистывания, пока читаем список
  const modal = document.getElementById("storyViewersModal");
  const list = document.getElementById("storyViewersList");
  list.innerHTML = `<div class="hint">${t("common.loading")}</div>`;
  modal.classList.remove("hidden");

  const r = await fetch(`/api/stories/${storyId}/viewers`, { headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) { list.innerHTML = `<div class="hint">${t("common.error")}</div>`; return; }
  if (!d.viewers.length) { list.innerHTML = `<div class="hint">${t("story.noViewers")}</div>`; return; }

  list.innerHTML = d.viewers.map(v => `
    <div class="memberrow">
      <div class="avatar">${avatarHtml(v)}</div>
      <div class="meta">
        <div class="name">${nameHtml(v)}</div>
        <div class="preview">@${esc(v.username)}</div>
      </div>
      ${v.reaction ? `<span class="storyviewer-viewer-reaction">${esc(v.reaction)}</span>` : ""}
    </div>
  `).join("");
}
function closeStoryViewersModal() {
  document.getElementById("storyViewersModal").classList.add("hidden");
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


// ================== ГЕОЛОКАЦИЯ ==================
let locBusy = false;

function locErrorText(err) {
  if (!err) return "Не удалось определить местоположение";
  if (err.code === 1) return "Доступ к геолокации запрещён. Разреши его в настройках браузера (значок замка рядом с адресом сайта).";
  if (err.code === 2) return "Не получилось определить местоположение. Проверь, что на телефоне включён GPS.";
  if (err.code === 3) return "Слишком долго определялось местоположение. Попробуй ещё раз на открытом месте.";
  return "Не удалось определить местоположение";
}

// Ждём до 8 секунд, пока телефон уточнит точку, и отправляем самую точную
function sendLocation() {
  if (!navigator.geolocation) return alert("Этот браузер не умеет определять геолокацию");
  if (!ws || ws.readyState !== 1) return alert("WS не подключен");
  if (locBusy) return;
  if (!confirm("Отправить твою точную геолокацию в этот чат?")) return;

  locBusy = true;
  toast("📍 Определяю точное местоположение...");
  let best = null, done = false, watchId = null, timer = null;

  const stop = () => {
    done = true;
    locBusy = false;
    clearTimeout(timer);
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  };
  const sendBest = () => {
    if (done) return;
    stop();
    if (!best) return alert("Не удалось определить местоположение");
    if (!ws || ws.readyState !== 1) return alert("WS не подключен");
    ws.send(JSON.stringify({
      type: "location-message",
      receiver: currentChat,
      lat: best.coords.latitude,
      lng: best.coords.longitude,
      accuracy: Math.round(best.coords.accuracy || 0)
    }));
  };

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (done) return;
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      if (pos.coords.accuracy <= 25) sendBest();
    },
    (err) => {
      if (done) return;
      if (best) return sendBest();
      stop();
      alert(locErrorText(err));
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
  timer = setTimeout(sendBest, 8000);
}

function parseLoc(m) {
  try {
    const o = JSON.parse(m.text);
    if (Number.isFinite(o.lat) && Number.isFinite(o.lng)) return o;
  } catch {}
  return null;
}

// Карта без ключей и сервисов: 9 плиток OpenStreetMap, центрированных на точке
function renderLocationBody(m) {
  const loc = parseLoc(m);
  if (!loc) return `<div class="mtext">📍 Геолокация</div>`;

  const Z = 16, n = 2 ** Z;
  const xf = (loc.lng + 180) / 360 * n;
  const latRad = loc.lat * Math.PI / 180;
  const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const tx = Math.floor(xf), ty = Math.floor(yf);
  const offX = (1 + (xf - tx)) * 256, offY = (1 + (yf - ty)) * 256;

  let tiles = "";
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = ((tx + dx) % n + n) % n, y = ty + dy;
      if (y < 0 || y >= n) continue;
      tiles += `<img src="https://tile.openstreetmap.org/${Z}/${x}/${y}.png" alt="" loading="lazy" onerror="this.style.display='none'" style="position:absolute;left:${(dx + 1) * 256}px;top:${(dy + 1) * 256}px;width:256px;height:256px">`;
    }
  }

  const coords = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
  const acc = loc.acc ? ` · ±${loc.acc} м` : "";
  const google = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  const yandex = `https://yandex.com/maps/?pt=${loc.lng},${loc.lat}&z=17&l=map`;

  return `
    <div class="loccard">
      <div class="locmap">
        <div class="locmosaic" style="left:${130 - offX}px;top:${80 - offY}px">${tiles}</div>
        <div class="locpin"><span></span></div>
      </div>
      <div class="loctitle">📍 Геолокация</div>
      <div class="loccoords">${coords}${acc}</div>
      <div class="locbtns">
        <a class="locbtn" href="${google}" target="_blank" rel="noopener">Google Карты</a>
        <a class="locbtn" href="${yandex}" target="_blank" rel="noopener">Яндекс Карты</a>
      </div>
    </div>
  `;
}

// ================== ЗАЯВКИ НА СВЯЗЬ: решение владельца официального аккаунта ==================
async function refreshContactInbox() {
  const box = document.getElementById("contactInbox");
  if (!box || !me) return;
  let d;
  try {
    const r = await fetch("/api/me/contact-requests", { headers: authHeaders() });
    d = await r.json();
  } catch { return; }
  if (!d || !d.ok || d.requests.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="inboxtitle">📨 Хотят тебе написать (${d.requests.length})</div>
    ${d.requests.map(r => `
      <div class="inboxitem">
        <div class="inboxhead">
          <div class="avatar">${avatarHtml(r.from)}</div>
          <div class="meta">
            <div class="name">${nameHtml(r.from, { noBday: true })}</div>
            <div class="preview">@${esc(r.fromUser)} · одобрено администрацией</div>
          </div>
        </div>
        <div class="inboxtext">${esc(r.text)}</div>
        <div class="inboxbtns">
          <button class="btn primary small" onclick="answerContactRequest(${r.id}, true)">Принять</button>
          <button class="btn ghost small" onclick="answerContactRequest(${r.id}, false)">Отклонить</button>
        </div>
      </div>
    `).join("")}
  `;
}

async function answerContactRequest(id, accept) {
  const r = await fetch(`/api/me/contact-requests/${id}/${accept ? "accept" : "reject"}`, { method: "POST", headers: authHeaders() });
  const d = await r.json();
  if (!d.ok) return alert(d.error || "Ошибка");
  toast(accept ? "Заявка принята ✅ Сообщение появилось в чатах" : "Заявка отклонена");
  refreshContactInbox();
  refreshChats();
}
