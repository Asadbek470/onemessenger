/* ================================================================
   One Messenger — расширенные звонки (calls-client.js)
   Подключить в chat.html ПОСЛЕ app.js:
       <script src="calls-client.js?v=1"></script>
   app.js менять не нужно: этот файл переопределяет функции звонков.

   Что умеет:
   • аудио и ВИДЕО звонки 1:1 (переключение камеры, выкл. камеры/микрофона)
   • звонки через TURN-сервер (дальние расстояния, разные операторы)
   • исправлена потеря ICE-кандидатов до нажатия «Принять»
   • принять звонок из push-уведомления (телефон заблокирован / приложение закрыто)
   • групповые аудио/видео звонки через LiveKit
   ================================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LK_SRC = "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js";
  const RING_GUARD_MS = 55000;
  const CONNECT_GUARD_MS = 25000;

  // ---------------- состояние ----------------
  let callVideo = false;
  let callMode = null;                 // 'p2p' | 'group' | null
  let activeCallId = null;
  let incomingCallId = null, incomingVideo = false;
  let pendingIce = [];                 // входящие кандидаты, пришедшие раньше времени
  let localIce = [], signalReady = false;
  let ringGuard = null, connectGuard = null, discTimer = null;
  let wakeLock = null, facing = "user";
  let overlayTimer = null, overlayStart = 0;
  let autoAcceptId = null;
  let iceCache = null;
  const seenCallIds = new Set();

  // группа
  let lkRoom = null, lkPromise = null, groupChatKey = null, pingTimer = null;
  const tiles = new Map();
  let bannerChat = null;

  // ---------------- РИНГТОН (громкий звук + вибрация до ответа) ----------------
  let ringAudioCtx = null;
  let ringTimer = null, ringVibeTimer = null;

  // Разблокируем звук по первому касанию/клику в приложении — иначе браузер
  // не даст программно включить звук без явного жеста пользователя,
  // и входящий звонок будет "немым".
  function unlockRingAudio() {
    if (ringAudioCtx) return;
    try {
      ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ringAudioCtx.state === "suspended") ringAudioCtx.resume().catch(() => {});
    } catch {}
  }
  ["pointerdown", "touchstart", "keydown"].forEach((ev) =>
    document.addEventListener(ev, unlockRingAudio, { once: true, passive: true })
  );

  // Один "дзынь-дзынь" классического телефонного рингтона
  function ringBurst() {
    if (!ringAudioCtx) return;
    if (ringAudioCtx.state === "suspended") ringAudioCtx.resume().catch(() => {});
    const ctx = ringAudioCtx;
    const now0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.9; // громко
    master.connect(ctx.destination);

    const playTone = (start, dur) => {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const g = ctx.createGain();
      osc1.type = "sine"; osc1.frequency.value = 950;
      osc2.type = "sine"; osc2.frequency.value = 1400;
      g.gain.setValueAtTime(0, now0 + start);
      g.gain.linearRampToValueAtTime(1, now0 + start + 0.03);
      g.gain.setValueAtTime(1, now0 + start + dur - 0.05);
      g.gain.linearRampToValueAtTime(0, now0 + start + dur);
      osc1.connect(g); osc2.connect(g); g.connect(master);
      osc1.start(now0 + start); osc2.start(now0 + start);
      osc1.stop(now0 + start + dur); osc2.stop(now0 + start + dur);
    };

    // два коротких гудка подряд — как классический вызов
    playTone(0, 0.4);
    playTone(0.5, 0.4);
  }

  function startRingtone() {
    stopRingtone();
    unlockRingAudio();
    ringBurst();
    ringTimer = setInterval(ringBurst, 2000);

    // непрерывная сильная вибрация до ответа (Android; iOS Safari её не поддерживает)
    const vibe = () => { try { navigator.vibrate && navigator.vibrate([700, 400, 700, 400]); } catch {} };
    vibe();
    ringVibeTimer = setInterval(vibe, 2200);
  }

  function stopRingtone() {
    clearInterval(ringTimer); ringTimer = null;
    clearInterval(ringVibeTimer); ringVibeTimer = null;
    try { navigator.vibrate && navigator.vibrate(0); } catch {}
  }

  // ---------------- стили ----------------
  const CSS = `
  .toast{z-index:400}
  .omcall{position:fixed;inset:0;z-index:250;background:#0b1420;display:flex;flex-direction:column;color:#fff}
  .omcall.hidden{display:none!important}
  #omP2P{position:absolute;inset:0}
  #omRemoteVideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;z-index:1}
  .omph{position:absolute;inset:0;display:grid;place-items:center;z-index:0}
  .omph .omphava{width:140px;height:140px;border-radius:50%;overflow:hidden}
  #omLocalVideo{position:absolute;right:14px;top:calc(env(safe-area-inset-top,0px) + 76px);width:104px;height:150px;
    object-fit:cover;border-radius:16px;border:2px solid rgba(255,255,255,.4);z-index:3;background:#000;transform:scaleX(-1)}
  #omLocalVideo.back{transform:none}
  .omtop{position:absolute;left:0;right:0;top:0;z-index:4;padding:calc(env(safe-area-inset-top,0px) + 14px) 16px 34px;
    text-align:center;background:linear-gradient(rgba(0,0,0,.55),transparent)}
  #omName{font-weight:800;font-size:18px}
  #omStatus{margin-top:2px;font-size:14px;opacity:.85;font-variant-numeric:tabular-nums}
  .omctrls{position:absolute;left:0;right:0;bottom:0;z-index:4;display:flex;justify-content:center;gap:16px;
    padding:22px 16px calc(env(safe-area-inset-bottom,0px) + 24px);background:linear-gradient(transparent,rgba(0,0,0,.65))}
  .omb{width:58px;height:58px;border-radius:50%;border:none;color:#fff;font-size:20px;cursor:pointer;
    background:rgba(255,255,255,.2);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .omb.off{background:#fff;color:#111}
  .omb.end{background:#ff4d4d}
  .omb:active{transform:scale(.92)}
  .omgrid{position:absolute;inset:0;padding:calc(env(safe-area-inset-top,0px) + 70px) 8px 120px;overflow:auto;z-index:2;
    display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-content:center}
  .omgrid.hidden{display:none!important}
  .omtile{position:relative;border-radius:16px;overflow:hidden;aspect-ratio:3/4;background:#17212b;display:grid;place-items:center}
  .omtile .omava{width:72px;height:72px;border-radius:50%;overflow:hidden}
  .omtile .omvid{position:absolute;inset:0;display:none}
  .omtile.hasvideo .omvid{display:block}
  .omtile .omvid video{width:100%;height:100%;object-fit:cover}
  .omtile .omnm{position:absolute;left:8px;bottom:8px;right:8px;font-size:13px;font-weight:700;
    text-shadow:0 1px 4px rgba(0,0,0,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .omtile.speaking{box-shadow:inset 0 0 0 3px #43e08a}
  .ombanner{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 10px);z-index:240;
    display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:16px;color:#fff;
    background:linear-gradient(135deg,#2a9df4,#5b6dff);box-shadow:0 14px 30px -12px rgba(0,0,0,.7)}
  .ombanner.hidden{display:none!important}
  .ombanner .omtxt{flex:1;min-width:0;font-size:14px;font-weight:700}
  .ombanner .btn{min-height:36px}
  .ombanner .omx{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 6px}
  `;

  // ---------------- интерфейс ----------------
  function buildUi() {
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div id="omCall" class="omcall hidden">
        <div id="omP2P">
          <div class="omph"><div id="omPh" class="omphava"></div></div>
          <video id="omRemoteVideo" autoplay playsinline></video>
          <video id="omLocalVideo" autoplay playsinline muted></video>
        </div>
        <div id="omGrid" class="omgrid hidden"></div>
        <div class="omtop"><div id="omName"></div><div id="omStatus"></div></div>
        <div class="omctrls">
          <button id="omMute" class="omb" onclick="omToggleMute()" title="Микрофон"><i class="fa-solid fa-microphone"></i></button>
          <button id="omCam" class="omb" onclick="omToggleCam()" title="Камера"><i class="fa-solid fa-video"></i></button>
          <button id="omFlip" class="omb" onclick="omFlip()" title="Перевернуть камеру"><i class="fa-solid fa-camera-rotate"></i></button>
          <button class="omb end" onclick="omEnd()" title="Завершить"><i class="fa-solid fa-phone-slash"></i></button>
        </div>
        <div id="omAudioSink" style="display:none"></div>
      </div>
      <div id="omBanner" class="ombanner hidden"></div>
    `;
    document.body.appendChild(wrap);

    const actions = document.querySelector("#screenChat .topbar .actions");
    const callBtn = $("callBtn");
    if (actions) {
      const vb = document.createElement("button");
      vb.id = "omVideoBtn"; vb.className = "iconbtn"; vb.title = "Видеозвонок";
      vb.style.display = "none";
      vb.innerHTML = '<i class="fa-solid fa-video"></i>';
      vb.onclick = () => (isGroupChat(currentChat) ? startGroupCall(true) : startCall(true));

      const pb = document.createElement("button");
      pb.id = "omGroupPhoneBtn"; pb.className = "iconbtn"; pb.title = "Групповой аудиозвонок";
      pb.style.display = "none";
      pb.innerHTML = '<i class="fa-solid fa-phone"></i>';
      pb.onclick = () => startGroupCall(false);

      actions.insertBefore(vb, callBtn);
      actions.insertBefore(pb, callBtn);
    }
  }

  function syncButtons() {
    const vb = $("omVideoBtn"), pb = $("omGroupPhoneBtn");
    if (!vb || !pb) return;
    const priv = isPrivateChat(currentChat);
    const grp = isGroupChat(currentChat) && !(currentGroupMeta && currentGroupMeta.isChannel);
    vb.style.display = priv || grp ? "inline-grid" : "none";
    pb.style.display = grp ? "inline-grid" : "none";
  }

  function setStatus(text) {
    const a = $("callStatus"); if (a) a.textContent = text;
    const b = $("omStatus"); if (b) b.textContent = text;
  }

  function showOverlay(mode, name) {
    $("omCall").classList.remove("hidden");
    $("omP2P").style.display = mode === "p2p" ? "block" : "none";
    $("omGrid").classList.toggle("hidden", mode !== "group");
    $("omName").textContent = name || "";
    $("omMute").className = "omb";
    $("omMute").innerHTML = '<i class="fa-solid fa-microphone"></i>';
    $("omCam").className = "omb";
    $("omCam").innerHTML = '<i class="fa-solid fa-video"></i>';
    requestWake();
  }
  function hideOverlay() {
    const o = $("omCall");
    if (o) o.classList.add("hidden");
    stopOverlayTimer();
    releaseWake();
  }
  function startOverlayTimer() {
    if (overlayTimer) return;
    overlayStart = Date.now();
    overlayTimer = setInterval(() => {
      const s = Math.floor((Date.now() - overlayStart) / 1000);
      const el = $("omStatus");
      if (el) el.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 1000);
  }
  function stopOverlayTimer() { clearInterval(overlayTimer); overlayTimer = null; }

  function requestWake() {
    try {
      if (navigator.wakeLock) navigator.wakeLock.request("screen").then((l) => { wakeLock = l; }).catch(() => {});
    } catch {}
  }
  function releaseWake() {
    try { if (wakeLock) wakeLock.release(); } catch {}
    wakeLock = null;
  }

  // ---------------- STUN / TURN ----------------
  async function getRtc() {
    if (iceCache && Date.now() - iceCache.at < 5 * 60 * 1000) return iceCache.cfg;
    try {
      const r = await fetch("/api/rtc-config", { headers: authHeaders() });
      const d = await r.json();
      if (d.ok && d.iceServers && d.iceServers.length) {
        iceCache = { at: Date.now(), cfg: { iceServers: d.iceServers }, hasTurn: !!d.hasTurn };
        return iceCache.cfg;
      }
    } catch {}
    return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  }

  async function getMedia(video) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!video) return navigator.mediaDevices.getUserMedia({ audio, video: false });
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio,
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }
      });
    } catch {
      toast("Камера недоступна — продолжаем без видео");
      callVideo = false;
      return navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
  }

  // ---------------- 1:1: интерфейс звонка ----------------
  async function showP2PUi(peer, status, video) {
    callMode = "p2p";
    if (video) {
      const info = await getUserInfo(peer);
      $("omPh").innerHTML = avatarHtml(info);
      showOverlay("p2p", info.displayName || "@" + peer);
      setStatus(status);
    } else {
      await openCall(peer, status);
    }
  }

  function bindRemote() {
    const hasVideo = remoteStream && remoteStream.getVideoTracks().length > 0;
    const rv = $("omRemoteVideo"), ra = $("remoteAudio");
    if (hasVideo) {
      if (rv.srcObject !== remoteStream) rv.srcObject = remoteStream;
      ra.srcObject = null;
      rv.play().catch(() => {});
    } else {
      if (ra.srcObject !== remoteStream) ra.srcObject = remoteStream;
      ra.play().catch(() => {});
    }
  }

  // ---------------- 1:1: peer connection ----------------
  function sendIce(peer, c) {
    try { ws.send(JSON.stringify({ type: "ice", to: peer, candidate: c })); } catch {}
  }
  function flushLocalIce(peer) {
    signalReady = true;
    localIce.splice(0).forEach((c) => sendIce(peer, c));
  }
  async function flushRemoteIce() {
    if (!pc || !pc.remoteDescription) return;
    const list = pendingIce.splice(0);
    for (const c of list) { try { await pc.addIceCandidate(c); } catch {} }
  }

  function armConnectGuard() {
    clearTimeout(connectGuard);
    connectGuard = setTimeout(() => {
      if (pc && pc.connectionState !== "connected") {
        alert("Не удалось соединиться. Скорее всего, между вашими сетями нужен TURN-сервер (см. настройку на сервере).");
        cleanupCall();
      }
    }, CONNECT_GUARD_MS);
  }

  async function createPeer(peer) {
    const cfg = await getRtc();
    const p = new RTCPeerConnection({ ...cfg, iceCandidatePoolSize: 4 });
    pc = p;
    remoteStream = new MediaStream();
    signalReady = false;
    localIce = [];

    localStream = await getMedia(callVideo);
    localStream.getTracks().forEach((t) => p.addTrack(t, localStream));
    if (callVideo && localStream.getVideoTracks().length) {
      const lv = $("omLocalVideo");
      lv.srcObject = localStream;
      lv.classList.toggle("back", facing !== "user");
    }

    p.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      if (signalReady) sendIce(peer, ev.candidate); else localIce.push(ev.candidate);
    };

    p.ontrack = (ev) => {
      const t = ev.track;
      if (!remoteStream.getTracks().some((x) => x.id === t.id)) remoteStream.addTrack(t);
      if (t.kind === "video") {
        const rv = $("omRemoteVideo");
        t.onmute = () => { rv.style.visibility = "hidden"; };
        t.onunmute = () => { rv.style.visibility = "visible"; };
      }
      bindRemote();
    };

    p.onconnectionstatechange = () => {
      if (p !== pc) return;
      const st = p.connectionState;
      if (st === "connected") {
        clearTimeout(discTimer);
        clearTimeout(connectGuard);
        clearTimeout(ringGuard);
        markConnected();
      } else if (st === "disconnected") {
        setStatus("Слабая связь… переподключаемся");
        clearTimeout(discTimer);
        discTimer = setTimeout(() => {
          if (pc === p && p.connectionState !== "connected") { toast("Связь потеряна"); cleanupCall(); }
        }, 15000);
      } else if (st === "failed" || st === "closed") {
        cleanupCall();
      }
    };
  }

  function markConnected() {
    setStatus("Разговор идёт");
    if (!callTimerInterval) startCallTimer();
    if (callVideo) startOverlayTimer();
  }

  // ---------------- 1:1: исходящий ----------------
  async function startCall(video) {
    if (!isPrivateChat(currentChat)) return alert("Звонок только в личном чате");
    if (callPeer || lkRoom) return alert("Звонок уже идёт");
    if (!ws || ws.readyState !== 1) return alert("Нет соединения с сервером");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alert("Этот браузер не поддерживает звонки");

    callVideo = !!video;
    callPeer = currentChat;
    activeCallId = null;
    pendingIce = [];
    await showP2PUi(callPeer, "Звоним...", callVideo);

    try {
      await createPeer(callPeer);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "call-offer", to: callPeer, offer, video: callVideo }));
      flushLocalIce(callPeer);

      ringGuard = setTimeout(() => {
        if (callPeer && !(pc && pc.connectionState === "connected")) {
          setStatus("Не отвечает");
          setTimeout(() => { if (callPeer) endCall(); }, 1200);
        }
      }, RING_GUARD_MS);
    } catch (e) {
      alert(e && e.name === "NotAllowedError"
        ? "Нет доступа к микрофону или камере — разреши его в настройках браузера"
        : "Не удалось начать звонок");
      cleanupCall();
    }
  }

  // ---------------- 1:1: входящий ----------------
  async function onIncomingOffer(data) {
    if (data.callId && seenCallIds.has(data.callId)) return; // тот же звонок пришёл повторно (реконнект)
    if (data.callId) seenCallIds.add(data.callId);

    if (callPeer || lkRoom) {
      ws.send(JSON.stringify({ type: "call-reject", to: data.from }));
      return;
    }

    incomingFrom = data.from;
    incomingOffer = data.offer;
    incomingVideo = !!data.video;
    incomingCallId = data.callId || null;
    pendingIce = [];

    await openIncoming(incomingFrom);
    const sub = document.querySelector("#incomingCallModal .call-sub");
    if (sub) sub.textContent = incomingVideo ? "Видеозвонок" : "Аудиозвонок";
    startRingtone();

    if (autoAcceptId && data.callId === autoAcceptId) {
      autoAcceptId = null;
      setTimeout(acceptIncomingCall, 250);
    }
  }

  async function acceptIncomingCall() {
    if (!incomingFrom || !incomingOffer) return;
    const from = incomingFrom, offer = incomingOffer;

    stopRingtone();
    closeIncoming();
    callVideo = incomingVideo;
    callPeer = from;
    activeCallId = incomingCallId;
    await showP2PUi(from, "Подключение...", callVideo);

    try {
      await createPeer(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushRemoteIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "call-answer", to: from, answer }));
      flushLocalIce(from);
      incomingFrom = null;
      incomingOffer = null;
      armConnectGuard();
    } catch (e) {
      alert(e && e.name === "NotAllowedError"
        ? "Нет доступа к микрофону или камере — разреши его в настройках браузера"
        : "Не удалось принять звонок");
      cleanupCall();
    }
  }

  function declineIncomingCall() {
    stopRingtone();
    if (incomingFrom && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "call-reject", to: incomingFrom }));
    }
    incomingFrom = null;
    incomingOffer = null;
    incomingCallId = null;
    closeIncoming();
  }

  async function onCallAnswer(data) {
    if (!pc || !data.answer) return;
    clearTimeout(ringGuard);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch { return; }
    await flushRemoteIce();
    setStatus("Соединение...");
    armConnectGuard();
  }

  async function onIce(data) {
    if (!data.candidate) return;
    if (!pc || !pc.remoteDescription) { pendingIce.push(data.candidate); return; }
    try { await pc.addIceCandidate(data.candidate); } catch {}
  }

  function onCallEnd() { cleanupCall(); }

  function onCallReject(data) {
    if (callPeer && data.from && data.from !== callPeer) return;
    const who = "@" + (data.from || callPeer || "");
    setStatus(data.reason === "noanswer" ? "Не отвечает" : `${who} отклонил(а) звонок`);
    setTimeout(cleanupCall, 1500);
  }

  function cleanupCall() {
    clearTimeout(ringGuard); clearTimeout(connectGuard); clearTimeout(discTimer);
    ringGuard = connectGuard = discTimer = null;
    stopRingtone();

    closeCall();
    closeIncoming();
    stopCallTimer();
    if (callMode === "p2p") hideOverlay();

    try { pc && pc.close(); } catch {}
    pc = null;
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    if (remoteStream) remoteStream.getTracks().forEach((t) => t.stop());
    remoteStream = null;

    callPeer = null;
    incomingFrom = null;
    incomingOffer = null;
    incomingCallId = null;
    activeCallId = null;
    pendingIce = [];
    localIce = [];
    signalReady = false;
    callVideo = false;
    isMuted = false;
    isSpeakerOn = false;
    if (callMode === "p2p") callMode = null;

    const muteBtn = $("muteBtn");
    if (muteBtn) { muteBtn.classList.remove("callbtn-active"); muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>'; }
    const speakerBtn = $("speakerBtn");
    if (speakerBtn) { speakerBtn.classList.remove("callbtn-active"); speakerBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>'; }

    const ra = $("remoteAudio"); if (ra) ra.srcObject = null;
    const rv = $("omRemoteVideo"); if (rv) { rv.srcObject = null; rv.style.visibility = "visible"; }
    const lv = $("omLocalVideo"); if (lv) lv.srcObject = null;
  }

  // ---------------- кнопки в звонке ----------------
  function setBtn(id, off, iconOn, iconOff) {
    const b = $(id);
    b.classList.toggle("off", off);
    b.innerHTML = `<i class="fa-solid ${off ? iconOff : iconOn}"></i>`;
  }

  window.omToggleMute = async function () {
    if (callMode === "group" && lkRoom) {
      const enabled = lkRoom.localParticipant.isMicrophoneEnabled;
      await lkRoom.localParticipant.setMicrophoneEnabled(!enabled);
      setBtn("omMute", enabled, "fa-microphone", "fa-microphone-slash");
    } else {
      toggleMute();
      setBtn("omMute", isMuted, "fa-microphone", "fa-microphone-slash");
    }
  };

  window.omToggleCam = async function () {
    if (callMode === "group" && lkRoom) {
      const enabled = lkRoom.localParticipant.isCameraEnabled;
      try { await lkRoom.localParticipant.setCameraEnabled(!enabled); } catch { return toast("Камера недоступна"); }
      setBtn("omCam", enabled, "fa-video", "fa-video-slash");
      return;
    }
    const vt = localStream && localStream.getVideoTracks()[0];
    if (!vt) return toast("В этом звонке нет видео");
    vt.enabled = !vt.enabled;
    setBtn("omCam", !vt.enabled, "fa-video", "fa-video-slash");
  };

  window.omFlip = async function () {
    facing = facing === "user" ? "environment" : "user";
    if (callMode === "group" && lkRoom) {
      try {
        const pub = lkRoom.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Camera);
        if (pub && pub.videoTrack) await pub.videoTrack.restartTrack({ facingMode: facing });
        else toast("Сначала включи камеру");
      } catch { facing = facing === "user" ? "environment" : "user"; toast("Не удалось переключить камеру"); }
      return;
    }
    if (!pc || !localStream) return;
    const old = localStream.getVideoTracks()[0];
    if (!old) return toast("В этом звонке нет видео");
    old.stop();
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
      const nt = ns.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video") ||
                     pc.getSenders().find((s) => !s.track);
      if (sender) await sender.replaceTrack(nt);
      localStream.removeTrack(old);
      localStream.addTrack(nt);
      const lv = $("omLocalVideo");
      lv.srcObject = localStream;
      lv.classList.toggle("back", facing !== "user");
    } catch {
      facing = facing === "user" ? "environment" : "user";
      toast("Не удалось переключить камеру");
    }
  };

  window.omEnd = function () {
    if (callMode === "group") leaveGroupCall();
    else endCall();
  };

  // ---------------- групповые звонки (LiveKit) ----------------
  function loadLk() {
    if (window.LivekitClient) return Promise.resolve();
    if (!lkPromise) {
      lkPromise = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = LK_SRC;
        s.onload = res;
        s.onerror = () => { lkPromise = null; rej(new Error("Не удалось загрузить библиотеку групповых звонков")); };
        document.head.appendChild(s);
      });
    }
    return lkPromise;
  }

  function tileFor(participant) {
    const id = participant.identity;
    let t = tiles.get(id);
    if (t) return t;
    const info = userInfoCache.get(id) || { username: id, displayName: participant.name || id };
    t = document.createElement("div");
    t.className = "omtile";
    t.innerHTML = `<div class="omava">${avatarHtml(info)}</div><div class="omvid"></div>
                   <div class="omnm">${esc(participant.isLocal ? "Ты" : (info.displayName || id))}</div>`;
    $("omGrid").appendChild(t);
    tiles.set(id, t);
    updateGroupCount();
    return t;
  }

  function updateGroupCount() {
    if (callMode === "group") {
      const el = $("omStatus");
      if (el && !overlayTimer) el.textContent = `${tiles.size} в звонке`;
    }
  }

  function attachLkTrack(track, participant) {
    const tile = tileFor(participant);
    if (track.kind === "video") {
      const v = track.attach();
      v.playsInline = true;
      v.muted = !!participant.isLocal;
      const box = tile.querySelector(".omvid");
      box.innerHTML = "";
      box.appendChild(v);
      tile.classList.add("hasvideo");
    } else if (track.kind === "audio" && !participant.isLocal) {
      const a = track.attach();
      $("omAudioSink").appendChild(a);
    }
  }
  function detachLkTrack(track, participant) {
    track.detach().forEach((e) => e.remove());
    if (track.kind === "video") {
      const tile = tiles.get(participant.identity);
      if (tile) tile.classList.remove("hasvideo");
    }
  }

  async function startGroupCall(video) {
    if (!isGroupChat(currentChat)) return;
    await joinGroupCall(currentChat, !!video);
  }

  async function joinGroupCall(chat, video) {
    if (callPeer || lkRoom) return alert("Звонок уже идёт");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alert("Этот браузер не поддерживает звонки");

    callMode = "group";
    groupChatKey = chat;
    hideBanner();
    const meta = chat === currentChat && currentGroupMeta ? currentGroupMeta : null;
    showOverlay("group", meta ? meta.name : "Групповой звонок");
    $("omStatus").textContent = "Подключение...";
    $("omCam").className = "omb" + (video ? "" : " off");
    $("omCam").innerHTML = `<i class="fa-solid ${video ? "fa-video" : "fa-video-slash"}"></i>`;

    try {
      const r = await fetch("/api/group-call/join", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ chat, video })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Не удалось начать звонок");

      await loadLk();
      const LK = window.LivekitClient;
      const room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution }
      });
      lkRoom = room;

      room
        .on(LK.RoomEvent.TrackSubscribed, (track, pub, p) => attachLkTrack(track, p))
        .on(LK.RoomEvent.TrackUnsubscribed, (track, pub, p) => detachLkTrack(track, p))
        .on(LK.RoomEvent.LocalTrackPublished, (pub, p) => { if (pub.track) attachLkTrack(pub.track, p); })
        .on(LK.RoomEvent.LocalTrackUnpublished, (pub, p) => { if (pub.track) detachLkTrack(pub.track, p); })
        .on(LK.RoomEvent.TrackMuted, (pub, p) => {
          const t = tiles.get(p.identity);
          if (t && pub.kind === "video") t.classList.remove("hasvideo");
        })
        .on(LK.RoomEvent.TrackUnmuted, (pub, p) => {
          const t = tiles.get(p.identity);
          if (t && pub.kind === "video" && t.querySelector("video")) t.classList.add("hasvideo");
        })
        .on(LK.RoomEvent.ParticipantConnected, (p) => tileFor(p))
        .on(LK.RoomEvent.ParticipantDisconnected, (p) => {
          const t = tiles.get(p.identity);
          if (t) { t.remove(); tiles.delete(p.identity); updateGroupCount(); }
        })
        .on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const ids = new Set(speakers.map((s) => s.identity));
          tiles.forEach((t, id) => t.classList.toggle("speaking", ids.has(id)));
        })
        .on(LK.RoomEvent.Disconnected, () => { if (lkRoom === room) leaveGroupCall(); });

      await room.connect(d.url, d.token);
      tileFor(room.localParticipant);
      room.remoteParticipants.forEach((p) => tileFor(p));
      await room.localParticipant.setMicrophoneEnabled(true);
      if (video) {
        try { await room.localParticipant.setCameraEnabled(true); }
        catch {
          toast("Камера недоступна — только звук");
          setBtn("omCam", true, "fa-video", "fa-video-slash");
        }
      }
      try { await room.startAudio(); } catch {}
      updateGroupCount();

      pingTimer = setInterval(() => {
        fetch("/api/group-call/ping", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ chat })
        }).catch(() => {});
      }, 20000);
    } catch (e) {
      alert((e && e.message) || "Не удалось присоединиться к звонку");
      leaveGroupCall();
    }
  }

  function leaveGroupCall() {
    clearInterval(pingTimer);
    pingTimer = null;
    const room = lkRoom, chat = groupChatKey;
    lkRoom = null;
    groupChatKey = null;
    try { if (room) room.disconnect(); } catch {}
    tiles.clear();
    const g = $("omGrid"); if (g) g.innerHTML = "";
    const s = $("omAudioSink"); if (s) s.innerHTML = "";
    if (callMode === "group") { hideOverlay(); callMode = null; }
    if (chat) {
      fetch("/api/group-call/leave", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ chat })
      }).catch(() => {});
    }
    refreshGroupCallBanner();
  }

  // ---------------- плашка «идёт групповой звонок» ----------------
  function showBanner(chat, title, video) {
    if (lkRoom) return;
    bannerChat = chat;
    const b = $("omBanner");
    b.innerHTML = `
      <i class="fa-solid ${video ? "fa-video" : "fa-phone"}"></i>
      <div class="omtxt">${esc(title)}: идёт ${video ? "видео" : "аудио"}звонок</div>
      <button class="btn primary small" id="omJoinBtn">Войти</button>
      <button class="omx" id="omHideBtn" title="Скрыть"><i class="fa-solid fa-xmark"></i></button>`;
    b.classList.remove("hidden");
    $("omJoinBtn").onclick = () => joinGroupCall(chat, false);
    $("omHideBtn").onclick = hideBanner;
  }
  function hideBanner() {
    bannerChat = null;
    const b = $("omBanner");
    if (b) b.classList.add("hidden");
  }
  async function refreshGroupCallBanner() {
    if (!me || lkRoom) return;
    if (!isGroupChat(currentChat) || (currentGroupMeta && currentGroupMeta.isChannel)) return hideBanner();
    try {
      const r = await fetch(`/api/group-call/active?chat=${encodeURIComponent(currentChat)}`, { headers: authHeaders() });
      const d = await r.json();
      if (d.ok && d.active) showBanner(currentChat, d.groupName || "Группа", d.video);
      else if (bannerChat === currentChat) hideBanner();
    } catch {}
  }

  // ---------------- дополнительные сообщения WebSocket ----------------
  const EXTRA = {
    "call-ringing": (d) => {
      if (!callPeer || d.to !== callPeer) return;
      activeCallId = d.callId || null;
      setStatus(d.online ? "Звоним..." : "Не в сети — отправили уведомление, ждём...");
    },
    "group-call": (d) => {
      if (lkRoom) return;
      toast(`📞 ${d.fromName || "Кто-то"} зовёт в звонок: ${d.groupName || "группа"}`);
      showBanner(d.chat, d.groupName || "Группа", d.video);
    },
    "group-call-ended": (d) => { if (bannerChat === d.chat) hideBanner(); }
  };

  // app.js создаёт WebSocket сам — подписываемся на каждое соединение,
  // не меняя app.js
  const NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    const s = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    s.addEventListener("message", (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && EXTRA[d.type]) EXTRA[d.type](d);
      } catch {}
    });
    return s;
  }
  PatchedWS.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => { PatchedWS[k] = NativeWS[k]; });
  window.WebSocket = PatchedWS;

  // ---------------- подмена функций из app.js ----------------
  window.startAudioCall = () => startCall(false);
  window.onIncomingOffer = onIncomingOffer;
  window.acceptIncomingCall = acceptIncomingCall;
  window.declineIncomingCall = declineIncomingCall;
  window.onCallAnswer = onCallAnswer;
  window.onIce = onIce;
  window.onCallEnd = onCallEnd;
  window.onCallReject = onCallReject;
  window.createPeer = createPeer;
  window.markConnected = markConnected;
  window.cleanupCall = cleanupCall;

  const _updateHeader = window.updateHeader;
  window.updateHeader = function () { _updateHeader(); syncButtons(); };

  const _openChat = window.openChat;
  window.openChat = async function (chat) {
    await _openChat(chat);
    syncButtons();
    refreshGroupCallBanner();
  };

  // ---------------- открытие из push-уведомления ----------------
  function whenReady(fn) {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (me && ws && ws.readyState === 1) { clearInterval(t); fn(); }
      else if (tries > 75) clearInterval(t);
    }, 400);
  }

  const params = new URLSearchParams(location.search);
  const qAccept = params.get("acceptCall");
  const qGroup = params.get("joinGroup");
  if (qAccept) autoAcceptId = qAccept;
  if (qGroup) whenReady(() => window.openChat("group:" + qGroup));
  if (qAccept || qGroup) { try { history.replaceState(null, "", location.pathname); } catch {} }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.type === "accept-call") {
        if (incomingCallId && incomingCallId === d.callId) acceptIncomingCall();
        else autoAcceptId = d.callId;
      }
      if (d.type === "join-group") whenReady(() => window.openChat("group:" + d.groupId));
    });
  }

  window.addEventListener("pagehide", () => {
    try {
      if (callMode === "p2p" && callPeer && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "call-end", to: callPeer }));
      }
    } catch {}
  });

  buildUi();
})();
