// ===============================
// CONFIG
// ===============================

const API = "/api";
let token = localStorage.getItem("token");
let currentUser = null;
let currentChat = "global";

let ws = null;

let pc = null;
let localStream = null;
let remoteStream = null;

let currentCallUser = null;
let videoEnabled = false;
let usingFrontCamera = true;


// ===============================
// INIT
// ===============================

async function init() {

  if (!token) {
    location.href = "/index.html";
    return;
  }

  await loadProfile();
  connectWS();
  loadChats();
  loadMessages("global");

}

window.addEventListener("load", init);


// ===============================
// PROFILE
// ===============================

async function loadProfile() {

  const res = await fetch(API + "/me", {
    headers: { Authorization: "Bearer " + token }
  });

  const data = await res.json();

  if (!data.ok) {
    localStorage.removeItem("token");
    location.href = "/index.html";
    return;
  }

  currentUser = data.profile;

}


// ===============================
// WEBSOCKET
// ===============================

function connectWS() {

  ws = new WebSocket(`wss://${location.host}?token=${token}`);

  ws.onmessage = (event) => {

    const data = JSON.parse(event.data);

    if (data.type === "message") {
      appendMessage(data.message);
    }

    if (data.type === "messageDeleted") {
      removeMessage(data.id);
    }

    if (data.type === "call-offer") {
      incomingCall(data.from, data.offer);
    }

    if (data.type === "call-answer") {
      pc.setRemoteDescription(data.answer);
    }

    if (data.type === "ice") {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }

    if (data.type === "call-end") {
      endCall();
    }

  };

}


// ===============================
// CHATS
// ===============================

async function loadChats() {

  const res = await fetch(API + "/chats", {
    headers: { Authorization: "Bearer " + token }
  });

  const data = await res.json();

  const list = document.getElementById("chatList");
  list.innerHTML = "";

  data.chats.forEach(chat => {

    const div = document.createElement("div");
    div.className = "chat-item";
    div.innerText = chat.displayName;

    div.onclick = () => {
      currentChat = chat.username;
      loadMessages(chat.username);
    };

    list.appendChild(div);

  });

}


// ===============================
// MESSAGES
// ===============================

async function loadMessages(chat) {

  const res = await fetch(API + "/messages?chat=" + chat, {
    headers: { Authorization: "Bearer " + token }
  });

  const data = await res.json();

  const container = document.getElementById("messages");
  container.innerHTML = "";

  data.messages.forEach(m => appendMessage(m));

}


function appendMessage(m) {

  const container = document.getElementById("messages");

  const div = document.createElement("div");
  div.className = "msg";

  if (m.mediaType === "text") {
    div.innerText = m.sender + ": " + m.text;
  }

  if (m.mediaType === "image") {
    div.innerHTML = `<img src="${m.mediaUrl}" width="200">`;
  }

  if (m.mediaType === "video") {
    div.innerHTML = `<video src="${m.mediaUrl}" controls width="200"></video>`;
  }

  if (m.mediaType === "audio") {
    div.innerHTML = `<audio src="${m.mediaUrl}" controls></audio>`;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

}


// ===============================
// SEND TEXT
// ===============================

function sendText() {

  const input = document.getElementById("textInput");
  const text = input.value.trim();

  if (!text) return;

  ws.send(JSON.stringify({
    type: "text-message",
    receiver: currentChat,
    text
  }));

  input.value = "";

}


// ===============================
// UPLOAD MEDIA
// ===============================

async function uploadFile(file) {

  const form = new FormData();
  form.append("file", file);
  form.append("receiver", currentChat);

  await fetch(API + "/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form
  });

}


// ===============================
// AUDIO MESSAGE
// ===============================

let recorder;
let audioChunks = [];

async function startRecording() {

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  recorder = new MediaRecorder(stream);

  recorder.ondataavailable = e => audioChunks.push(e.data);

  recorder.onstop = async () => {

    const blob = new Blob(audioChunks, { type: "audio/webm" });
    audioChunks = [];

    uploadFile(blob);

  };

  recorder.start();

}

function stopRecording() {
  recorder.stop();
}


// ===============================
// CALL
// ===============================

async function startCall(user) {

  currentCallUser = user;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {

    remoteStream = event.streams[0];
    document.getElementById("remoteVideo").srcObject = remoteStream;

  };

  pc.onicecandidate = (event) => {

    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "ice",
        to: user,
        candidate: event.candidate
      }));
    }

  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: "call-offer",
    to: user,
    offer
  }));

}


// ===============================
// INCOMING CALL
// ===============================

async function incomingCall(from, offer) {

  currentCallUser = from;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {

    remoteStream = event.streams[0];
    document.getElementById("remoteVideo").srcObject = remoteStream;

  };

  pc.onicecandidate = (event) => {

    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "ice",
        to: from,
        candidate: event.candidate
      }));
    }

  };

  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(JSON.stringify({
    type: "call-answer",
    to: from,
    answer
  }));

}


// ===============================
// CAMERA ON
// ===============================

async function enableCamera() {

  if (videoEnabled) return;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: usingFrontCamera ? "user" : "environment" }
  });

  const videoTrack = stream.getVideoTracks()[0];

  pc.addTrack(videoTrack, stream);

  document.getElementById("localVideo").srcObject = stream;

  videoEnabled = true;

}


// ===============================
// SWITCH CAMERA
// ===============================

async function switchCamera() {

  usingFrontCamera = !usingFrontCamera;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: usingFrontCamera ? "user" : "environment" }
  });

  const track = stream.getVideoTracks()[0];

  const sender = pc.getSenders().find(s => s.track.kind === "video");

  sender.replaceTrack(track);

  document.getElementById("localVideo").srcObject = stream;

}


// ===============================
// END CALL
// ===============================

function endCall() {

  if (pc) pc.close();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  pc = null;

  ws.send(JSON.stringify({
    type: "call-end",
    to: currentCallUser
  }));

}
