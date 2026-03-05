let adminToken = localStorage.getItem("adminToken") || "";

function $(id) { return document.getElementById(id); }

function showAdminUI() {
  $("loginPanel").classList.add("hidden");
  $("adminPanel").classList.remove("hidden");
  loadUsers();
}

function hideAdminUI() {
  $("loginPanel").classList.remove("hidden");
  $("adminPanel").classList.add("hidden");
}

if (adminToken) showAdminUI();

async function adminLogin() {
  const user = $("adminUser").value.trim();
  const pass = $("adminPass").value.trim();
  $("aerr").textContent = "";

  try {
    const r = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, pass })
    });
    const d = await r.json();
    if (!d.ok) {
      $("aerr").textContent = "Неверный логин/пароль";
      return;
    }

    adminToken = d.token;
    localStorage.setItem("adminToken", adminToken);
    showAdminUI();
  } catch {
    $("aerr").textContent = "Ошибка соединения";
  }
}

function adminLogout() {
  localStorage.removeItem("adminToken");
  adminToken = "";
  hideAdminUI();
}

async function loadUsers() {
  try {
    const r = await fetch("/api/admin/users", {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const d = await r.json();
    if (!d.ok) return alert("Нет доступа");

    const wrap = $("usersTable");
    wrap.innerHTML = "";

    d.users.forEach(u => {
      const row = document.createElement("div");
      row.className = "admin-user-row";

      const until = Number(u.blockedUntil || 0);
      const now = Date.now();
      const blocked = until > now;
      const blockRemaining = blocked ? Math.ceil((until - now) / 60000) : 0;

      row.innerHTML = `
        <div class="admin-user-info">
          <div class="admin-user-name">
            <span>👤</span>
            <div>
              <div><strong>@${u.username}</strong> ${u.displayName ? `(${u.displayName})` : ""}</div>
              <div class="admin-user-status ${blocked ? 'blocked' : 'ok'}">
                ${blocked ? `🚫 Заблокирован (ещё ${blockRemaining} мин)` : "✅ Активен"}
              </div>
            </div>
          </div>
        </div>

        <div class="admin-user-controls">
          <div class="control-group">
            <label>Блок (минут)</label>
            <input type="number" min="0" value="0" id="block-${u.username}" placeholder="0">
            <button class="admin-btn primary" onclick="applyBlock('${u.username}')">Блокировать</button>
          </div>

          <div class="control-group permissions">
            <label><input type="checkbox" ${u.canSendText ? "checked" : ""} data-text="${u.username}"> Сообщения</label>
            <label><input type="checkbox" ${u.canSendMedia ? "checked" : ""} data-media="${u.username}"> Медиа</label>
            <label><input type="checkbox" ${u.canCall ? "checked" : ""} data-call="${u.username}"> Звонки</label>
            <button class="admin-btn ghost" onclick="saveRules('${u.username}')">Сохранить</button>
          </div>
        </div>
      `;

      wrap.appendChild(row);
    });
  } catch (e) {
    alert("Ошибка загрузки пользователей");
  }
}

async function applyBlock(username) {
  const inp = document.getElementById(`block-${username}`);
  const mins = Number(inp.value || 0);
  const blockedUntil = mins > 0 ? Date.now() + mins * 60 * 1000 : 0;

  await updateUser(username, { blockedUntil });
  loadUsers();
}

async function saveRules(username) {
  const canSendText = document.querySelector(`input[data-text="${username}"]`).checked ? 1 : 0;
  const canSendMedia = document.querySelector(`input[data-media="${username}"]`).checked ? 1 : 0;
  const canCall = document.querySelector(`input[data-call="${username}"]`).checked ? 1 : 0;

  await updateUser(username, { canSendText, canSendMedia, canCall });
  loadUsers();
}

async function updateUser(username, patch) {
  try {
    const r = await fetch("/api/admin/user/update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, ...patch })
    });
    const d = await r.json();
    if (!d.ok) alert("Ошибка обновления");
  } catch {
    alert("Ошибка сети");
  }
}
