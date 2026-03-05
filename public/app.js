// public/app.js
(() => {
  const $ = (id) => document.getElementById(id);

  const token = localStorage.getItem("token");
  if (!token) location.href = "/";

  const state = {
    me: null,
    chats: { global: null, dms: [], groups: [] },
    currentChat: "global",
    ws: null,
    typingTimer: null,
    typingShownTimer: null,
    peerStatus: new Map(), // username -> online/offline
    currentPeer: null, // for dm
    currentGroupId: null,
    rtc: {
      pc: null,
      localStream: null,
      remoteAudio: null,
      inCallWith: null,
      incomingFrom: null,
      pendingOffer: null
    }
  };

  function authHeaders() {
    return { Authorization: "Bearer " + token };
  }

  async function apiGet(url) {
    const r = await fetch(url, { headers: { ...authHeaders() } });
    return r.json();
  }
  async function apiSend(url, method, body, isForm) {
    const headers = isForm ? { ...authHeaders() } : { "Content-Type": "application/json", ...authHeaders() };
    const r = await fetch(url, {
      method,
      headers,
      body: isForm ? body : JSON.stringify(body || {})
    });
    return r.json();
  }

  // ---------- UI helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  function avatarEmojiFromName(name) {
    const base = ["🙂", "😎", "🧠", "🦊", "🐼", "🐯", "🐸", "🦁", "🐵", "🐙", "🦉", "🐝", "🐢"];
    let h = 0;
    for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return base[h % base.length];
  }
  function openModal(title, html) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = html;
    $("modalBackdrop").classList.remove("hidden");
  }
  function closeModal() {
    $("modalBackdrop").classList.add("hidden");
  }

  $("modalClose").onclick = closeModal;
  $("modalBackdrop").addEventListener("click", (e) => {
    if (e.target === $("modalBackdrop")) closeModal();
  });

  function setHeadForChat() {
    const chat = state.currentChat;
    state.currentPeer = null;
    state.currentGroupId = null;

    $("callBtn").disabled = false;
    $("callBtn").style.opacity = "1";

    if (chat === "global") {
      $("headTitle").textContent = "Глобальный чат";
      $("headSub").textContent = "🌍 online";
      $("headAvatar").textContent = "🌍";
      $("callBtn").disabled = true;
      $("callBtn").style.opacity = ".45";
      return;
    }
    if (chat.startsWith("@")) {
      const peer = chat.slice(1);
      state.currentPeer = peer;
      $("headTitle").textContent = "@" + peer;
      const st = state.peerStatus.get(peer) || "offline";
      $("headSub").textContent = st === "online" ? "🟢 online" : "⚪ offline";
      $("headAvatar").textContent = avatarEmojiFromName(peer);
      return;
    }
    if (chat.startsWith("group:")) {
      const gid = Number(chat.split(":")[1]);
      state.currentGroupId = gid;
      const g = state.chats.groups.find((x) => x.id === gid);
      $("headTitle").textContent = g ? g.name : "Группа";
      $("headSub").textContent = "👥 group";
      $("headAvatar").textContent = "👥";
      $("callBtn").disabled = true;
      $("callBtn").style.opacity = ".45";
    }
  }

  function renderChatList() {
    const list = $("chatList");
    list.innerHTML = "";

    function addItem({ key, title, subtitle, avatar, badge }) {
      const div = document.createElement("div");
      div.className = "chatitem" + (state.currentChat === key ? " active" : "");
      div.innerHTML = `
        <div class="chatavatar">${escapeHtml(avatar)}</div>
        <div class="chatmeta">
          <div class="chatname">${escapeHtml(title)}</div>
          <div class="chatlast">${escapeHtml(subtitle || "")}</div>
        </div>
        <div class="chatbadge">${escapeHtml(badge || "")}</div>
      `;
      div.onclick = () => {
        state.currentChat = key;
        // mobile: close sidebar
        if (window.matchMedia("(max-width: 768px)").matches) $("sidebar").classList.remove("mobile-open");
        renderChatList();
        setHeadForChat();
        loadMessages(key);
      };
      list.appendChild(div);
    }

    // global
    const gl = state.chats.global?.last;
    addItem({
      key: "global",
      title: "🌍 Общий чат",
      subtitle: gl ? (gl.sender ? `@${gl.sender}: ${gl.text || gl.mediaType}` : gl.text) : "Будь первым 🙂",
      avatar: "🌍"
    });

    // dms
    for (const dm of state.chats.dms) {
      const peer = dm.peer;
      const last = dm.last;
      addItem({
        key: "@" + peer.username,
        title: "@" + peer.username,
        subtitle: last ? (last.text || (last.mediaType ? `(${last.mediaType})` : "")) : "",
        avatar: peer.avatarUrl ? "🖼️" : avatarEmojiFromName(peer.username),
        badge: state.peerStatus.get(peer.username) === "online" ? "🟢" : "⚪"
      });
    }

    // groups
    for (const g of state.chats.groups) {
      addItem({
        key: "group:" + g.id,
        title: "👥 " + g.name,
        subtitle: g.description || "",
        avatar: g.avatarUrl ? "🖼️" : "👥"
      });
    }
  }

  function renderMessages(messages) {
    const box = $("messages");
    box.innerHTML = "";
    for (const m of messages) appendMessage(m, true);
    box.scrollTop = box.scrollHeight;
  }

  function makeMediaEl(m) {
    if (!m.mediaUrl) return "";
    const url = m.mediaUrl;
    if (m.mediaType === "image") {
      return `<img class="media" src="${escapeHtml(url)}" alt="image"/>`;
    }
    if (m.mediaType === "video") {
      return `<video class="media video" src="${escapeHtml(url)}" controls></video>`;
    }
    if (m.mediaType === "audio") {
      return `<audio class="media audio" src="${escapeHtml(url)}" controls></audio>`;
    }
    return `<a class="chip" href="${escapeHtml(url)}" target="_blank">📦 файл</a>`;
  }

  function appendMessage(m, silent) {
    const box = $("messages");
    const row = document.createElement("div");
    row.className = "msgrow";

    const isMe = m.sender === state.me?.username;
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (isMe ? " me" : "");

    const title = m.chatType === "group" ? `@${m.sender}` : "";
    bubble.innerHTML = `
      <div class="metaLine">
        ${title ? `<span>${escapeHtml(title)}</span>` : ""}
        <span>${escapeHtml(fmtTime(m.createdAt))}</span>
        ${isMe ? `<button data-del="${m.id}" class="chip" title="Удалить">❌</button>` : ""}
      </div>
      ${m.text ? `<div class="textLine">${escapeHtml(m.text)}</div>` : ""}
      ${makeMediaEl(m)}
    `;

    row.appendChild(bubble);
    box.appendChild(row);

    const delBtn = bubble.querySelector(`[data-del="${m.id}"]`);
    if (delBtn) {
      delBtn.onclick = async () => {
        const data = await apiSend("/api/messages/" + m.id, "DELETE");
        if (!data.ok) alert("Ошибка: " + data.error);
      };
    }

    if (!silent) box.scrollTop = box.scrollHeight;
  }

  function removeMessage(id) {
    const box = $("messages");
    const btn = box.querySelector(`[data-del="${id}"]`);
    if (!btn) return;
    const bubble = btn.closest(".bubble");
    const row = bubble?.closest(".msgrow");
    if (row) row.remove();
  }

  // ---------- Loaders ----------
  async function loadMe() {
    const data = await apiGet("/api/me");
    if (!data.ok) {
      localStorage.removeItem("token");
      location.href = "/";
      return;
    }
    state.me = data.me;
  }

  async function loadBirthdays() {
    const data = await apiGet("/api/birthdays/today");
    if (!data.ok) return;
    const users = data.users || [];
    if (!users.length) {
      $("birthdayBanner").classList.add("hidden");
      return;
    }
    const names = users.map(u => u.displayName || "@"+u.username).slice(0, 4).join(", ");
    $("birthdayBanner").textContent = `🎂 Сегодня день рождения: ${names}`;
    $("birthdayBanner").classList.remove("hidden");
  }

  async function loadChats() {
    const data = await apiGet("/api/chats");
    if (!data.ok) return alert("Ошибка чатов: " + data.error);
    state.chats = data;
    renderChatList();
  }

  async function loadMessages(chatKey) {
    $("messages").innerHTML = "";
    const data = await apiGet("/api/messages?chat=" + encodeURIComponent(chatKey));
    if (!data.ok) return alert("Ошибка сообщений: " + data.error);
    renderMessages(data.messages || []);
  }

  // ---------- WebSocket ----------
  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      // ok
    };
    ws.onmessage = async (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.type === "status") {
        state.peerStatus.set(data.username, data.status);
        if (state.currentPeer === data.username) {
          $("headSub").textContent = data.status === "online" ? "🟢 online" : "⚪ offline";
        }
        renderChatList();
        return;
      }

      if (data.type === "typing") {
        if (data.to !== state.currentChat) return;
        if (data.from === state.me.username) return;
        $("typingLine").classList.remove("hidden");
        $("typingLine").textContent = `⌨️ @${data.from} печатает...`;
        clearTimeout(state.typingShownTimer);
        state.typingShownTimer = setTimeout(() => $("typingLine").classList.add("hidden"), 1200);
        return;
      }

      if (data.type === "message") {
        const m = data.message;
        // If current chat matches, append
        const cur = state.currentChat;
        const msgChatKey = messageToChatKey(m);
        if (msgChatKey === cur) appendMessage(m, false);
        // reload list quick for last message preview
        loadChats().catch(() => {});
        return;
      }

      if (data.type === "message-deleted") {
        removeMessage(data.id);
        return;
      }

      // Calls
      if (data.type === "call-offer") {
        // incoming
        if (state.currentChat.startsWith("group:") || state.currentChat === "global") return;
        state.rtc.incomingFrom = data.from;
        state.rtc.pendingOffer = data.sdp;

        $("callTitle").textContent = "📞 Входящий звонок";
        $("callText").textContent = "@" + data.from + " звонит…";
        $("callModal").classList.remove("hidden");
        return;
      }
      if (data.type === "call-answer") {
        await onCallAnswer(data);
        return;
      }
      if (data.type === "ice") {
        await onIce(data);
        return;
      }
      if (data.type === "call-end") {
        endCall(true);
        return;
      }

      if (data.type === "error") {
        console.log("WS error:", data.error);
      }
    };

    ws.onclose = () => {
      // reconnect simple
      setTimeout(connectWs, 1200);
    };
  }

  function wsSend(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function messageToChatKey(m) {
    if (m.chatType === "global") return "global";
    if (m.chatType === "dm") {
      const me = state.me.username;
      const peer = (m.user1 === me) ? m.user2 : m.user1;
      return "@" + peer;
    }
    if (m.chatType === "group") return "group:" + m.groupId;
    return "";
  }

  // ---------- Send text ----------
  $("sendBtn").onclick = () => sendText();
  $("msgInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendText();
    else pingTyping();
  });
  $("msgInput").addEventListener("input", pingTyping);

  function pingTyping() {
    clearTimeout(state.typingTimer);
    wsSend({ type: "typing", to: state.currentChat, isTyping: true });
    state.typingTimer = setTimeout(() => wsSend({ type: "typing", to: state.currentChat, isTyping: false }), 800);
  }

  function sendText() {
    const text = $("msgInput").value;
    if (!text.trim()) return;
    wsSend({ type: "text-message", chat: state.currentChat, text });
    $("msgInput").value = "";
    wsSend({ type: "typing", to: state.currentChat, isTyping: false });
  }

  // ---------- Upload media / voice ----------
  $("attachBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = async () => {
    const f = $("fileInput").files[0];
    if (!f) return;
    await uploadFile(f, "");
    $("fileInput").value = "";
  };

  async function uploadFile(fileOrBlob, text) {
    const fd = new FormData();
    fd.append("file", fileOrBlob, fileOrBlob.name || "voice.webm");
    fd.append("chat", state.currentChat);
    fd.append("text", text || "");
    const data = await apiSend("/api/upload", "POST", fd, true);
    if (!data.ok) alert("Ошибка загрузки: " + data.error);
  }

  // voice: hold to record
  let mediaRecorder = null;
  let chunks = [];
  let recStream = null;

  $("micBtn").addEventListener("mousedown", startRec);
  $("micBtn").addEventListener("touchstart", (e) => { e.preventDefault(); startRec(); }, { passive:false });

  $("micBtn").addEventListener("mouseup", stopRec);
  $("micBtn").addEventListener("mouseleave", stopRec);
  $("micBtn").addEventListener("touchend", (e) => { e.preventDefault(); stopRec(); }, { passive:false });

  async function startRec() {
    if (mediaRecorder) return;
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(recStream);
      mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        await uploadFile(blob, "");
        cleanupRec();
      };
      mediaRecorder.start();
      $("micBtn").classList.add("recording");
    } catch (e) {
      alert("🎤 Нет доступа к микрофону");
      cleanupRec();
    }
  }

  function cleanupRec() {
    $("micBtn").classList.remove("recording");
    if (recStream) recStream.getTracks().forEach(t => t.stop());
    recStream = null;
    mediaRecorder = null;
    chunks = [];
  }

  function stopRec() {
    if (!mediaRecorder) return;
    try { mediaRecorder.stop(); } catch {}
  }

  // ---------- Sidebar collapse / mobile open ----------
  let panelHidden = false;
  $("collapseBtn").onclick = () => {
    panelHidden = !panelHidden;
    $("sidePanel").classList.toggle("hidden", panelHidden);
    $("collapseBtn").textContent = panelHidden ? "▶" : "▼";
  };

  // open sidebar on mobile by tapping header (easy)
  $("chatHead").onclick = async () => {
    if (state.currentChat.startsWith("@")) {
      // open peer profile
      const peer = state.currentPeer;
      if (!peer) return;
      const data = await apiGet("/api/users/" + encodeURIComponent(peer));
      if (!data.ok) return;
      const u = data.user;
      openModal("👤 Профиль @" + u.username, `
        <div class="row"><div class="avatar">${avatarEmojiFromName(u.username)}</div>
        <div>
          <div><b>${escapeHtml(u.displayName || "@"+u.username)}</b></div>
          <div class="muted">${escapeHtml(u.bio || "")}</div>
          <div class="smalltxt">🎂 ${escapeHtml(u.birthDate || "—")}</div>
          <div class="smalltxt">⏱ lastSeen: ${escapeHtml(u.lastSeen || "—")}</div>
        </div></div>
      `);
    } else if (state.currentChat.startsWith("group:")) {
      const gid = state.currentGroupId;
      const data = await apiGet("/api/groups/" + gid);
      if (!data.ok) return;
      const g = data.group;
      const members = data.members || [];
      openModal("👥 " + escapeHtml(g.name), `
        <div class="muted">${escapeHtml(g.description || "")}</div>
        <div style="margin-top:10px">
          ${members.map(m => `<div class="row" style="margin:6px 0">
            <div class="chip">${m.role}</div>
            <div>@${escapeHtml(m.username)} <span class="muted">${escapeHtml(m.displayName||"")}</span></div>
          </div>`).join("")}
        </div>
      `);
    } else {
      // on mobile: open sidebar
      if (window.matchMedia("(max-width: 768px)").matches) $("sidebar").classList.add("mobile-open");
    }
  };

  // search @username
  $("searchInput").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = $("searchInput").value.trim();
    if (!q) return;
    const data = await apiGet("/api/users/search?q=" + encodeURIComponent(q));
    if (!data.ok) return;
    const users = data.users || [];
    openModal("🔍 Поиск", `
      ${users.length ? users.map(u => `
        <div class="chatitem" style="border:1px solid var(--border); margin:8px 0" data-u="${escapeHtml(u.username)}">
          <div class="chatavatar">${avatarEmojiFromName(u.username)}</div>
          <div class="chatmeta">
            <div class="chatname">@${escapeHtml(u.username)}</div>
            <div class="chatlast">${escapeHtml(u.bio||"")}</div>
          </div>
        </div>`).join("") : `<div class="muted">Никого не нашли.</div>`}
    `);
    // click to open dm
    setTimeout(() => {
      document.querySelectorAll("[data-u]").forEach(el => {
        el.onclick = () => {
          const u = el.getAttribute("data-u");
          closeModal();
          state.currentChat = "@" + u;
          if (window.matchMedia("(max-width: 768px)").matches) $("sidebar").classList.remove("mobile-open");
          loadChats().then(() => {
            renderChatList();
            setHeadForChat();
            loadMessages(state.currentChat);
          });
        };
      });
    }, 0);
  });

  // ---------- Profile / settings ----------
  $("settingsBtn").onclick = () => openProfileModal();
  async function openProfileModal() {
    const me = state.me;
    openModal("👤 Профиль", `
      <label>Имя</label>
      <input id="pName" value="${escapeHtml(me.displayName||"")}" />
      <label>Био</label>
      <input id="pBio" value="${escapeHtml(me.bio||"")}" />
      <label>Дата рождения (YYYY-MM-DD)</label>
      <input id="pBirth" value="${escapeHtml(me.birthDate||"")}" />
      <label>Аватар URL (или оставь пустым)</label>
      <input id="pAvatar" value="${escapeHtml(me.avatarUrl||"")}" />
      <div class="row" style="margin-top:12px; justify-content:flex-end">
        <button id="pSave" class="primary">✅ Сохранить</button>
        <button id="pDelete" class="ghost">🗑️ Удалить аккаунт</button>
      </div>
      <div class="smalltxt" style="margin-top:10px">Удаление только через настройки, как ты просил.</div>
    `);

    setTimeout(() => {
      $("pSave").onclick = async () => {
        const body = {
          displayName: document.getElementById("pName").value,
          bio: document.getElementById("pBio").value,
          birthDate: document.getElementById("pBirth").value,
          avatarUrl: document.getElementById("pAvatar").value
        };
        const data = await apiSend("/api/me", "PUT", body);
        if (!data.ok) return alert("Ошибка: " + data.error);
        await loadMe();
        closeModal();
        alert("✅ Сохранено");
      };
      $("pDelete").onclick = async () => {
        if (!confirm("Точно удалить аккаунт? Это удалит сообщения/истории/сессии.")) return;
        const data = await apiSend("/api/me", "DELETE", {});
        if (!data.ok) return alert("Ошибка: " + data.error);
        localStorage.removeItem("token");
        location.href = "/";
      };
    }, 0);
  }

  // ---------- Groups ----------
  $("newGroupBtn").onclick = () => {
    openModal("👥 Создать группу", `
      <label>Название</label>
      <input id="gName" placeholder="Например: Друзья" />
      <label>Описание</label>
      <input id="gDesc" placeholder="Коротко..." />
      <label>Участники (через запятую: @u1,@u2)</label>
      <input id="gMembers" placeholder="@user1,@user2" />
      <button id="gCreate" class="primary" style="margin-top:12px">✅ Создать</button>
    `);
    setTimeout(() => {
      $("gCreate").onclick = async () => {
        const name = document.getElementById("gName").value.trim();
        const description = document.getElementById("gDesc").value.trim();
        const membersRaw = document.getElementById("gMembers").value.trim();
        const members = membersRaw
          ? membersRaw.split(",").map(s => s.trim()).filter(Boolean).map(x => x.replace(/^@/,""))
          : [];
        const data = await apiSend("/api/groups", "POST", { name, description, members });
        if (!data.ok) return alert("Ошибка: " + data.error);
        closeModal();
        await loadChats();
        state.currentChat = "group:" + data.groupId;
        renderChatList();
        setHeadForChat();
        await loadMessages(state.currentChat);
      };
    }, 0);
  };

  // ---------- Stories ----------
  $("storiesBtn").onclick = async () => {
    const data = await apiGet("/api/stories");
    if (!data.ok) return;
    const stories = data.stories || [];
    openModal("▶ Stories", `
      <div class="row" style="justify-content:space-between; margin-bottom:10px;">
        <div class="muted">Stories живут 24 часа</div>
        <button id="newStory" class="pill">➕ Добавить</button>
      </div>
      ${stories.length ? stories.map(s => `
        <div class="chatitem" style="border:1px solid var(--border); margin:8px 0">
          <div class="chatavatar">${s.avatarUrl ? "🖼️" : avatarEmojiFromName(s.owner)}</div>
          <div class="chatmeta">
            <div class="chatname">@${escapeHtml(s.owner)} <span class="muted">${escapeHtml(s.displayName||"")}</span></div>
            <div class="chatlast">${escapeHtml(s.text||"")}</div>
            ${s.mediaUrl ? `<div style="margin-top:6px">${renderStoryMedia(s)}</div>` : ""}
          </div>
          <div class="chatbadge">${escapeHtml(fmtTime(s.createdAt))}</div>
        </div>
      `).join("") : `<div class="muted">Пока пусто.</div>`}
    `);

    setTimeout(() => {
      $("newStory").onclick = () => {
        openModal("➕ Новая Story", `
          <label>Текст</label>
          <input id="sText" placeholder="Что нового?" />
          <label>Файл (опционально)</label>
          <input id="sFile" type="file" />
          <button id="sPost" class="primary" style="margin-top:12px">➡️ Опубликовать</button>
        `);
        setTimeout(() => {
          $("sPost").onclick = async () => {
            const text = document.getElementById("sText").value;
            const file = document.getElementById("sFile").files[0];
            const fd = new FormData();
            fd.append("text", text);
            if (file) fd.append("file", file);
            const resp = await apiSend("/api/stories", "POST", fd, true);
            if (!resp.ok) return alert("Ошибка: " + resp.error);
            closeModal();
            alert("✅ Story опубликована");
          };
        }, 0);
      };
    }, 0);
  };

  function renderStoryMedia(s) {
    const url = s.mediaUrl;
    if (s.mediaType === "image") return `<img class="media" src="${escapeHtml(url)}" />`;
    if (s.mediaType === "video") return `<video class="media video" src="${escapeHtml(url)}" controls></video>`;
    if (s.mediaType === "audio") return `<audio class="media audio" src="${escapeHtml(url)}" controls></audio>`;
    return `<a class="chip" href="${escapeHtml(url)}" target="_blank">📦 файл</a>`;
  }

  // ---------- Calls (WebRTC audio) ----------
  $("callBtn").onclick = async () => {
    if (!$("callBtn").disabled && state.currentPeer) {
      await startCall(state.currentPeer);
    }
  };

  $("callAccept").onclick = async () => {
    const from = state.rtc.incomingFrom;
    const offer = state.rtc.pendingOffer;
    $("callModal").classList.add("hidden");
    if (from && offer) {
      await acceptCall(from, offer);
      state.rtc.incomingFrom = null;
      state.rtc.pendingOffer = null;
    }
  };
  $("callDecline").onclick = () => {
    const from = state.rtc.incomingFrom;
    $("callModal").classList.add("hidden");
    if (from) wsSend({ type: "call-end", to: from, fromChat: "@" + from });
    state.rtc.incomingFrom = null;
    state.rtc.pendingOffer = null;
  };

  async function setupPeerConnection(withUser) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: "ice", to: withUser, candidate: e.candidate, fromChat: "@" + withUser });
    };

    pc.ontrack = (e) => {
      if (!state.rtc.remoteAudio) {
        state.rtc.remoteAudio = new Audio();
        state.rtc.remoteAudio.autoplay = true;
      }
      state.rtc.remoteAudio.srcObject = e.streams[0];
    };

    state.rtc.pc = pc;
    state.rtc.inCallWith = withUser;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.rtc.localStream = stream;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  }

  async function startCall(toUser) {
    // calls only in dm
    if (!state.currentChat.startsWith("@")) return;
    await setupPeerConnection(toUser);
    const offer = await state.rtc.pc.createOffer();
    await state.rtc.pc.setLocalDescription(offer);

    wsSend({ type: "call-offer", to: toUser, sdp: offer, fromChat: state.currentChat });
    openModal("📞 Звонок", `<div class="muted">Звоним @${escapeHtml(toUser)}…</div><button id="endCallBtn" class="ghost" style="margin-top:12px">❌ Завершить</button>`);
    setTimeout(() => {
      const b = document.getElementById("endCallBtn");
      if (b) b.onclick = () => endCall(false);
    }, 0);
  }

  async function acceptCall(fromUser, offerSdp) {
    await setupPeerConnection(fromUser);
    await state.rtc.pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await state.rtc.pc.createAnswer();
    await state.rtc.pc.setLocalDescription(answer);
    wsSend({ type: "call-answer", to: fromUser, sdp: answer, fromChat: "@" + fromUser });
    openModal("📞 В звонке", `<div class="muted">Разговор с @${escapeHtml(fromUser)}</div><button id="endCallBtn" class="ghost" style="margin-top:12px">❌ Завершить</button>`);
    setTimeout(() => {
      const b = document.getElementById("endCallBtn");
      if (b) b.onclick = () => endCall(false);
    }, 0);
  }

  async function onCallAnswer(data) {
    const from = data.from;
    if (!state.rtc.pc) return;
    await state.rtc.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    // now connected
  }

  async function onIce(data) {
    try {
      if (!state.rtc.pc) return;
      await state.rtc.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {}
  }

  function endCall(remoteEnded) {
    const withUser = state.rtc.inCallWith;
    if (state.rtc.pc) {
      try { state.rtc.pc.close(); } catch {}
    }
    if (state.rtc.localStream) state.rtc.localStream.getTracks().forEach(t => t.stop());
    state.rtc.pc = null;
    state.rtc.localStream = null;
    state.rtc.inCallWith = null;

    if (!remoteEnded && withUser) {
      wsSend({ type: "call-end", to: withUser, fromChat: "@" + withUser });
    }
    closeModal();
  }

  // ---------- Logout ----------
  $("logoutBtn").onclick = () => {
    localStorage.removeItem("token");
    location.href = "/";
  };

  // ---------- Init ----------
  async function init() {
    await loadMe();
    await loadBirthdays();
    await loadChats();
    setHeadForChat();
    await loadMessages(state.currentChat);
    connectWs();

    // mobile: open sidebar by default
    if (window.matchMedia("(max-width: 768px)").matches) {
      $("sidebar").classList.add("mobile-open");
    }
  }

  init().catch((e) => {
    console.error(e);
    alert("Ошибка инициализации");
  });
})();
