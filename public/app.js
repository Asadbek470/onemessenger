// Client logic for chat.html

const token = localStorage.getItem('token');
if (!token) window.location.href = 'index.html';

const ws = new WebSocket(`ws://${location.host}/?token=${token}`);  // For local, adjust for production

let currentChat = null;
let mediaRecorder;
let audioChunks = [];
let peerConnection;
const stunServer = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM elements
const sidebar = document.querySelector('.sidebar');
const chatsList = document.querySelector('.chats-list');
const chatTitle = document.getElementById('chat-title');
const chatStatus = document.getElementById('chat-status');
const messagesDiv = document.querySelector('.messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const micBtn = document.getElementById('mic-btn');
const callBtn = document.getElementById('call-btn');
const backBtn = document.querySelector('.back-btn');
const createGroupBtn = document.getElementById('create-group');
const settingsBtn = document.getElementById('settings');
const searchInput = document.getElementById('search-input');
const storiesBtn = document.getElementById('stories-btn');

// Modals
const profileModal = document.getElementById('profile-modal');
const settingsModal = document.getElementById('settings-modal');
const createGroupModal = document.getElementById('create-group-modal');
const groupInfoModal = document.getElementById('group-info-modal');
const incomingCallModal = document.getElementById('incoming-call-modal');
const callModal = document.getElementById('call-modal');
const storiesModal = document.getElementById('stories-modal');

// Load profile
async function loadProfile() {
  const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    // Use data.user
  }
}

loadProfile();

// Load chats
async function loadChats() {
  const res = await fetch('/api/chats', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    chatsList.innerHTML = '';
    data.chats.forEach(chat => {
      const div = document.createElement('div');
      div.classList.add('chat-item');
      div.textContent = chat.name;
      div.onclick = () => openChat(chat);
      chatsList.appendChild(div);
    });
  }
}

loadChats();

// Open chat
async function openChat(chat) {
  currentChat = chat;
  chatTitle.textContent = chat.name;
  callBtn.style.display = chat.type === 'personal' ? 'block' : 'none';
  loadMessages(chat.id);
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('active');
  }
}

// Load messages
async function loadMessages(chatId) {
  const res = await fetch(`/api/messages?chat=${chatId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    messagesDiv.innerHTML = '';
    data.messages.forEach(msg => appendMessage(msg));
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
}

function appendMessage(msg) {
  const div = document.createElement('div');
  div.classList.add('message');
  div.innerHTML = `<strong>${msg.sender}:</strong> ${msg.text || ''}`;
  if (msg.mediaUrl) {
    if (msg.mediaType === 'image') {
      const img = document.createElement('img');
      img.src = msg.mediaUrl;
      div.appendChild(img);
    } else if (msg.mediaType === 'video') {
      const video = document.createElement('video');
      video.src = msg.mediaUrl;
      video.controls = true;
      div.appendChild(video);
    } else if (msg.mediaType === 'audio') {
      const audio = document.createElement('audio');
      audio.src = msg.mediaUrl;
      audio.controls = true;
      div.appendChild(audio);
    }
  }
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Send message
sendBtn.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (text) {
    ws.send(JSON.stringify({
      type: 'text-message',
      chatType: currentChat.type,
      receiver: currentChat.type === 'personal' ? currentChat.id : null,
      groupId: currentChat.type === 'group' ? currentChat.id.split(':')[1] : null,
      text
    }));
    messageInput.value = '';
  }
});

// Typing indicator
let typingTimeout;
messageInput.addEventListener('input', () => {
  ws.send(JSON.stringify({ type: 'typing', chatId: currentChat.id, isTyping: true }));
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    ws.send(JSON.stringify({ type: 'typing', chatId: currentChat.id, isTyping: false }));
  }, 3000);
});

// Attach file
attachBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*,audio/*';
  input.onchange = async () => {
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (data.ok) {
      // Send via WS or save as message
      ws.send(JSON.stringify({
        type: 'media-message',
        chatType: currentChat.type,
        receiver: currentChat.type === 'personal' ? currentChat.id : null,
        groupId: currentChat.type === 'group' ? currentChat.id.split(':')[1] : null,
        mediaType: data.mediaType,
        mediaUrl: data.mediaUrl
      }));
    }
  };
  input.click();
});

// Voice message
micBtn.addEventListener('mousedown', () => {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.start();
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  });
});

micBtn.addEventListener('mouseup', () => stopRecording());
micBtn.addEventListener('mouseleave', () => stopRecording());

function stopRecording() {
  if (mediaRecorder) {
    mediaRecorder.stop();
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('file', blob, 'voice.webm');
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (data.ok) {
        ws.send(JSON.stringify({
          type: 'media-message',
          chatType: currentChat.type,
          receiver: currentChat.type === 'personal' ? currentChat.id : null,
          groupId: currentChat.type === 'group' ? currentChat.id.split(':')[1] : null,
          mediaType: 'audio',
          mediaUrl: data.mediaUrl
        }));
      }
    };
  }
}

// WebSocket handlers
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case 'text-message':
    case 'media-message':
      if (currentChat && (data.chatType === currentChat.type && (data.groupId === currentChat.id.split(':')[1] || data.receiver === currentChat.id || data.sender === currentChat.id))) {
        appendMessage(data);
      }
      break;
    case 'typing':
      if (data.chatId === currentChat?.id) {
        chatStatus.textContent = data.typing.length > 0 ? 'Typing...' : '';
      }
      break;
    case 'status':
      // Update status in chats list or header
      if (currentChat?.type === 'personal' && data.username === currentChat.id) {
        chatStatus.textContent = data.status === 'online' ? 'Online' : `Last seen ${data.lastSeen}`;
      }
      break;
    case 'call-offer':
      incomingCallModal.style.display = 'block';
      document.getElementById('caller').textContent = data.from;
      document.getElementById('accept-call').onclick = () => acceptCall(data);
      document.getElementById('reject-call').onclick = () => rejectCall(data.from);
      break;
    case 'call-answer':
      peerConnection.setRemoteDescription(data.answer);
      break;
    case 'ice':
      peerConnection.addIceCandidate(data.candidate);
      break;
    case 'call-end':
      endCall();
      break;
  }
};

// Call handling
callBtn.addEventListener('click', startCall);

async function startCall() {
  peerConnection = new RTCPeerConnection(stunServer);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate, to: currentChat.id }));
    }
  };

  peerConnection.ontrack = e => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play();
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'call-offer', offer, to: currentChat.id }));

  callModal.style.display = 'block';
  document.getElementById('call-peer').textContent = currentChat.name;
  document.getElementById('end-call').onclick = () => {
    ws.send(JSON.stringify({ type: 'call-end', to: currentChat.id }));
    endCall();
  };
}

async function acceptCall(data) {
  incomingCallModal.style.display = 'none';
  peerConnection = new RTCPeerConnection(stunServer);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate, to: data.from }));
    }
  };

  peerConnection.ontrack = e => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play();
  };

  await peerConnection.setRemoteDescription(data.offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'call-answer', answer, to: data.from }));

  callModal.style.display = 'block';
  document.getElementById('call-peer').textContent = data.from;
  document.getElementById('end-call').onclick = () => {
    ws.send(JSON.stringify({ type: 'call-end', to: data.from }));
    endCall();
  };
}

function rejectCall(from) {
  incomingCallModal.style.display = 'none';
  ws.send(JSON.stringify({ type: 'call-end', to: from }));
}

function endCall() {
  callModal.style.display = 'none';
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
}

// Other event listeners
backBtn.addEventListener('click', () => sidebar.classList.add('active'));

createGroupBtn.addEventListener('click', () => {
  createGroupModal.style.display = 'block';
  document.getElementById('create-group-btn').onclick = async () => {
    const name = document.getElementById('group-name').value;
    const desc = document.getElementById('group-desc').value;
    const members = document.getElementById('group-members').value.split(',');
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, description: desc, members })
    });
    const data = await res.json();
    if (data.ok) {
      createGroupModal.style.display = 'none';
      loadChats();
    }
  };
});

settingsBtn.addEventListener('click', () => {
  settingsModal.style.display = 'block';
  // Load current profile into inputs
  document.getElementById('save-profile').onclick = async () => {
    const formData = new FormData();
    formData.append('displayName', document.getElementById('display-name').value);
    formData.append('bio', document.getElementById('bio').value);
    formData.append('birthDate', document.getElementById('birth-date').value);
    const avatar = document.getElementById('avatar-input').files[0];
    if (avatar) formData.append('avatar', avatar);

    const res = await fetch('/api/me', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    if ((await res.json()).ok) {
      settingsModal.style.display = 'none';
    }
  };
  document.getElementById('delete-account').onclick = async () => {
    if (confirm('Delete account?')) {
      const res = await fetch('/api/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if ((await res.json()).ok) {
        localStorage.removeItem('token');
        window.location.href = 'index.html';
      }
    }
  };
});

// Search users
searchInput.addEventListener('input', async () => {
  const q = searchInput.value;
  const res = await fetch(`/api/users/search?q=${q}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    // Display search results, allow starting chat
  }
});

// Stories
storiesBtn.addEventListener('click', async () => {
  const res = await fetch('/api/stories', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    storiesModal.innerHTML = '<h2>Stories</h2>';
    data.stories.forEach(s => {
      const div = document.createElement('div');
      div.textContent = `${s.owner}: ${s.text}`;
      if (s.mediaUrl) {
        // Add media
      }
      storiesModal.appendChild(div);
    });
    storiesModal.style.display = 'block';
  }
});

// Add more for group info, profile view, birthdays banner, etc.
chatTitle.addEventListener('click', () => {
  if (currentChat.type === 'personal') {
    // Open profile
    loadUserProfile(currentChat.id);
  } else if (currentChat.type === 'group') {
    // Open group info
    loadGroupInfo(currentChat.id.split(':')[1]);
  }
});

async function loadUserProfile(username) {
  const res = await fetch(`/api/users/${username}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    profileModal.innerHTML = `<h2>${data.user.displayName || data.user.username}</h2><p>${data.user.bio}</p>`;
    // Add avatar, birthDate, etc.
    profileModal.style.display = 'block';
  }
}

async function loadGroupInfo(groupId) {
  const res = await fetch(`/api/groups/${groupId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok) {
    groupInfoModal.innerHTML = `<h2>${data.group.name}</h2><p>${data.group.description}</p>`;
    // List members, edit buttons if admin
    groupInfoModal.style.display = 'block';
  }
}

// Birthdays
async function loadBirthdays() {
  const res = await fetch('/api/birthdays/today', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.ok && data.birthdays.length > 0) {
    // Show banner
    alert(`Today's birthdays: ${data.birthdays.map(b => b.displayName).join(', ')}`);
  }
}

loadBirthdays();

// Logout
document.getElementById('exit-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  window.location.href = 'index.html';
});
