// public/admin.js
(() => {
  const $ = (id)=>document.getElementById(id);

  let adminToken = localStorage.getItem("adminToken") || "";

  async function api(url, method, body){
    const headers = adminToken ? { "Content-Type":"application/json", "Authorization":"Bearer "+adminToken } : { "Content-Type":"application/json" };
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }

  function showApp(on){
    $("adminLogin").classList.toggle("hidden", on);
    $("adminApp").classList.toggle("hidden", !on);
  }

  $("aLoginBtn").onclick = async ()=>{
    $("aMsg").textContent="";
    const username = $("aUser").value.trim();
    const password = $("aPass").value;
    const data = await api("/api/admin/login", "POST", { username, password });
    if(!data.ok){
      $("aMsg").textContent = "❌ " + data.error;
      return;
    }
    adminToken = data.token;
    localStorage.setItem("adminToken", adminToken);
    showApp(true);
    loadUsers();
  };

  $("aRefresh").onclick = loadUsers;

  async function loadUsers(){
    const data = await api("/api/admin/users", "GET");
    if(!data.ok){
      alert("Ошибка: "+data.error);
      return;
    }
    renderUsers(data.users || []);
  }

  function renderUsers(users){
    const wrap = $("usersTable");
    wrap.innerHTML = `
      <div class="trow head">
        <div>👤 username</div>
        <div>📝 имя/био</div>
        <div>💬 текст</div>
        <div>📎 медиа</div>
        <div>📞 звонки</div>
        <div>⛔ блок</div>
      </div>
    ` + users.map(u => `
      <div class="trow" data-u="${u.username}">
        <div><b>@${u.username}</b><div class="smalltxt">${u.createdAt?.slice(0,10)||""}</div></div>
        <div>
          <div>${escapeHtml(u.displayName||"")}</div>
          <div class="smalltxt">${escapeHtml(u.bio||"")}</div>
        </div>
        <div><input type="checkbox" class="cText" ${u.canSendText? "checked":""}></div>
        <div><input type="checkbox" class="cMedia" ${u.canSendMedia? "checked":""}></div>
        <div><input type="checkbox" class="cCall" ${u.canCall? "checked":""}></div>
        <div>
          <input class="blockUntil" placeholder="YYYY-MM-DDTHH:mm:ssZ" value="${escapeHtml(u.blockedUntil||"")}"/>
          <button class="pill saveBtn">✅</button>
        </div>
      </div>
    `).join("");

    wrap.querySelectorAll(".saveBtn").forEach(btn=>{
      btn.onclick = async ()=>{
        const row = btn.closest(".trow");
        const username = row.getAttribute("data-u");
        const blockedUntil = row.querySelector(".blockUntil").value.trim();
        const canSendText = row.querySelector(".cText").checked;
        const canSendMedia = row.querySelector(".cMedia").checked;
        const canCall = row.querySelector(".cCall").checked;
        const data = await api("/api/admin/user/update", "POST", { username, blockedUntil, canSendText, canSendMedia, canCall });
        if(!data.ok) alert("Ошибка: "+data.error);
        else alert("✅ Обновлено");
      };
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  // auto show if token exists
  if(adminToken){
    showApp(true);
    loadUsers();
  }
})();
