const token = localStorage.getItem("token");
let currentUser = null;

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function searchUser() {
    const username = document.getElementById("searchUser").value.replace("@", "").trim().toLowerCase();
    if (!username) return;

    // /api/admin/user/:username requires isAdmin — it also returns banned/muted flags,
    // which the plain /api/users/:username endpoint intentionally does not.
    const res = await fetch(`/api/admin/user/${encodeURIComponent(username)}`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const data = await res.json();

    if (!data.ok) {
        alert(data.error || "Пользователь не найден");
        return;
    }

    const user = data.user;
    currentUser = user.username;

    document.getElementById("userCard").classList.remove("hidden");
    document.getElementById("userName").innerText = user.displayName || user.username;
    document.getElementById("userUsername").innerText = "@" + user.username;
    document.getElementById("userBio").innerText = user.bio || "";
    document.getElementById("userAvatar").src = user.avatarUrl || "https://via.placeholder.com/80";
    document.getElementById("userFlags").innerText =
        `${user.banned ? "🚫 забанен" : "✅ активен"} · ${user.muted ? "🔇 в муте" : "🔊 не в муте"}`;
}

async function callAdmin(path, method) {
    if (!currentUser) return;
    const res = await fetch(`/api/admin/${path}/${encodeURIComponent(currentUser)}`, {
        method,
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.ok) alert(data.error || "Ошибка");
    return data;
}

async function banUser() {
    if (!confirm("Забанить пользователя?")) return;
    const d = await callAdmin("ban", "POST");
    if (d && d.ok) { alert("Пользователь забанен"); searchUser(); }
}

async function unbanUser() {
    const d = await callAdmin("unban", "POST");
    if (d && d.ok) { alert("Пользователь разбанен"); searchUser(); }
}

async function muteUser() {
    const d = await callAdmin("mute", "POST");
    if (d && d.ok) { alert("Пользователь замучен"); searchUser(); }
}

async function unmuteUser() {
    const d = await callAdmin("unmute", "POST");
    if (d && d.ok) { alert("Пользователь размучен"); searchUser(); }
}

async function deleteUser() {
    if (!confirm("Удалить аккаунт навсегда?")) return;
    const d = await callAdmin("delete", "DELETE");
    if (d && d.ok) {
        alert("Аккаунт удалён");
        document.getElementById("userCard").classList.add("hidden");
        currentUser = null;
    }
}
