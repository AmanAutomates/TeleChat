/* ═══════════════════════════════════════════════════════════
   Chat Frontend Application
   ═══════════════════════════════════════════════════════════ */

// ── state ──────────────────────────────────────────────────
const S = {
  ws: null,
  currentUserId: null,
  users: [],
  selectedMsgs: new Set(),
  selecting: false,
  replyTo: null,
  offset: 0,
  hasMore: false,
  loading: false,
  emojiOpen: false,
  forwardTargets: new Set(),
};

// ── avatar colours ─────────────────────────────────────────
const PALETTE = [
  '#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb',
  '#64b5f6', '#4fc3f7', '#4dd0e1', '#4db6ac', '#81c784',
  '#aed581', '#dce775', '#ffd54f', '#ffb74d', '#ff8a65',
];
function avatarColor(id) { return PALETTE[Math.abs(id) % PALETTE.length]; }
function initials(name) { return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(); }

// build avatar html with photo on top, initials as fallback underneath
function avatarHtml(userId, name) {
  const ini = initials(name);
  return `<span class="avatar-initials">${ini}</span><img class="avatar-img" src="/api/avatar/${userId}" alt="" onerror="this.remove()"/>`
}

// ── time helpers ───────────────────────────────────────────
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── DOM refs ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const chatList = $('chatList');
const emptyUsers = $('emptyUsers');
const noChat = $('noChat');
const activeChat = $('activeChat');
const headerAvatar = $('headerAvatar');
const headerName = $('headerName');
const headerStatus = $('headerStatus');
const messagesEl = $('messages');
const messagesWrap = $('messagesWrap');
const loadMoreDiv = $('loadMore');
const loadMoreBtn = $('loadMoreBtn');
const msgInput = $('msgInput');
const sendBtn = $('sendBtn');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const emojiBtn = $('emojiBtn');
const emojiPicker = $('emojiPicker');
const emojiGrid = $('emojiGrid');
const emojiTabs = $('emojiTabs');
const emojiSearch = $('emojiSearch');
const replyBar = $('replyBar');
const replyText = $('replyText');
const replyClose = $('replyClose');
const selectionBar = $('selectionBar');
const selCount = $('selCount');
const searchInput = $('searchInput');
const sidebar = $('sidebar');
const backBtn = $('backBtn');
const forwardModal = $('forwardModal');
const forwardList = $('forwardUserList');
const mediaViewer = $('mediaViewer');
const mediaContent = $('mediaContent');

// ── API helpers ────────────────────────────────────────────
async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  return r.json();
}

// ── WebSocket ──────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'new_message') onNewMessage(d);
    if (d.type === 'message_sent') onMessageSent(d);
    if (d.type === 'messages_deleted') onMessagesDeleted(d);
  };
  S.ws.onclose = () => setTimeout(connectWS, 2000);
}

function onNewMessage(d) {
  // update user list
  refreshUsers();
  // if chat is open, append message
  if (String(d.user_id) === String(S.currentUserId)) {
    appendMessage(d.message);
    scrollBottom();
    clearUnread(d.user_id);
  }
}
function onMessageSent(d) {
  refreshUsers();
  if (String(d.user_id) === String(S.currentUserId)) {
    appendMessage(d.message);
    scrollBottom();
  }
}
function onMessagesDeleted(d) {
  if (String(d.user_id) === String(S.currentUserId)) {
    d.msg_ids.forEach(id => {
      const el = document.querySelector(`.msg[data-id="${id}"]`);
      if (el) el.remove();
    });
  }
  refreshUsers();
}

// ── users ──────────────────────────────────────────────────
async function refreshUsers() {
  S.users = await api('/api/users');
  renderUserList(S.users);
}

function renderUserList(users) {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = q ? users.filter(u =>
    (u.full_name || '').toLowerCase().includes(q) ||
    (u.username || '').toLowerCase().includes(q)
  ) : users;

  emptyUsers.classList.toggle('hidden', filtered.length > 0);

  // keep existing items for animation
  const existing = new Set([...chatList.querySelectorAll('.chat-item')].map(e => e.dataset.uid));
  const newIds = new Set(filtered.map(u => String(u.user_id)));

  // remove old
  chatList.querySelectorAll('.chat-item').forEach(el => {
    if (!newIds.has(el.dataset.uid)) el.remove();
  });

  filtered.forEach(u => {
    const uid = String(u.user_id);
    let el = chatList.querySelector(`.chat-item[data-uid="${uid}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'chat-item';
      el.dataset.uid = uid;
      el.onclick = () => selectChat(u.user_id);
      chatList.appendChild(el);
    }
    const lm = u.last_message;
    const preview = lm ? (lm.media_type ? `📎 ${lm.media_type}` : lm.text || '') : '';
    const time = lm ? fmtTime(lm.timestamp) : '';
    const badge = u.unread_count > 0 ? `<span class="chat-badge">${u.unread_count}</span>` : '';

    el.innerHTML = `
      <div class="chat-avatar" style="background:${avatarColor(u.user_id)}">${avatarHtml(u.user_id, u.full_name)}</div>
      <div class="chat-meta">
        <div class="chat-name">${esc(u.full_name)}</div>
        <div class="chat-preview">${esc(preview).slice(0, 50)}</div>
      </div>
      <div class="chat-right">
        <span class="chat-time">${time}</span>
        ${badge}
      </div>`;
    el.classList.toggle('active', uid === String(S.currentUserId));
  });
}

// ── select chat ────────────────────────────────────────────
async function selectChat(userId) {
  S.currentUserId = userId;
  S.offset = 0;
  S.selectedMsgs.clear();
  S.selecting = false;
  S.replyTo = null;
  selectionBar.classList.add('hidden');
  replyBar.classList.add('hidden');

  const u = S.users.find(x => x.user_id === userId);
  if (!u) return;

  // header
  headerAvatar.innerHTML = avatarHtml(userId, u.full_name);
  headerAvatar.style.background = avatarColor(userId);
  headerName.textContent = u.full_name;
  headerStatus.textContent = u.username ? `@${u.username}` : `ID: ${userId}`;

  // show chat
  noChat.classList.add('hidden');
  activeChat.classList.remove('hidden');
  sidebar.classList.add('collapsed');

  // load messages
  messagesEl.innerHTML = '';
  await loadMessages(false);
  scrollBottom(true);

  // mark read
  clearUnread(userId);

  // highlight sidebar
  chatList.querySelectorAll('.chat-item').forEach(el =>
    el.classList.toggle('active', el.dataset.uid === String(userId))
  );

  msgInput.focus();
}

async function loadMessages(prepend = true) {
  if (S.loading) return;
  S.loading = true;
  const data = await api(`/api/messages/${S.currentUserId}?offset=${S.offset}&limit=30`);
  S.hasMore = data.has_more;
  loadMoreDiv.classList.toggle('hidden', !S.hasMore);
  S.offset += data.messages.length;

  if (prepend && data.messages.length) {
    const prevH = messagesWrap.scrollHeight;
    const frag = document.createDocumentFragment();
    data.messages.forEach(m => frag.appendChild(createMsgEl(m)));
    messagesEl.prepend(frag);
    // keep scroll position
    messagesWrap.scrollTop += messagesWrap.scrollHeight - prevH;
  } else {
    data.messages.forEach(m => appendMessage(m));
  }
  S.loading = false;
}

// ── messages ───────────────────────────────────────────────
function createMsgEl(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.direction}${S.selecting ? ' selecting' : ''}`;
  div.dataset.id = m.msg_id;

  let html = '';

  // checkbox
  html += `<input type="checkbox" class="msg-checkbox" ${S.selectedMsgs.has(m.msg_id) ? 'checked' : ''}/>`;

  // forwarded
  if (m.forwarded_from) {
    html += `<div class="msg-fwd">↗️ Forwarded from ${esc(m.forwarded_from)}</div>`;
  }

  // reply
  if (m.reply_to) {
    html += `<div class="msg-reply" data-reply="${m.reply_to}">↩ Reply to #${m.reply_to}</div>`;
  }

  // media
  if (m.media_type && m.media_file) {
    const url = `/api/media/${S.currentUserId}/${m.media_file}`;
    if (m.media_type === 'photo' || m.media_type === 'sticker') {
      html += `<div class="msg-media"><img src="${url}" alt="photo" loading="lazy" onclick="openMedia('${url}','image')"/></div>`;
    } else if (m.media_type === 'video' || m.media_type === 'video_note') {
      html += `<div class="msg-media"><video src="${url}" controls preload="metadata"></video></div>`;
    } else if (m.media_type === 'audio' || m.media_type === 'voice') {
      html += `<div class="msg-media"><audio src="${url}" controls preload="metadata"></audio></div>`;
    } else {
      html += `<div class="msg-media"><a class="doc-file" href="${url}" download>📄 ${esc(m.media_file)}</a></div>`;
    }
  }

  // text
  if (m.text) {
    html += `<div class="msg-text">${esc(m.text)}</div>`;
  }

  // time
  html += `<div class="msg-time">${fmtTime(m.timestamp)}</div>`;

  div.innerHTML = html;

  // click to select in select mode
  div.addEventListener('click', e => {
    if (!S.selecting) return;
    if (e.target.tagName === 'A' || e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') return;
    toggleSelect(m.msg_id, div);
  });

  // double-click to reply
  div.addEventListener('dblclick', e => {
    if (S.selecting) return;
    setReply(m.msg_id, m.text || m.media_type || '');
  });

  // reply link click
  const replyEl = div.querySelector('.msg-reply');
  if (replyEl) {
    replyEl.addEventListener('click', () => {
      const target = document.querySelector(`.msg[data-id="${m.reply_to}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '2px solid var(--accent)';
        setTimeout(() => target.style.outline = '', 1500);
      }
    });
  }

  return div;
}

function appendMessage(m) {
  // avoid duplicates
  if (messagesEl.querySelector(`.msg[data-id="${m.msg_id}"]`)) return;
  messagesEl.appendChild(createMsgEl(m));
}

function scrollBottom(instant = false) {
  setTimeout(() => {
    messagesWrap.scrollTo({ top: messagesWrap.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  }, 50);
}

// ── selection ──────────────────────────────────────────────
function enterSelectMode() {
  S.selecting = true;
  S.selectedMsgs.clear();
  selectionBar.classList.remove('hidden');
  messagesEl.querySelectorAll('.msg').forEach(el => el.classList.add('selecting'));
  updateSelCount();
}
function exitSelectMode() {
  S.selecting = false;
  S.selectedMsgs.clear();
  selectionBar.classList.add('hidden');
  messagesEl.querySelectorAll('.msg').forEach(el => {
    el.classList.remove('selecting', 'selected');
    const cb = el.querySelector('.msg-checkbox');
    if (cb) cb.checked = false;
  });
}
function toggleSelect(msgId, el) {
  if (S.selectedMsgs.has(msgId)) {
    S.selectedMsgs.delete(msgId);
    el.classList.remove('selected');
    el.querySelector('.msg-checkbox').checked = false;
  } else {
    S.selectedMsgs.add(msgId);
    el.classList.add('selected');
    el.querySelector('.msg-checkbox').checked = true;
  }
  updateSelCount();
}
function updateSelCount() {
  selCount.textContent = `${S.selectedMsgs.size} selected`;
}

// ── send ───────────────────────────────────────────────────
async function sendText() {
  const text = msgInput.value.trim();
  if (!text || !S.currentUserId) return;
  msgInput.value = '';
  autoResize();

  await api('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: S.currentUserId,
      text,
      reply_to: S.replyTo,
    }),
  });
  clearReply();
}

async function sendFile(file) {
  if (!S.currentUserId) return;
  const fd = new FormData();
  fd.append('user_id', S.currentUserId);
  fd.append('reply_to', S.replyTo || '');
  fd.append('caption', '');
  fd.append('file', file);
  await api('/api/upload', { method: 'POST', body: fd });
  clearReply();
}

// ── reply ──────────────────────────────────────────────────
function setReply(msgId, text) {
  S.replyTo = msgId;
  replyText.textContent = text.slice(0, 80) || '📎 Media';
  replyBar.classList.remove('hidden');
  msgInput.focus();
}
function clearReply() {
  S.replyTo = null;
  replyBar.classList.add('hidden');
}

// ── delete / copy / forward ────────────────────────────────
async function deleteSelected() {
  if (!S.selectedMsgs.size) return;
  if (!confirm(`Delete ${S.selectedMsgs.size} message(s)?`)) return;
  await api('/api/messages', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: S.currentUserId, msg_ids: [...S.selectedMsgs] }),
  });
  exitSelectMode();
}

function copySelected() {
  const texts = [];
  S.selectedMsgs.forEach(id => {
    const el = document.querySelector(`.msg[data-id="${id}"] .msg-text`);
    if (el) texts.push(el.textContent);
  });
  if (texts.length) {
    navigator.clipboard.writeText(texts.join('\n\n'));
    toast('Copied to clipboard');
  }
  exitSelectMode();
}

function openForwardModal() {
  S.forwardTargets.clear();
  forwardList.innerHTML = '';
  S.users.forEach(u => {
    if (u.user_id === S.currentUserId) return;
    const div = document.createElement('div');
    div.className = 'fwd-user';
    div.innerHTML = `
      <div class="fwd-avatar" style="background:${avatarColor(u.user_id)}">${avatarHtml(u.user_id, u.full_name)}</div>
      <span class="fwd-name">${esc(u.full_name)}</span>`;
    div.onclick = () => {
      if (S.forwardTargets.has(u.user_id)) {
        S.forwardTargets.delete(u.user_id);
        div.classList.remove('chosen');
      } else {
        S.forwardTargets.add(u.user_id);
        div.classList.add('chosen');
      }
    };
    forwardList.appendChild(div);
  });
  forwardModal.classList.remove('hidden');
}

async function confirmForward() {
  if (!S.forwardTargets.size || !S.selectedMsgs.size) return;
  await api('/api/forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_user_id: S.currentUserId,
      to_user_ids: [...S.forwardTargets],
      msg_ids: [...S.selectedMsgs],
    }),
  });
  forwardModal.classList.add('hidden');
  exitSelectMode();
  toast('Messages forwarded');
}

// ── unread ─────────────────────────────────────────────────
async function clearUnread(uid) {
  await api('/api/clear-unread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: uid }),
  });
  refreshUsers();
}

// ── media viewer ───────────────────────────────────────────
function openMedia(url, type) {
  mediaContent.innerHTML = type === 'image'
    ? `<img src="${url}" alt=""/>`
    : `<video src="${url}" controls autoplay></video>`;
  mediaViewer.classList.remove('hidden');
}

// ── emoji picker ───────────────────────────────────────────
const EMOJIS = {
  '😀': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖'],
  '👋': ['👋', '🤚', '🖐', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁', '👅', '👄', '🫦', '💋'],
  '❤️': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '🔥', '⭐', '🌟', '✨', '⚡', '💫', '💥', '💢', '💦', '💨', '🕳', '💣', '💬', '💭', '🏳️‍🌈', '🏴‍☠️'],
  '🐶': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪲', '🪳', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫'],
  '🍎': ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🫛', '🥦', '🥬', '🥒', '🌶', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🫘', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥗', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🎂', '🍰', '🧁', '🥧', '🍫', '🍬', '🍭', '🍮', '🍯', '🍼', '🥛', '☕', '🫖', '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂', '🥃'],
  '⚽': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸', '🥌', '🎿', '⛷', '🏂', '🪂', '🏋️', '🤸', '🤺', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖', '🏵', '🎗', '🎫', '🎟', '🎪'],
  '🚗': ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🛵', '🏍', '🛺', '🚲', '🛴', '🚏', '🛣', '🛤', '⛽', '🚨', '🚥', '🚦', '🛑', '🚧', '⚓', '⛵', '🛶', '🚤', '🛳', '⛴', '🛥', '🚢', '✈️', '🛩', '🛫', '🛬', '🪂', '💺', '🚁', '🚟', '🚠', '🚡', '🛰', '🚀', '🛸', '🌍', '🌎', '🌏', '🗺', '🧭', '🏔', '⛰', '🌋', '🗻', '🏕', '🏖', '🏜', '🏝', '🏞'],
};
const EMOJI_TABS = Object.keys(EMOJIS);
let currentEmojiTab = EMOJI_TABS[0];

function initEmojiPicker() {
  // tabs
  EMOJI_TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = `emoji-tab${tab === currentEmojiTab ? ' active' : ''}`;
    btn.textContent = tab;
    btn.onclick = () => {
      currentEmojiTab = tab;
      emojiTabs.querySelectorAll('.emoji-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderEmojis();
    };
    emojiTabs.appendChild(btn);
  });
  renderEmojis();
  emojiSearch.oninput = renderEmojis;
}

function renderEmojis() {
  const q = emojiSearch.value.trim().toLowerCase();
  emojiGrid.innerHTML = '';
  let list = q
    ? Object.values(EMOJIS).flat().filter(e => e.includes(q))
    : EMOJIS[currentEmojiTab] || [];
  list.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-cell';
    btn.textContent = e;
    btn.onclick = () => {
      msgInput.value += e;
      msgInput.focus();
    };
    emojiGrid.appendChild(btn);
  });
}

// ── auto‑resize textarea ───────────────────────────────────
function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
}

// ── toast ──────────────────────────────────────────────────
function toast(msg, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── util ───────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── fetch bot name & set branding ─────────────────────────────
async function fetchBotInfo() {
  try {
    const info = await api('/api/bot-info');
    const name = info.name || info.username || 'Chat';
    $('logoText').textContent = name;
    $('pageTitle').textContent = `${name} Chat`;
  } catch (e) { /* ignore */ }
}

// ── sidebar resize ──────────────────────────────────────
function initSidebarResize() {
  const handle = $('sidebarResize');
  if (!handle) return;
  let startX, startW;

  function onMouseMove(e) {
    const newW = startW + (e.clientX - startX);
    sidebar.style.width = Math.max(220, Math.min(newW, window.innerWidth * 0.5)) + 'px';
  }
  function onMouseUp() {
    handle.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // touch support for mobile (drag handle is hidden on mobile, but just in case)
  handle.addEventListener('touchstart', e => {
    const touch = e.touches[0];
    startX = touch.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('active');
    function onTouchMove(e) {
      const t = e.touches[0];
      const newW = startW + (t.clientX - startX);
      sidebar.style.width = Math.max(220, Math.min(newW, window.innerWidth * 0.5)) + 'px';
    }
    function onTouchEnd() {
      handle.classList.remove('active');
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    }
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
  }, { passive: true });
}

// ── event wiring ─────────────────────────────────────────
function init() {
  connectWS();
  fetchBotInfo();
  refreshUsers();
  initEmojiPicker();
  initSidebarResize();

  // send
  sendBtn.onclick = sendText;
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  msgInput.addEventListener('input', autoResize);

  // attach
  attachBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    [...fileInput.files].forEach(f => sendFile(f));
    fileInput.value = '';
  };

  // emoji
  emojiBtn.onclick = () => {
    S.emojiOpen = !S.emojiOpen;
    emojiPicker.classList.toggle('hidden', !S.emojiOpen);
  };
  document.addEventListener('click', e => {
    if (S.emojiOpen && !emojiPicker.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) {
      S.emojiOpen = false;
      emojiPicker.classList.add('hidden');
    }
  });

  // reply
  replyClose.onclick = clearReply;

  // selection
  $('selectModeBtn').onclick = () => S.selecting ? exitSelectMode() : enterSelectMode();
  $('selCancel').onclick = exitSelectMode;
  $('selDelete').onclick = deleteSelected;
  $('selCopy').onclick = copySelected;
  $('selForward').onclick = openForwardModal;

  // forward modal
  $('forwardClose').onclick = () => forwardModal.classList.add('hidden');
  $('forwardConfirm').onclick = confirmForward;

  // media viewer
  $('mediaClose').onclick = () => mediaViewer.classList.add('hidden');
  mediaViewer.onclick = e => { if (e.target === mediaViewer) mediaViewer.classList.add('hidden'); };

  // load older
  loadMoreBtn.onclick = () => loadMessages(true);

  // scroll detection for load more
  messagesWrap.addEventListener('scroll', () => {
    if (messagesWrap.scrollTop < 60 && S.hasMore && !S.loading) {
      loadMessages(true);
    }
  });

  // search
  searchInput.oninput = () => renderUserList(S.users);

  // back (mobile)
  backBtn.onclick = () => {
    sidebar.classList.remove('collapsed');
    activeChat.classList.add('hidden');
    noChat.classList.remove('hidden');
    S.currentUserId = null;
  };

  // keyboard shortcut: Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (S.emojiOpen) { S.emojiOpen = false; emojiPicker.classList.add('hidden'); }
      else if (!forwardModal.classList.contains('hidden')) forwardModal.classList.add('hidden');
      else if (!mediaViewer.classList.contains('hidden')) mediaViewer.classList.add('hidden');
      else if (S.selecting) exitSelectMode();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
