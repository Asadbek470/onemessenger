let mediaRecorder;
let chunks = [];

// 1. Функция для записи КРУЖКА (Video Note)
async function startCircle() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const videoPreview = document.createElement('video');
        videoPreview.srcObject = stream;
        videoPreview.muted = true;
        videoPreview.play();
        
        // Показываем круглое превью пользователю (iOS Style)
        videoPreview.className = "video-note-container";
        document.body.appendChild(videoPreview);

        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'video/mp4' });
            const formData = new FormData();
            formData.append('file', blob);
            
            // Отправка на сервер
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            const data = await res.json();
            
            // Отправка через сокет
            socket.send(JSON.stringify({ type: 'video_note', url: data.url, sender: currentUser }));
            videoPreview.remove();
            chunks = [];
        };
        
        mediaRecorder.start();
        setTimeout(() => mediaRecorder.stop(), 5000); // Запись 5 секунд
    } catch (err) { alert("Включи доступ к камере!"); }
}

// 2. Функция поиска по Username (Личка)
async function searchUsers(query) {
    if (!query.startsWith('@')) return;
    const res = await fetch(`/api/search?q=${query.substring(1)}`);
    const results = await res.json();
    
    const list = document.getElementById('chat-list');
    list.innerHTML = results.map(u => `
        <div class="user-item" onclick="openPrivate('${u.username}')">
            <b>@${u.username}</b>
        </div>
    `).join('');
}
