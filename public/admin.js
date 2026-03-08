const form = document.getElementById('admin-login');
const panel = document.getElementById('admin-panel');
const usersList = document.getElementById('users-list');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('admin-username').value;
  const password = document.getElementById('admin-password').value;
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.ok) {
    localStorage.setItem('adminToken', data.token);
    form.style.display = 'none';
    panel.style.display = 'block';
    loadUsers();
  } else {
    alert(data.error);
  }
});

async function loadUsers() {
  const res = await fetch('/api/admin/users', { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
  const data = await res.json();
  if (data.ok) {
    usersList.innerHTML = '';
    data.users.forEach(user => {
      const div = document.createElement('div');
      div.classList.add('admin-user-item');
      div.innerHTML = `
        <strong>${user.username}</strong>
        <input type="datetime-local" placeholder="Blocked Until" value="${user.blockedUntil || ''}">
        <label>Text: <input type="checkbox" ${user.canSendText ? 'checked' : ''}></label>
        <label>Media: <input type="checkbox" ${user.canSendMedia ? 'checked' : ''}></label>
        <label>Call: <input type="checkbox" ${user.canCall ? 'checked' : ''}></label>
        <button class="btn primary small">Update</button>
      `;
      div.querySelector('button').onclick = async () => {
        const blockedUntil = div.querySelector('input[type="datetime-local"]').value;
        const canSendText = div.querySelector('input[type="checkbox"]:nth-of-type(1)').checked;
        const canSendMedia = div.querySelector('input[type="checkbox"]:nth-of-type(2)').checked;
        const canCall = div.querySelector('input[type="checkbox"]:nth-of-type(3)').checked;
        const updateRes = await fetch('/api/admin/user/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
          body: JSON.stringify({ username: user.username, blockedUntil, canSendText, canSendMedia, canCall })
        });
        if ((await updateRes.json()).ok) {
          alert('Updated');
        }
      };
      usersList.appendChild(div);
    });
  }
}
