function getAdminToken(){
  return localStorage.getItem("admin_token") || "";
}

async function adminLogin(){
  const username=document.getElementById("adminUser").value.trim();
  const pin=document.getElementById("adminPin").value.trim();

  const res=await fetch("/api/admin/login",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({username,pin})
  });

  const data=await res.json();
  if(!data.success){alert("Ошибка входа");return;}

  localStorage.setItem("admin_token",data.token);
  showAdminPanel();
  loadAdminUsers();
}

function logoutAdmin(){
  localStorage.removeItem("admin_token");
  document.getElementById("loginCard").classList.remove("hidden");
  document.getElementById("adminPanel").classList.add("hidden");
}

function showAdminPanel(){
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("adminPanel").classList.remove("hidden");
}

async function loadAdminUsers(){
  const q=document.getElementById("searchAdminUser").value.trim();

  const res=await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`,{
    headers:{"x-admin-token":getAdminToken()}
  });

  const data=await res.json();
  if(!data.success)return;

  const now=Date.now();
  const list=document.getElementById("usersList");

  list.innerHTML=data.users.map(user=>`
    <div class="user-row">
      <div>
        <b>@${user.username}</b>
        <div class="flex">
          ${user.isBanned?`<span class="badge red">Заблокирован</span>`:`<span class="badge green">Активен</span>`}
          ${user.textBlocked?`<span class="badge blue">Text off</span>`:""}
          ${user.imageBlocked?`<span class="badge blue">Photo off</span>`:""}
          ${user.videoBlocked?`<span class="badge blue">Video off</span>`:""}
          ${user.audioBlocked?`<span class="badge blue">Audio off</span>`:""}
        </div>
      </div>

      <div class="flex">
        <select id="ban_${user.username}">
          <option value="0">Без бана</option>
          <option value="86400000">1 день</option>
          <option value="259200000">3 дня</option>
          <option value="2592000000">30 дней</option>
        </select>
        <button class="btn-danger" onclick="setBan('${user.username}')">Бан</button>
      </div>

      <div class="flex">
        <select id="restrictType_${user.username}">
          <option value="text">Text</option>
          <option value="image">Photo</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
        </select>
        <select id="restrictTime_${user.username}">
          <option value="3600000">1 час</option>
          <option value="86400000">1 день</option>
          <option value="259200000">3 дня</option>
        </select>
        <button class="btn-gray" onclick="setRestriction('${user.username}')">Ограничить</button>
        <button class="btn-primary" onclick="clearRestrictions('${user.username}')">Снять всё</button>
      </div>
    </div>
  `).join("");
}

async function setBan(username){
  const durationMs=Number(document.getElementById(`ban_${username}`).value);

  await fetch("/api/admin/ban",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-admin-token":getAdminToken()
    },
    body:JSON.stringify({username,durationMs})
  });

  loadAdminUsers();
}

async function setRestriction(username){
  const type=document.getElementById(`restrictType_${username}`).value;
  const durationMs=Number(document.getElementById(`restrictTime_${username}`).value);

  await fetch("/api/admin/restrict",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-admin-token":getAdminToken()
    },
    body:JSON.stringify({username,type,durationMs})
  });

  loadAdminUsers();
}

async function clearRestrictions(username){
  await fetch("/api/admin/clear",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-admin-token":getAdminToken()
    },
    body:JSON.stringify({username})
  });

  loadAdminUsers();
}

async function sendOfficial(){
  const username=document.getElementById("officialUser").value.trim().replace("@","");
  const text=document.getElementById("officialText").value;

  await fetch("/api/admin/message",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-admin-token":getAdminToken()
    },
    body:JSON.stringify({username,text})
  });

  alert("Отправлено");
}

async function broadcastAll(){
  const text=document.getElementById("broadcastText").value;

  await fetch("/api/admin/broadcast",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-admin-token":getAdminToken()
    },
    body:JSON.stringify({text})
  });

  alert("Отправлено всем");
}

window.addEventListener("DOMContentLoaded",()=>{
  if(getAdminToken()){
    showAdminPanel();
    loadAdminUsers();
  }
});
