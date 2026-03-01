let activeReceiver = 'global'; // По умолчанию общий чат

// Функция поиска пользователя (как в TG)
async function searchPeople() {
    const query = document.getElementById('searchInp').value;
    if (query.length < 2) return;
    const res = await fetch(`/api/search?username=${query}`);
    const users = await res.json();
    
    const list = document.getElementById('searchResults');
    list.innerHTML = users.map(u => `
        <div class="user-item" onclick="startPrivate('${u.username}')">
            @${u.username} <span>${u.displayName}</span>
        </div>
    `).join('');
}

function startPrivate(username) {
    activeReceiver = username;
    document.getElementById('chatTitle').innerText = "Чат с @" + username;
    // Очистить и загрузить историю из БД для этой пары
}

// Запись "Кружка" (Video Note)
async function sendVideoNote() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        // Отправка файла через fetch на /api/upload...
        // После получения URL отправляем через сокет с типом 'video_note'
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 5000); // Пример на 5 секунд
}
