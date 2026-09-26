// The admin panel has its own token, completely separate from a regular
// user's chat login token. Never mix these up.
let adminToken = localStorage.getItem("adminToken");
let currentUser = null;

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

// ---------------- LOGIN / SESSION ----------------
window.addEventListener("DOMContentLoaded", async () => {
  if (adminToken) {
    const ok = await checkAdminSession();
    if (ok) return showDashboard();
  }
  showLogin();
});

function showLogin() {
  document.getElementById("adminLoginScreen").classList.remove("hidden");
  document.getElementById("adminDashboard").classList.add("hidden");
}

function showDashboard() {
  document.getElementById("adminLoginScreen").classList.add("hidden");
  document.getElementById("adminDashboard").classList.remove("hidden");
  loadVerificationRequests();
}

async function checkAdminSession() {
  try {
    const r = await fetch("/api/admin/users?q=", { headers: adminHeaders() });
    return r.ok;
  } catch {
    return false;
  }
}

async function adminLogin() {
  const login = document.getElementById("adminLoginInput").value.trim();
  const password = document.getElementById("adminPasswordInput").value;
  const errBox = document.getElementById("adminLoginError");
  errBox.textContent = "";

  const r = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password })
  });
  const d = await r.json();
  if (!d.ok) { errBox.textContent = d.error || "Ошибка входа"; return; }

  adminToken = d.token;
  localStorage.setItem("adminToken", adminToken);
  showDashboard();
}

function adminLogout() {
  localStorage.removeItem("adminToken");
  adminToken = null;
  showLogin();
}

function switchAdminTab(tab) {
  document.querySelectorAll(".admintab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("tabUsers").classList.toggle("hidden", tab !== "users");
  document.getElementById("tabVerification").classList.toggle("hidden", tab !== "verification");
  if (tab === "verification") loadVerificationRequests();
}

// ---------------- USER SEARCH / LIST ----------------
async function searchUser() {
  const q = document.getElementById("searchUser").value.replace("@", "").trim().toLowerCase();

  const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return;

  const list = document.getElementById("userList");
  document.getElementById("userCard").classList.add("hidden");
  closeThread();

  if (data.users.length === 0) { list.innerHTML = "<p class='hint'>Никого не нашлось</p>"; return; }

  list.innerHTML = data.users.map(u => `
    <button class="chatitem" onclick="openUser('${esc(u.username)}')">
      <div class="avatar">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="">` : `<span>${esc((u.displayName || u.username)[0].toUpperCase())}</span>`}</div>
      <div class="meta">
        <div class="name">${esc(u.displayName || u.username)}${u.verified ? ' <i class="fa-solid fa-circle-check verified-badge"></i>' : ""}</div>
        <div class="preview">@${esc(u.username)} ${u.banned ? "· 🚫 забанен" : ""} ${u.muted ? "· 🔇 мут" : ""}</div>
      </div>
    </button>
  `).join("");
}

async function openUser(username) {
  currentUser = username;
  closeThread();

  const res = await fetch(`/api/admin/user/${encodeURIComponent(username)}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) { alert(data.error || "Не найден"); return; }

  const user = data.user;
  document.getElementById("userCard").classList.remove("hidden");
  document.getElementById("userName").innerText = user.displayName || user.username;
  document.getElementById("userUsername").innerText = "@" + user.username;
  document.getElementById("userBio").innerText = user.bio || "";
  document.getElementById("userAvatar").src = user.avatarUrl || "https://via.placeholder.com/80";
  document.getElementById("userFlags").innerText =
    `${user.banned ? "🚫 забанен" : "✅ активен"} · ${user.muted ? "🔇 в муте" : "🔊 не в муте"} · ${user.verified ? "подтверждён ✅" : "не подтверждён"}`;

  await loadUserOverview(username);
}

async function loadUserOverview(username) {
  const res = await fetch(`/api/admin/user/${encodeURIComponent(username)}/overview`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return;

  const partnerBox = document.getElementById("partnerList");
  partnerBox.innerHTML = data.partners.length === 0
    ? "<p class='hint'>Личных переписок нет</p>"
    : data.partners.map(p => `
        <button class="chatitem" onclick="openPrivateThread('${esc(username)}','${esc(p.username)}')">
          <div class="meta">
            <div class="name">@${esc(p.username)}</div>
            <div class="preview">${p.total} сообщени${pluralRu(p.total)} · последнее ${new Date(p.lastAt).toLocaleString("ru-RU")}</div>
          </div>
        </button>
      `).join("");

  const groupBox = document.getElementById("groupList");
  groupBox.innerHTML = data.groups.length === 0
    ? "<p class='hint'>Не состоит в группах/каналах</p>"
    : data.groups.map(g => `
        <button class="chatitem" onclick="openGroupThread(${g.id}, '${esc(g.name)}')">
          <div class="meta">
            <div class="name">${esc(g.name)} ${g.isChannel ? "(канал)" : ""}</div>
            <div class="preview">роль: ${g.role === "owner" ? "владелец" : g.role === "admin" ? "админ" : "участник"}</div>
          </div>
        </button>
      `).join("");
}

function pluralRu(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "е";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "я";
  return "й";
}

// ---------------- THREAD VIEWER ----------------
async function openPrivateThread(userA, userB) {
  const res = await fetch(`/api/admin/messages/private/${encodeURIComponent(userA)}/${encodeURIComponent(userB)}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return alert("Ошибка загрузки переписки");

  showThread(`@${userA} ↔ @${userB}`, data.messages);
}

async function openGroupThread(groupId, name) {
  const res = await fetch(`/api/admin/messages/group/${groupId}`, { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return alert("Ошибка загрузки сообщений");

  showThread(`Группа: ${name}`, data.messages);
}

function showThread(title, messages) {
  document.getElementById("threadViewer").classList.remove("hidden");
  document.getElementById("threadTitle").textContent = title;

  const box = document.getElementById("threadMessages");
  if (messages.length === 0) {
    box.innerHTML = "<p class='hint'>Сообщений нет</p>";
    return;
  }

  box.innerHTML = messages.map(m => {
    let body;
    if (m.mediaType === "image") body = `<img src="${esc(m.mediaUrl)}" class="thread-media">`;
    else if (m.mediaType === "video") body = `<video src="${esc(m.mediaUrl)}" controls class="thread-media"></video>`;
    else if (m.mediaType === "audio") body = `<audio src="${esc(m.mediaUrl)}" controls></audio>`;
    else if (m.mediaType === "list") {
      let list; try { list = JSON.parse(m.text); } catch { list = { title: "", items: [] }; }
      body = `<b>${esc(list.title)}</b><br>` + (list.items || []).map(it => `${it.checked ? "☑" : "☐"} ${esc(it.text)}`).join("<br>");
    } else {
      body = esc(m.text || "");
    }

    return `
      <div class="thread-msg">
        <div class="thread-meta">
          <b>@${esc(m.sender)}</b>
          <span class="hint">${new Date(m.createdAt).toLocaleString("ru-RU")}</span>
          <button class="iconbtn small" onclick="adminDeleteMessage(${m.id}, this)" title="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="thread-body">${body}</div>
      </div>
    `;
  }).join("");
}

function closeThread() {
  document.getElementById("threadViewer").classList.add("hidden");
  document.getElementById("threadMessages").innerHTML = "";
}

async function adminDeleteMessage(id, btn) {
  if (!confirm("Удалить это сообщение?")) return;
  const res = await fetch(`/api/admin/messages/${id}`, { method: "DELETE", headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) return alert(data.error || "Ошибка");
  btn.closest(".thread-msg").remove();
}

// ---------------- MODERATION ACTIONS ----------------
async function callAdmin(path, method) {
  if (!currentUser) return;
  const res = await fetch(`/api/admin/${path}/${encodeURIComponent(currentUser)}`, {
    method,
    headers: adminHeaders()
  });
  const data = await res.json();
  if (!data.ok) alert(data.error || "Ошибка");
  return data;
}

async function banUser() {
  if (!confirm("Забанить пользователя?")) return;
  const d = await callAdmin("ban", "POST");
  if (d && d.ok) { alert("Пользователь забанен"); openUser(currentUser); }
}
async function unbanUser() {
  const d = await callAdmin("unban", "POST");
  if (d && d.ok) { alert("Пользователь разбанен"); openUser(currentUser); }
}
async function muteUser() {
  const d = await callAdmin("mute", "POST");
  if (d && d.ok) { alert("Пользователь замучен"); openUser(currentUser); }
}
async function unmuteUser() {
  const d = await callAdmin("unmute", "POST");
  if (d && d.ok) { alert("Пользователь размучен"); openUser(currentUser); }
}
async function deleteUser() {
  if (!confirm("Удалить аккаунт навсегда? Это действие необратимо.")) return;
  const d = await callAdmin("delete", "DELETE");
  if (d && d.ok) {
    alert("Аккаунт удалён");
    document.getElementById("userCard").classList.add("hidden");
    closeThread();
    currentUser = null;
    searchUser();
  }
}

// ---------------- VERIFICATION REQUESTS ----------------
async function loadVerificationRequests() {
  const box = document.getElementById("verificationList");
  if (!box) return;

  const res = await fetch("/api/admin/verification-requests", { headers: adminHeaders() });
  const data = await res.json();
  if (!data.ok) { box.innerHTML = "<p>Ошибка загрузки заявок</p>"; return; }

  if (data.requests.length === 0) {
    box.innerHTML = "<p class='hint'>Нет заявок на рассмотрении</p>";
    return;
  }

  box.innerHTML = data.requests.map(r => `
    <div class="ver-item" data-id="${r.id}">
      <div><b>@${esc(r.username)}</b> — ${esc(r.orgName)}, ${esc(r.role)}</div>
      <div><a href="${esc(r.proofUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.proofUrl)}</a></div>
      <div class="ver-actions">
        <button class="success" onclick="decideVerification(${r.id}, 'approve')">Одобрить</button>
        <button class="danger" onclick="decideVerification(${r.id}, 'reject')">Отклонить</button>
      </div>
    </div>
  `).join("");
}

async function decideVerification(id, action) {
  const res = await fetch(`/api/admin/verification-requests/${id}/${action}`, {
    method: "POST",
    headers: adminHeaders()
  });
  const data = await res.json();
  if (!data.ok) return alert(data.error || "Ошибка");
  loadVerificationRequests();
}
