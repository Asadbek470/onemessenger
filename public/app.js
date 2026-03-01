let socket;
let currentUser = localStorage.getItem('user');

// Функция авторизации (исправляем нерабочие кнопки)
async function auth(type) {
    const user = document.getElementById('user').value;
    const pass = document.getElementById('pass').value;

    if (!user || !pass) return alert("Заполни все поля!");

    const res = await fetch(`/api/auth/${type}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: user, password: pass })
    });

    const data = await res.json();
    if (data.success) {
        localStorage.setItem('user', user);
        window.location.href = 'chat.html';
    } else {
        alert("Ошибка: " + data.error);
    }
}

// Поиск пользователей по Username
async function searchUsers(val) {
    if (val.length < 2) return;
    const res = await fetch(`/api/search?q=${val}`);
    const users = await res.json();
    const results = document.getElementById('results');
    results.innerHTML = users.map(u => `
        <div onclick="startPrivate('${u.username}')" class="user-row">@${u.username}</div>
    `).join('');
}

// Кружки (Video Notes)
async function sendCircle() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const formData = new FormData();
        formData.append('file', blob);
        
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const { url } = await res.json();
        
        socket.send(JSON.stringify({ type: 'video_note', fileUrl: url, sender: currentUser }));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 5000); // Кружок на 5 секунд
}
