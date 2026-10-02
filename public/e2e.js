/* ================================================================
   Zumo — сквозное шифрование личных чатов (e2e.js)
   Подключается в chat.html ПЕРЕД app.js.

   Как устроено:
   • У каждого пользователя пара ключей ECDH P‑256. Закрытый ключ создаётся
     на устройстве и хранится только на нём; на сервер уходит лишь открытый.
   • Для каждой пары собеседников из (мой закрытый + его открытый) выводится
     общий ключ AES‑256‑GCM. Текст шифруется на устройстве отправителя и
     расшифровывается на устройстве получателя. Сервер видит только шифр.
   • Формат сообщения:  e2e:1:<ключ отправителя>:<ключ получателя>:<iv>:<шифр>
   • Резервная копия закрытого ключа (по желанию) шифруется паролем прямо
     на устройстве (PBKDF2 → AES‑GCM); пароль на сервер не передаётся.

   Шифруются: личные чаты 1:1 и «Избранное» (текст, правки, пересылка).
   Не шифруются: группы, каналы, общий чат, поддержка, списки, файлы и медиа.
   ================================================================ */
(function () {
  "use strict";

  const PREFIX = "e2e:1:";
  const subtle = (window.crypto && window.crypto.subtle) || null;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const PBKDF2_ITER = 250000;

  const E2E = {
    state: "init",        // init | ready | need-restore | need-reset | unsupported
    kid: "",
    priv: null,           // CryptoKey (закрытый)
    privJwk: null,
    pubJwk: null,
    serverBackup: "",
    peerCurrent: new Map(), // username -> { at, keyId, publicKey }
    peerByKid: new Map(),   // username:kid -> CryptoKey (открытый)
    aes: new Map()          // username:kid -> CryptoKey (AES)
  };
  window.E2E = E2E;

  // ---------------- мелкие помощники ----------------
  const b64 = (buf) => {
    const a = new Uint8Array(buf); let s = "";
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  };
  const unb64 = (str) => {
    const s = atob(str); const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  };
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const storeKey = () => "zumoE2E:" + me.username;
  const pubOnly = (j) => ({ kty: "EC", crv: "P-256", x: j.x, y: j.y });

  async function kidOf(pub) {
    return hex(await subtle.digest("SHA-256", enc.encode(pub.x + "." + pub.y))).slice(0, 32);
  }
  function fingerprint(kid) {
    return (kid || "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
  }

  async function api(path, method, body) {
    const r = await fetch(path, {
      method: method || "GET",
      headers: body ? { ...authHeaders(), "Content-Type": "application/json" } : authHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });
    return r.json();
  }

  // ---------------- мой ключ ----------------
  async function importPriv(jwk) {
    return subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  }
  async function importPub(jwk) {
    return subtle.importKey("jwk", pubOnly(jwk), { name: "ECDH", namedCurve: "P-256" }, true, []);
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(storeKey());
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveLocal() {
    localStorage.setItem(storeKey(), JSON.stringify({ kid: E2E.kid, priv: E2E.privJwk, pub: E2E.pubJwk }));
  }

  async function adopt(privJwk) {
    E2E.privJwk = privJwk;
    E2E.pubJwk = pubOnly(privJwk);
    E2E.priv = await importPriv(privJwk);
    E2E.kid = await kidOf(E2E.pubJwk);
    E2E.aes.clear();
    saveLocal();
  }

  async function generate() {
    const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    await adopt(await subtle.exportKey("jwk", pair.privateKey));
  }

  async function publish(backup) {
    const body = { keyId: E2E.kid, publicKey: E2E.pubJwk };
    if (backup) body.backup = backup;
    const d = await api("/api/e2e/key", "PUT", body);
    if (!d.ok) throw new Error(d.error || "Не удалось сохранить ключ");
    E2E.serverBackup = backup ? JSON.stringify(backup) : (E2E.serverBackup || "");
  }

  // ---------------- резервная копия под паролем ----------------
  async function wrapKeyFromPassword(password, salt, iter) {
    const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }
  async function makeBackup(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await wrapKeyFromPassword(password, salt, PBKDF2_ITER);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(E2E.privJwk)));
    return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: PBKDF2_ITER, keyId: E2E.kid };
  }
  async function openBackup(backupStr, password) {
    const b = JSON.parse(backupStr);
    const key = await wrapKeyFromPassword(password, unb64(b.salt), b.iter || PBKDF2_ITER);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(b.iv) }, key, unb64(b.ct)); // неверный пароль → исключение
    return JSON.parse(dec.decode(plain));
  }

  // ---------------- ключи собеседников ----------------
  async function peerCurrentKey(username) {
    if (username === me.username && E2E.state === "ready") return { keyId: E2E.kid, publicKey: E2E.pubJwk };
    const c = E2E.peerCurrent.get(username);
    if (c && Date.now() - c.at < 60000) return c;
    const d = await api("/api/e2e/key/" + encodeURIComponent(username));
    const rec = { at: Date.now(), keyId: (d.ok && d.keyId) || "", publicKey: d.ok && d.publicKey ? JSON.parse(d.publicKey) : null };
    E2E.peerCurrent.set(username, rec);
    return rec;
  }

  async function peerPub(username, kid) {
    const id = username + ":" + kid;
    if (E2E.peerByKid.has(id)) return E2E.peerByKid.get(id);
    let jwk = null;
    if (username === me.username && kid === E2E.kid) jwk = E2E.pubJwk;
    else {
      const cur = E2E.peerCurrent.get(username);
      if (cur && cur.keyId === kid) jwk = cur.publicKey;
      else {
        const d = await api("/api/e2e/key/" + encodeURIComponent(username) + "?keyId=" + encodeURIComponent(kid));
        if (d.ok && d.publicKey) jwk = JSON.parse(d.publicKey);
      }
    }
    if (!jwk) throw new Error("нет ключа собеседника");
    const key = await importPub(jwk);
    E2E.peerByKid.set(id, key);
    return key;
  }

  async function aesFor(username, kid) {
    const id = username + ":" + kid;
    if (E2E.aes.has(id)) return E2E.aes.get(id);
    const bits = await subtle.deriveBits({ name: "ECDH", public: await peerPub(username, kid) }, E2E.priv, 256);
    const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("zumo-e2e-v1"), info: new Uint8Array(0) },
      hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    E2E.aes.set(id, key);
    return key;
  }

  // ---------------- шифрование / расшифровка ----------------
  function isCipher(text) { return typeof text === "string" && text.startsWith(PREFIX); }

  // какие чаты шифруются: личные 1:1 и «Избранное»
  function isE2EChat(chat) {
    return !!chat && chat !== "global" && chat !== "support" && !String(chat).startsWith("group:");
  }

  async function encryptFor(peer, plain) {
    const pk = await peerCurrentKey(peer);
    if (!pk.keyId) return null; // у собеседника ещё нет ключа
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesFor(peer, pk.keyId);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
    return PREFIX + E2E.kid + ":" + pk.keyId + ":" + b64(iv) + ":" + b64(ct);
  }

  async function decryptText(cipher, peer, iAmSender) {
    const p = cipher.split(":"); // e2e,1,senderKid,recipientKid,iv,ct
    if (p.length !== 6) throw new Error("формат");
    const myKid = iAmSender ? p[2] : p[3];
    const peerKid = iAmSender ? p[3] : p[2];
    const selfChat = peer === me.username;
    if (!selfChat && myKid !== E2E.kid) throw new Error("другой ключ");
    if (selfChat && p[2] !== E2E.kid && p[3] !== E2E.kid) throw new Error("другой ключ");
    const key = await aesFor(peer, selfChat ? E2E.kid : peerKid);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(p[4]) }, key, unb64(p[5]));
    return dec.decode(plain);
  }

  const FAIL_TEXT = "🔒 Сообщение зашифровано ключом, которого нет на этом устройстве";

  // Расшифровать текст сообщения «на месте». peer — второй участник личного чата.
  async function openOne(obj, peer, iAmSender) {
    if (!obj || !isCipher(obj.text)) return;
    obj.e2e = true;
    obj.e2eRaw = obj.text;
    if (E2E.state !== "ready") { obj.text = FAIL_TEXT; obj.e2eFail = true; return; }
    try { obj.text = await decryptText(obj.text, peer, iAmSender); }
    catch { obj.text = FAIL_TEXT; obj.e2eFail = true; }
  }

  // Сообщения из истории или из сокета
  window.e2eDecryptMessages = async function (list) {
    if (!subtle || !me) return;
    for (const m of list) {
      if (!m || m.chatType !== "private") continue;
      const iAmSender = m.sender === me.username;
      const peer = iAmSender ? m.receiver : m.sender;
      await openOne(m, peer, iAmSender);
      if (m.replyPreview) await openOne(m.replyPreview, peer, m.replyPreview.sender === me.username);
    }
  };

  // Отдельный текст (правка сообщения, превью в списке чатов)
  window.e2eDecryptText = async function (text, sender, receiver) {
    if (!isCipher(text)) return text;
    const o = { text };
    const iAmSender = sender === me.username;
    await openOne(o, iAmSender ? receiver : sender, iAmSender);
    return o.text;
  };

  // Текст для отправки в чат. Возвращает строку (шифр или обычный текст) либо null,
  // если отправлять сейчас нельзя (на устройстве нет ключа).
  window.e2eEncryptFor = async function (chat, text) {
    if (!subtle || !isE2EChat(chat)) return text;
    let pk;
    try { pk = await peerCurrentKey(chat); } catch { pk = { keyId: "" }; }

    if (E2E.state !== "ready") {
      if (E2E.state === "unsupported") return text;
      if (!pk.keyId && chat !== me.username) return text; // собеседник без ключа — шифровать нечем
      alert("На этом устройстве нет твоего ключа шифрования. Восстанови его, чтобы писать в личные чаты.");
      showKeyModal();
      return null;
    }
    try {
      const c = await encryptFor(chat, text);
      return c == null ? text : c;
    } catch {
      alert("Не удалось зашифровать сообщение. Проверь соединение и попробуй ещё раз.");
      return null;
    }
  };

  // Подсказка в начале личного чата
  window.e2eChatHint = async function (chat) {
    if (!subtle || !isE2EChat(chat)) return "";
    if (E2E.state !== "ready") {
      return E2E.state === "unsupported" ? "" :
        `<div class="e2ehint warn" onclick="e2eShowKeyModal()">🔑 На этом устройстве нет ключа шифрования — нажми, чтобы восстановить</div>`;
    }
    let pk; try { pk = await peerCurrentKey(chat); } catch { return ""; }
    if (!pk.keyId) return `<div class="e2ehint warn">Собеседник ещё не открывал обновлённое приложение — пока сообщения не шифруются</div>`;
    return `<div class="e2ehint">🔒 Сообщения в этом чате защищены сквозным шифрованием — их видите только вы</div>`;
  };

  window.e2eIsCipher = isCipher;
  window.e2eIsChat = isE2EChat;

  // ---------------- запуск ----------------
  window.e2eInit = async function () {
    if (!subtle) { E2E.state = "unsupported"; renderSettings(); return; }
    try {
      const srv = await api("/api/e2e/me");
      if (!srv.ok) throw new Error("server");
      E2E.serverBackup = srv.backup || "";

      const local = loadLocal();
      if (local && local.priv) await adopt(local.priv);

      if (E2E.priv && srv.keyId === E2E.kid) {
        E2E.state = "ready";
      } else if (E2E.priv && !srv.keyId) {
        await publish();
        E2E.state = "ready";
      } else if (!E2E.priv && !srv.keyId) {
        await generate();
        await publish();
        E2E.state = "ready";
        setTimeout(() => showBackupModal(true), 1200); // первый запуск — сразу предлагаем резервную копию
      } else {
        // на сервере другой ключ: он создан на другом устройстве (или наш устарел)
        E2E.priv = null; E2E.kid = ""; E2E.aes.clear();
        E2E.state = srv.backup ? "need-restore" : "need-reset";
        setTimeout(showKeyModal, 800);
      }
    } catch (e) {
      console.warn("[E2E] init:", e && e.message);
      if (E2E.state === "init") E2E.state = E2E.priv ? "ready" : "need-reset";
    }
    renderSettings();
  };

  async function afterKeyChanged() {
    renderSettings();
    try {
      await refreshChats();
      if (isE2EChat(currentChat)) await loadMessages();
    } catch {}
  }

  // ---------------- окна ----------------
  const CSS = `
  .e2ehint{margin:8px auto 12px;max-width:340px;padding:8px 12px;border-radius:12px;font-size:12px;line-height:1.4;
    text-align:center;color:#cfe6ff;background:rgba(42,157,244,.14);border:1px solid rgba(42,157,244,.25)}
  .e2ehint.warn{color:#ffe2b0;background:rgba(255,170,60,.12);border-color:rgba(255,170,60,.3);cursor:pointer}
  .e2emodal{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.6)}
  .e2emodal.hidden{display:none}
  .e2ecard{width:min(400px,100%);padding:22px;border-radius:22px;background:#122033;border:1px solid rgba(255,255,255,.12);
    color:#eaf2ff;display:flex;flex-direction:column;gap:12px;box-shadow:0 30px 60px -20px rgba(0,0,0,.8)}
  .e2ecard h3{margin:0;font-size:18px}
  .e2ecard p{margin:0;font-size:14px;line-height:1.5;color:#b8c8dd}
  .e2ecard input{padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.25);
    color:#fff;font-size:15px;outline:none}
  .e2ecard .e2eerr{color:#ff8a8a;font-size:13px;min-height:16px}
  .e2ecard .e2ebtns{display:flex;flex-direction:column;gap:8px}
  .e2efp{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.5px;color:#9fc4ee;overflow-wrap:anywhere}
  `;

  let modalEl = null;
  function modal(html) {
    if (!modalEl) {
      const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
      modalEl = document.createElement("div");
      modalEl.className = "e2emodal hidden";
      document.body.appendChild(modalEl);
    }
    modalEl.innerHTML = `<div class="e2ecard">${html}</div>`;
    modalEl.classList.remove("hidden");
    const inp = modalEl.querySelector("input");
    if (inp) setTimeout(() => inp.focus(), 50);
  }
  function closeModal() { if (modalEl) modalEl.classList.add("hidden"); }
  window.e2eCloseModal = closeModal;

  // Создание / смена резервной копии
  function showBackupModal(firstRun) {
    if (E2E.state !== "ready") return;
    modal(`
      <h3>🔒 ${firstRun ? "Сквозное шифрование включено" : "Резервная копия ключа"}</h3>
      <p>${firstRun ? "Личные сообщения теперь шифруются на твоём устройстве — их не видит никто, кроме тебя и собеседника. " : ""}
         Придумай пароль для резервной копии ключа. Он понадобится, чтобы читать переписку на новом телефоне или после очистки браузера.</p>
      <p><b>Если забыть пароль и потерять устройство — старые сообщения прочитать будет нельзя.</b> Восстановить его не сможет никто, включая поддержку.</p>
      <input id="e2ePw1" type="password" placeholder="Пароль (минимум 8 символов)" autocomplete="new-password">
      <input id="e2ePw2" type="password" placeholder="Повтори пароль" autocomplete="new-password">
      <div class="e2eerr" id="e2eErr"></div>
      <div class="e2ebtns">
        <button class="btn primary full" onclick="e2eSaveBackup()">Сохранить резервную копию</button>
        <button class="btn ghost full" onclick="e2eCloseModal()">${firstRun ? "Позже" : "Отмена"}</button>
      </div>
    `);
  }
  window.e2eShowBackupModal = () => showBackupModal(false);

  window.e2eSaveBackup = async function () {
    const p1 = document.getElementById("e2ePw1").value, p2 = document.getElementById("e2ePw2").value;
    const err = document.getElementById("e2eErr");
    if (p1.length < 8) { err.textContent = "Пароль слишком короткий — минимум 8 символов"; return; }
    if (p1 !== p2) { err.textContent = "Пароли не совпадают"; return; }
    err.textContent = "Шифруем...";
    try {
      const backup = await makeBackup(p1);
      const d = await api("/api/e2e/backup", "PUT", { backup });
      if (!d.ok) throw new Error(d.error);
      E2E.serverBackup = JSON.stringify(backup);
      closeModal();
      toast("Резервная копия ключа сохранена ✅");
      renderSettings();
    } catch (e) { err.textContent = (e && e.message) || "Не удалось сохранить"; }
  };

  // На устройстве нет ключа, а на сервере он уже есть
  function showKeyModal() {
    if (E2E.state === "need-restore") {
      modal(`
        <h3>🔑 Восстановление ключа шифрования</h3>
        <p>Твои личные чаты защищены сквозным шифрованием. Чтобы читать их на этом устройстве, введи пароль резервной копии ключа.</p>
        <input id="e2ePw" type="password" placeholder="Пароль резервной копии" autocomplete="current-password"
               onkeydown="if(event.key==='Enter') e2eRestore()">
        <div class="e2eerr" id="e2eErr"></div>
        <div class="e2ebtns">
          <button class="btn primary full" onclick="e2eRestore()">Восстановить</button>
          <button class="btn ghost full" onclick="e2eCloseModal()">Позже</button>
          <button class="btn danger full" onclick="e2eResetKey()">Не помню пароль — создать новый ключ</button>
        </div>
      `);
    } else if (E2E.state === "need-reset") {
      modal(`
        <h3>🔑 Ключ шифрования на другом устройстве</h3>
        <p>Ключ от твоих личных чатов хранится на устройстве, где ты входил(а) раньше, и резервной копии у него нет.</p>
        <p>Открой Zumo на том устройстве → Настройки → Безопасность → «Сквозное шифрование» → создай резервную копию, а потом вернись сюда.</p>
        <p>Либо создай новый ключ здесь — но тогда <b>прежние зашифрованные сообщения перестанут читаться</b> на всех устройствах.</p>
        <div class="e2eerr" id="e2eErr"></div>
        <div class="e2ebtns">
          <button class="btn ghost full" onclick="e2eCloseModal()">Понятно, вернусь позже</button>
          <button class="btn danger full" onclick="e2eResetKey()">Создать новый ключ</button>
        </div>
      `);
    }
  }
  window.e2eShowKeyModal = showKeyModal;

  window.e2eRestore = async function () {
    const err = document.getElementById("e2eErr");
    const pw = document.getElementById("e2ePw").value;
    if (!pw) return;
    err.textContent = "Проверяем...";
    try {
      const privJwk = await openBackup(E2E.serverBackup, pw);
      await adopt(privJwk);
      const srv = await api("/api/e2e/me");
      if (srv.keyId !== E2E.kid) await publish(JSON.parse(E2E.serverBackup)); // копия от прежнего ключа — делаем его текущим
      E2E.state = "ready";
      closeModal();
      toast("Ключ восстановлен ✅");
      await afterKeyChanged();
    } catch {
      E2E.priv = null; E2E.kid = "";
      err.textContent = "Неверный пароль";
    }
  };

  window.e2eResetKey = async function () {
    if (!confirm("Создать новый ключ шифрования? Прежние зашифрованные сообщения перестанут читаться. Это нельзя отменить.")) return;
    try {
      await generate();
      E2E.serverBackup = "";
      await publish();
      E2E.state = "ready";
      closeModal();
      toast("Создан новый ключ шифрования");
      await afterKeyChanged();
      setTimeout(() => showBackupModal(false), 600);
    } catch (e) {
      alert((e && e.message) || "Не удалось создать ключ");
    }
  };

  // ---------------- блок в настройках ----------------
  function renderSettings() {
    const box = document.getElementById("e2eSection");
    if (!box) return;
    if (E2E.state === "unsupported") {
      box.innerHTML = `<div class="hint">Этот браузер не поддерживает шифрование — сообщения отправляются без него.</div>`;
      return;
    }
    if (E2E.state !== "ready") {
      box.innerHTML = `
        <div class="hint">На этом устройстве нет ключа шифрования — зашифрованные сообщения не читаются.</div>
        <button class="btn primary full" onclick="e2eShowKeyModal()"><i class="fa-solid fa-key"></i> Восстановить ключ</button>`;
      return;
    }
    const hasBackup = !!E2E.serverBackup;
    box.innerHTML = `
      <div class="hint">🔒 Личные чаты и «Избранное» шифруются на твоём устройстве. Сервер хранит только шифр и прочитать его не может.</div>
      <div class="hint">Отпечаток твоего ключа:<br><span class="e2efp">${fingerprint(E2E.kid)}</span></div>
      <div class="hint">${hasBackup
        ? "✅ Резервная копия ключа создана — на новом устройстве понадобится её пароль."
        : "⚠️ Резервной копии нет. Если очистить браузер или сменить телефон, переписка станет нечитаемой."}</div>
      <button class="btn ${hasBackup ? "ghost" : "primary"} full" onclick="e2eShowBackupModal()">
        <i class="fa-solid fa-shield-halved"></i> ${hasBackup ? "Сменить пароль резервной копии" : "Создать резервную копию ключа"}
      </button>
      <button class="btn danger full" onclick="e2eResetKey()"><i class="fa-solid fa-rotate"></i> Создать новый ключ</button>`;
  }
  window.e2eRenderSettings = renderSettings;
})();
