let socket;
let currentUser = localStorage.getItem('user');

// Функция подключения (вызывать при загрузке chat.html)
function connectWS() {
    socket = new WebSocket(`ws://${window.location.host}`);
    
    socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const container = document.getElementById('messagesContainer');
        // Отрисовка сообщения (текст, фото, видео или кружок)
        container.innerHTML += `<div class="bubble">${msg.text || 'Медиа-файл'}</div>`;
    };
}

// ИСПРАВЛЕННЫЙ ПОИСК ЧЕЛОВЕКА
async function searchUsers(val) {
    if (!val.startsWith('@')) return;
    const query = val.replace('@', '');
    const res = await fetch(`/api/search?q=${query}`);
    const users = await res.json();
    
    const results = document.getElementById('searchResults');
    results.innerHTML = users.map(u => `
        <div class="user-item" onclick="startPrivate('${u.username}')">
            <b>@${u.username}</b>
        </div>
    `).join('');
}

// ОТПРАВКА В ОБЩИЙ ЧАТ
function sendText() {
    const input = document.getElementById('messageInput');
    if (input.value && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'text',
            text: input.value,
            sender: currentUser,
            receiver: 'global' // Это и есть общий чат
        }));
        input.value = '';
    }
}
