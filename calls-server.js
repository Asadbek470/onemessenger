// ================================================================
// One Messenger — серверная часть звонков (calls-server.js)
// Положи рядом с server.js. Подключается одной вставкой (см. инструкцию).
//
//  • 1:1 звонки (аудио и видео) с «ожидающим звонком»: если человек не в сети
//    или телефон заблокирован — ему уходит push с кнопками «Принять/Отклонить»,
//    а сам звонок ждёт его 45 секунд.
//  • /api/rtc-config — отдаёт STUN + TURN (нужен для дальних звонков).
//  • Групповые звонки через LiveKit (аудио + видео, много участников).
// ================================================================
const crypto = require("crypto");

module.exports = function setupCalls(ctx) {
  const {
    app, verifyAuth, rateLimit, dbGet, dbAll, dbRun,
    isOnline, wsSend, wsSendToUser, getUserCard, isMember, getWebpush, canCall
  } = ctx;

  const RING_MS = 45 * 1000;
  const SIGNAL_TYPES = new Set(["call-offer", "call-answer", "ice", "call-end", "call-reject"]);
  const clean = (u) => String(u || "").replace(/^@+/, "").toLowerCase();

  // callId -> { callId, from, to, offer, video, ice[], answered, timer }
  const pending = new Map();

  function findPending(from, to) {
    for (const c of pending.values()) if (c.from === from && c.to === to) return c;
    return null;
  }
  function dropPending(c) {
    if (!c) return;
    clearTimeout(c.timer);
    pending.delete(c.callId);
  }

  // ---------------- push именно для звонков (высокий приоритет, короткий TTL) ----------------
  async function pushTo(username, payload, opts = {}) {
    const webpush = getWebpush && getWebpush();
    if (!webpush) return;
    let subs = [];
    try { subs = await dbAll(`SELECT * FROM push_subscriptions WHERE username=?`, [username]); } catch { return; }
    for (const row of subs) {
      let sub;
      try { sub = JSON.parse(row.subscriptionJson); } catch { continue; }
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), {
          TTL: opts.ttl != null ? opts.ttl : 45,
          urgency: opts.urgency || "high"
        });
      } catch (err) {
        if (err && (err.statusCode === 410 || err.statusCode === 404)) {
          dbRun(`DELETE FROM push_subscriptions WHERE endpoint=?`, [row.endpoint]).catch(() => {});
        }
      }
    }
  }

  // ---------------- сигналинг 1:1 ----------------
  function onTimeout(call) {
    if (!pending.has(call.callId) || call.answered) return;
    dropPending(call);
    wsSendToUser(call.from, { type: "call-reject", from: call.to, reason: "noanswer" });
    wsSendToUser(call.to, { type: "call-end", from: call.from });
    pushTo(call.to, {
      type: "call-cancel", callId: call.callId, missed: true,
      title: "Пропущенный звонок", body: `Пропущенный звонок от @${call.from}`, url: "/chat.html"
    }, { ttl: 3600, urgency: "normal" }).catch(() => {});
  }

  async function handle(ws, data, from) {
    const type = data.type;
    const to = clean(data.to);
    if (!to || to === from) return;

    if (type === "call-offer") {
      if (!data.offer) return;

      if (canCall && !(await canCall(to, from))) {
        wsSend(ws, { type: "call-reject", from: to, reason: "blocked" });
        return;
      }

      // старый неотвеченный звонок этого человека этому же адресату заменяем новым
      const old = findPending(from, to);
      if (old) dropPending(old);

      const callId = crypto.randomBytes(12).toString("hex");
      const video = !!data.video;
      const call = { callId, from, to, offer: data.offer, video, ice: [], answered: false };
      call.timer = setTimeout(() => onTimeout(call), RING_MS);
      pending.set(callId, call); // синхронно, чтобы не потерять ICE, пришедший следом

      const online = isOnline(to);
      if (online) wsSendToUser(to, { type: "call-offer", from, offer: data.offer, video, callId });
      wsSend(ws, { type: "call-ringing", to, callId, online });

      // push шлём всегда: если приложение открыто, service worker его просто не покажет
      const card = await getUserCard(from);
      const name = card.displayName || ("@" + from);
      pushTo(to, {
        type: "call", callId, from, video,
        title: video ? "📹 Видеозвонок" : "📞 Звонок",
        body: `${name} звонит тебе`,
        url: `/chat.html?acceptCall=${callId}`
      }).catch(() => {});
      return;
    }

    if (type === "call-answer") {
      const c = findPending(to, from);
      if (c) { c.answered = true; dropPending(c); }
      wsSendToUser(to, { ...data, from });
      return;
    }

    if (type === "ice") {
      const c = findPending(from, to);
      if (c && !c.answered && data.candidate) c.ice.push(data.candidate);
      wsSendToUser(to, { ...data, from });
      return;
    }

    if (type === "call-reject") {
      dropPending(findPending(to, from));
      wsSendToUser(to, { ...data, from });
      return;
    }

    if (type === "call-end") {
      const c = findPending(from, to);
      if (c && !c.answered) {
        dropPending(c);
        pushTo(to, {
          type: "call-cancel", callId: c.callId, missed: true,
          title: "Пропущенный звонок", body: `Пропущенный звонок от @${from}`, url: "/chat.html"
        }, { ttl: 3600, urgency: "normal" }).catch(() => {});
      }
      wsSendToUser(to, { ...data, from });
      return;
    }
  }

  function handleSignal(ws, data, from) {
    if (!data || !SIGNAL_TYPES.has(data.type)) return false;
    handle(ws, data, from).catch((e) => console.error("[CALLS]", e.message));
    return true;
  }

  // Человек только что подключился (открыл приложение по уведомлению) —
  // отдаём ему звонок, который его ждёт
  function onConnect(ws, username) {
    for (const c of pending.values()) {
      if (c.to !== username || c.answered) continue;
      wsSend(ws, { type: "call-offer", from: c.from, offer: c.offer, video: c.video, callId: c.callId, replay: true });
      c.ice.forEach((cand) => wsSend(ws, { type: "ice", from: c.from, candidate: cand }));
    }
  }

  // «Отклонить» из уведомления (service worker, без входа в аккаунт).
  // callId — случайный и одноразовый, угадать его нельзя.
  app.post(
    "/api/call/decline",
    rateLimit ? rateLimit(30, 60 * 1000) : (req, res, next) => next(),
    (req, res) => {
      const c = pending.get(String(req.body.callId || ""));
      if (c && !c.answered) {
        dropPending(c);
        wsSendToUser(c.from, { type: "call-reject", from: c.to });
      }
      res.json({ ok: true });
    }
  );

  // ---------------- STUN / TURN ----------------
  // Вариант А: TURN_URLS="turn:host:3478,turns:host:5349" + TURN_USERNAME + TURN_CREDENTIAL
  // Вариант Б: METERED_DOMAIN="имя.metered.live" + METERED_API_KEY
  let iceCache = null;
  async function loadIce() {
    if (iceCache && Date.now() - iceCache.at < 10 * 60 * 1000) return iceCache;

    let list = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
    let hasTurn = false;

    const urls = String(process.env.TURN_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      list.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
      hasTurn = true;
    }

    if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
      try {
        const r = await fetch(
          `https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`
        );
        const j = await r.json();
        if (Array.isArray(j) && j.length) { list = list.concat(j); hasTurn = true; }
      } catch (e) {
        console.warn("[CALLS] Не удалось получить TURN у Metered:", e.message);
      }
    }

    if (!hasTurn) console.warn("[CALLS] TURN не настроен — звонки между разными сетями/операторами могут не соединяться.");
    iceCache = { at: Date.now(), list, hasTurn };
    return iceCache;
  }

  app.get("/api/rtc-config", verifyAuth, async (req, res) => {
    const c = await loadIce();
    res.json({ ok: true, iceServers: c.list, hasTurn: c.hasTurn, groupCalls: lkConfigured() });
  });

  // ---------------- групповые звонки (LiveKit) ----------------
  function lkConfigured() {
    return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  }

  // Токен LiveKit — это обычный JWT (HS256), подписанный секретом LiveKit.
  // Делаем его через jsonwebtoken, который уже есть в проекте, —
  // отдельный пакет livekit-server-sdk НЕ нужен.
  async function makeLkToken(identity, name, room) {
    const jwt = require("jsonwebtoken");
    const nowSec = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        name,
        nbf: nowSec - 10,
        video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true }
      },
      process.env.LIVEKIT_API_SECRET,
      { algorithm: "HS256", issuer: process.env.LIVEKIT_API_KEY, subject: identity, expiresIn: "6h" }
    );
  }

  // chat -> { from, video, startedAt, parts: Map(username -> lastPing) }
  const groupCalls = new Map();

  async function groupMembers(gid) {
    const rows = await dbAll(`SELECT username FROM group_members WHERE groupId=?`, [gid]);
    return rows.map((r) => r.username);
  }

  async function endGroup(chat) {
    groupCalls.delete(chat);
    const gid = Number(chat.slice(6));
    try {
      (await groupMembers(gid)).forEach((u) => wsSendToUser(u, { type: "group-call-ended", chat }));
    } catch {}
  }

  setInterval(() => {
    const t = Date.now();
    for (const [chat, g] of [...groupCalls]) {
      for (const [u, ts] of g.parts) if (t - ts > 70 * 1000) g.parts.delete(u);
      if (g.parts.size === 0) endGroup(chat);
    }
  }, 15 * 1000);

  async function checkGroup(req, res) {
    const chat = String(req.body.chat || req.query.chat || "");
    if (!/^group:\d+$/.test(chat)) { res.status(400).json({ ok: false, error: "Неверный чат" }); return null; }
    const gid = Number(chat.slice(6));
    const role = await isMember(gid, req.user.username);
    if (!role) { res.status(403).json({ ok: false, error: "Ты не участник этой группы" }); return null; }
    const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [gid]);
    if (!group) { res.status(404).json({ ok: false, error: "Группа не найдена" }); return null; }
    return { chat, gid, group };
  }

  app.post("/api/group-call/join", verifyAuth, async (req, res) => {
    const g = await checkGroup(req, res);
    if (!g) return;
    if (g.group.isChannel) return res.status(400).json({ ok: false, error: "В каналах звонки недоступны" });
    if (!lkConfigured()) {
      return res.status(503).json({ ok: false, error: "Групповые звонки ещё не настроены на сервере (нужен LiveKit)" });
    }

    const me = req.user.username;
    let token;
    try {
      token = await makeLkToken(me, req.user.displayName || me, `om-${g.chat.replace(":", "-")}`);
    } catch (e) {
      console.error("[CALLS] LiveKit token:", e.message);
      return res.status(500).json({ ok: false, error: "Не удалось создать токен звонка" });
    }

    const video = !!req.body.video;
    let call = groupCalls.get(g.chat);
    const fresh = !call;
    if (!call) {
      call = { from: me, video, startedAt: Date.now(), parts: new Map() };
      groupCalls.set(g.chat, call);
    }
    call.parts.set(me, Date.now());

    if (fresh) {
      const name = req.user.displayName || ("@" + me);
      (await groupMembers(g.gid)).filter((u) => u !== me).forEach((u) => {
        wsSendToUser(u, { type: "group-call", chat: g.chat, groupName: g.group.name, from: me, fromName: name, video });
        if (!isOnline(u)) {
          pushTo(u, {
            type: "group-call", chat: g.chat, groupId: g.gid,
            title: `👥 ${g.group.name}`,
            body: `${name} начал(а) ${video ? "видео" : "аудио"}звонок`,
            url: `/chat.html?joinGroup=${g.gid}`
          }, { ttl: 120 }).catch(() => {});
        }
      });
    }

    res.json({ ok: true, url: process.env.LIVEKIT_URL, token });
  });

  app.post("/api/group-call/ping", verifyAuth, async (req, res) => {
    const chat = String(req.body.chat || "");
    const call = groupCalls.get(chat);
    if (call && call.parts.has(req.user.username)) call.parts.set(req.user.username, Date.now());
    res.json({ ok: true });
  });

  app.post("/api/group-call/leave", verifyAuth, async (req, res) => {
    const chat = String(req.body.chat || "");
    const call = groupCalls.get(chat);
    if (call) {
      call.parts.delete(req.user.username);
      if (call.parts.size === 0) endGroup(chat);
    }
    res.json({ ok: true });
  });

  app.get("/api/group-call/active", verifyAuth, async (req, res) => {
    const g = await checkGroup(req, res);
    if (!g) return;
    const call = groupCalls.get(g.chat);
    if (!call) return res.json({ ok: true, active: false });
    res.json({
      ok: true, active: true, video: call.video, from: call.from,
      count: call.parts.size, groupName: g.group.name
    });
  });

  return { handleSignal, onConnect };
};
