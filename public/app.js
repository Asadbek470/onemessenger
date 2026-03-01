<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>One Messenger — iOS 26 Ultra</title>
  <link rel="stylesheet" href="style.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css" />
</head>
<body onload="initChat()">

  <div class="app-container">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="search-container">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input type="text" id="userSearch" placeholder="Поиск @username..." oninput="searchUsers(this.value)" />
        </div>
      </div>

      <div class="chats-list" id="chatsList">
        <div class="chat-item active" data-chat="global" onclick="switchChat('global')">
          <div class="avatar-circle global-avatar">
            <i class="fa-solid fa-earth-americas"></i>
          </div>
          <div class="chat-meta">
            <span class="name">Общий чат</span>
            <span class="preview">Напишите сообщение...</span>
          </div>
        </div>

        <div id="privateChatsBlock"></div>
        <div id="searchResults"></div>
      </div>

      <div class="sidebar-footer">
        <button class="settings-btn" onclick="openSettings()">
          <i class="fa-solid fa-circle-user"></i> Настройки профиля
        </button>
      </div>
    </aside>

    <main class="main-chat">
      <header class="chat-header">
        <div class="header-left">
          <button class="back-btn" onclick="toggleSidebarMobile()"><i class="fa-solid fa-chevron-left"></i></button>
          <div class="current-chat-info" onclick="openCurrentProfile()" style="cursor:pointer;">
            <h2 id="chatTitle">Общий чат</h2>
            <span class="status" id="chatStatus">в сети</span>
          </div>
        </div>
        <div class="header-right">
          <i class="fa-solid fa-user" onclick="openCurrentProfile()"></i>
        </div>
      </header>

      <section class="messages-area" id="messagesContainer"></section>

      <footer class="input-panel">
        <button class="icon-btn attach-btn" onclick="document.getElementById('fileInput').click()">
          <i class="fa-solid fa-paperclip"></i>
        </button>
        <input type="file" id="fileInput" hidden accept="image/*,video/*" onchange="uploadMedia(this)" />

        <div class="text-input-wrapper">
          <input type="text" id="messageInput" placeholder="Сообщение..." autocomplete="off" />
          <button class="emoji-btn" type="button"><i class="fa-regular fa-face-smile"></i></button>
        </div>

        <div class="actions-group">
          <button class="icon-btn voice-btn" id="voiceBtn" onclick="toggleAudioRec()">
            <i class="fa-solid fa-microphone"></i>
          </button>
          <button class="send-btn" onclick="sendText()">
            <i class="fa-solid fa-arrow-up"></i>
          </button>
        </div>
      </footer>
    </main>
  </div>

  <div id="settingsModal" class="modal-backdrop" style="display: none;">
    <div class="settings-card glass">
      <header class="modal-header">
        <h3>Настройки профиля</h3>
        <button class="close-btn" onclick="closeSettings()">✕</button>
      </header>

      <div class="settings-body">
        <div class="profile-avatar-edit">
          <div class="avatar-large" id="profilePreview"></div>
          <button onclick="document.getElementById('avatarInput').click()">Изменить фото</button>
          <input type="file" id="avatarInput" hidden accept="image/*" onchange="previewAvatar(this)" />
        </div>

        <div class="input-field">
          <label>Ваше имя</label>
          <input type="text" id="editName" placeholder="Введите имя" />
        </div>

        <div class="input-field">
          <label>О себе (Bio)</label>
          <input type="text" id="editBio" placeholder="Расскажите о себе" />
        </div>

        <button class="save-profile-btn" onclick="saveProfile()">Сохранить изменения</button>
      </div>
    </div>
  </div>

  <div id="profileModal" class="modal-backdrop" style="display: none;">
    <div class="settings-card glass">
      <header class="modal-header">
        <h3>Профиль</h3>
        <button class="close-btn" onclick="closeProfile()">✕</button>
      </header>

      <div class="settings-body">
        <div class="profile-avatar-edit">
          <div class="avatar-large" id="viewProfileAvatar"></div>
        </div>
        <div class="profile-view-line"><b>Юзернейм:</b> <span id="viewProfileUsername"></span></div>
        <div class="profile-view-line"><b>Имя:</b> <span id="viewProfileName"></span></div>
        <div class="profile-view-line"><b>Bio:</b> <span id="viewProfileBio"></span></div>
      </div>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
