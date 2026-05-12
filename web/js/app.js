// state
const s = {
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
  pendingFiles: [], // File objects
  dragSelecting: false,
  contextMenuEl: null,
  contextMsgId: null,
  groupMembers: {}, // chat_id -> {id: name}
  msgCache: {},      // chat_id -> { msg_id -> msg } — for reply previews
};

// Check if user is scrolled near the bottom of the messages panel
function isNearBottom(threshold = 150) {
  const el = messagesWrap;
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

// cache a message for reply preview lookup
function cacheMsg(chatId, msg) {
  const cid = String(chatId);
  if (!s.msgCache[cid]) s.msgCache[cid] = {};
  s.msgCache[cid][msg.msg_id] = msg;
}
function getCachedMsg(chatId, msgId) {
  const cid = String(chatId);
  return s.msgCache[cid] && s.msgCache[cid][msgId] || null;
}

// frequent emojis (default tab)
const frequent_emojis = ['😭', '🙂', '😐', '😅', '😂', '🙃', '👀', '💀', '🥲', '🙏', '🙄', '🫡', '🔥', '😏', '😕', '🥹', '😒', '😫', '🫠', '☠️', '😔', '😈', '😊', '😱', '😮‍💨', '🙁', '❤️', '🤣', '😌', '😞'];
// quick react row in context menu
const quick_reactions = ['👍', '❤️', '🤣', '😁', '😱', '😢', '😭', '🔥', '🙏'];

// avatar colours
const palette = [
  '#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb',
  '#64b5f6', '#4fc3f7', '#4dd0e1', '#4db6ac', '#81c784',
  '#aed581', '#dce775', '#ffd54f', '#ffb74d', '#ff8a65',
];
function avatarColor(id) { return palette[Math.abs(id) % palette.length]; }
function initials(name) { return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(); }

// build avatar html with photo on top, initials as fallback underneath
function avatarHtml(userId, name) {
  const ini = initials(name);
  return `<span class="avatar-initials">${ini}</span><img class="avatar-img" src="/api/avatar/${userId}" alt="" onerror="this.remove()"/>`;
}

// time helpers
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

// DOM refs
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
const scrollDownBtn = $('scrollDownBtn');
const scrollBadge = $('scrollBadge');
const pinnedBar = $('pinnedBar');
const pinnedContent = $('pinnedContent');
let unreadBelow = 0;

function updateScrollBadge() {
  if (unreadBelow > 0) {
    scrollBadge.textContent = unreadBelow;
    scrollBadge.classList.remove('hidden');
  } else {
    scrollBadge.classList.add('hidden');
  }
}

const loadMoreDiv = $('loadMore');
const loadMoreBtn = $('loadMoreBtn');
const msgInput = $('msgInput');
const sendBtn = $('sendBtn');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const emojiBtn = $('emojiBtn');
const emojiBtnWrap = $('emojiBtnWrap');
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
const filePreviewBar = $('filePreviewBar');
const filePreviewList = $('filePreviewList');
const fileClearBtn = $('fileClearBtn');
const editHistoryModal = $('editHistoryModal');
const editHistoryBody = $('editHistoryBody');
const editModal = $('editModal');
const editMsgInput = $('editMsgInput');
const inputFieldWrap = $('inputFieldWrap');
const groupInfoBtn = $('groupInfoBtn');
const groupInfoModal = $('groupInfoModal');
const groupInfoBody = $('groupInfoBody');

// API helpers
function linkify(text) {
  if (!text) return '';
  const escaped = esc(text);
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  return escaped.replace(urlRegex, function (url) {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
  });
}

async function api(url, opts = {}) {
  opts.cache = 'no-store'; // Fix: prevent aggressive browser caching that hides unread badges
  const r = await fetch(url, opts);
  const data = await r.json();
  if (data.status === 'error') {
    toast(`Error: ${data.error}`);
    throw new Error(data.error);
  }
  return data;
}

// WebSocket
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  s.ws = new WebSocket(`${proto}://${location.host}/ws`);
  s.ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'new_message') onNewMessage(d);
    if (d.type === 'message_sent') onMessageSent(d);
    if (d.type === 'messages_deleted') onMessagesDeleted(d);
    if (d.type === 'reaction_update') onReactionUpdate(d);
    if (d.type === 'message_edited') onMessageEdited(d);
    if (d.type === 'pinned_updated') onPinnedUpdated(d);
  };
  s.ws.onclose = () => setTimeout(connectWS, 2000);
}

function onPinnedUpdated(d) {
  refreshUsers();
  if (String(d.user_id) === String(s.currentUserId)) {
    updatePinnedBar(d.pinned_msg_id);
  }
}

function onNewMessage(d) {
  if (String(d.user_id) === String(s.currentUserId)) {
    cacheMsg(d.user_id, d.message);
    const wasNearBottom = isNearBottom(150);
    appendMessage(d.message);
    if (wasNearBottom) {
      scrollBottom();
      clearUnread(d.user_id);
    } else {
      unreadBelow++;
      updateScrollBadge();
    }
  }
  refreshUsers();
}
function onMessageSent(d) {
  refreshUsers();
  if (String(d.user_id) === String(s.currentUserId)) {
    cacheMsg(d.user_id, d.message);
    appendMessage(d.message);
    scrollBottom(); // always scroll for own sent messages
  }
}
function onMessagesDeleted(d) {
  if (String(d.user_id) === String(s.currentUserId)) {
    d.msg_ids.forEach(id => {
      const el = document.querySelector(`.msg-row[data-id="${id}"]`);
      if (el) el.remove();
    });
  }
  refreshUsers();
}

function onReactionUpdate(d) {
  if (String(d.user_id) === String(s.currentUserId)) {
    const row = document.querySelector(`.msg-row[data-id="${d.msg_id}"]`);
    if (row) {
      const msgBubble = row.querySelector('.msg');
      updateReactionsDisplay(msgBubble, d.reactions, d.reactor_names, d.msg_id);
    }
  }
}
function onMessageEdited(d) {
  if (String(d.user_id) === String(s.currentUserId) && d.message) {
    const row = document.querySelector(`.msg-row[data-id="${d.msg_id}"]`);
    if (row) {
      const msgBubble = row.querySelector('.msg');
      // update text
      const textEl = msgBubble.querySelector('.msg-text');
      if (textEl) textEl.textContent = d.message.text || '';
      else if (d.message.text) {
        const newText = document.createElement('div');
        newText.className = 'msg-text';
        newText.textContent = d.message.text;
        const timeEl = msgBubble.querySelector('.msg-time');
        msgBubble.insertBefore(newText, timeEl);
      }
      // update edited label
      const timeEl = msgBubble.querySelector('.msg-time');
      if (timeEl && d.message.edited && !timeEl.querySelector('.msg-edited-label')) {
        const label = document.createElement('span');
        label.className = 'msg-edited-label';
        label.textContent = 'edited';
        label.onclick = (ev) => { ev.stopPropagation(); showEditHistory(d.msg_id); };
        timeEl.prepend(label);
      }
    }
  }
}

// users
async function refreshUsers() {
  s.users = await api('/api/users');
  renderUserList(s.users);
}

function renderUserList(users) {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = q ? users.filter(u =>
    (u.full_name || '').toLowerCase().includes(q) ||
    (u.username || '').toLowerCase().includes(q)
  ) : users;

  emptyUsers.classList.toggle('hidden', filtered.length > 0);

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
        <div class="chat-name">${esc(u.full_name)} ${u.is_banned ? '<span style="color:var(--danger);font-size:11px;">(Blocked)</span>' : ''}</div>
        <div class="chat-preview">${esc(preview).slice(0, 50)}</div>
      </div>
      <div class="chat-right">
        <span class="chat-time">${time}</span>
        ${badge}
      </div>`;
    el.classList.toggle('active', uid === String(s.currentUserId));
  });
}

// select chat
async function selectChat(userId) {
  s.currentUserId = String(userId);
  s.offset = 0;
  s.selectedMsgs.clear();
  s.selecting = false;
  s.replyTo = null;
  s.pendingFiles = [];
  unreadBelow = 0;
  updateScrollBadge();
  scrollDownBtn.classList.add('hidden');
  selectionBar.classList.add('hidden');
  replyBar.classList.add('hidden');
  filePreviewBar.classList.add('hidden');

  const u = s.users.find(x => String(x.user_id) === String(userId));
  if (!u) return;

  // header
  const isGroup = u.type === 'group' || u.type === 'supergroup';
  headerAvatar.innerHTML = avatarHtml(userId, u.full_name);
  headerAvatar.style.background = avatarColor(userId);
  headerName.textContent = u.full_name;
  headerStatus.textContent = isGroup ? 'Group' : (u.username ? `@${u.username}` : `ID: ${userId}`);

  if (isGroup) {
    groupInfoBtn.classList.remove('hidden');
  } else {
    groupInfoBtn.classList.add('hidden');
  }

  updatePinnedBar(u.pinned_msg_id || null);

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
  if (s.loading) return;
  s.loading = true;
  const data = await api(`/api/messages/${s.currentUserId}?offset=${s.offset}&limit=30`);
  s.hasMore = data.has_more;
  loadMoreDiv.classList.toggle('hidden', !s.hasMore);
  s.offset += data.messages.length;

  // cache all loaded messages for reply previews
  data.messages.forEach(m => cacheMsg(s.currentUserId, m));

  if (prepend && data.messages.length) {
    const prevH = messagesWrap.scrollHeight;
    const frag = document.createDocumentFragment();
    data.messages.forEach(m => frag.appendChild(createMsgRow(m)));
    messagesEl.prepend(frag);
    // keep scroll position
    messagesWrap.scrollTop += messagesWrap.scrollHeight - prevH;
  } else {
    data.messages.forEach(m => appendMessage(m));
  }
  s.loading = false;
}

// messages
function createMsgRow(m) {
  const row = document.createElement('div');
  row.className = `msg-row ${m.direction === 'in' ? 'in-row' : 'out-row'}${s.selecting ? ' selecting' : ''}`;
  row.dataset.id = m.msg_id;

  // checkbox for selection
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'msg-row-checkbox';
  cb.checked = s.selectedMsgs.has(m.msg_id);
  row.appendChild(cb);

  // wrapper keeps bubble + arrow side by side
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';

  // the bubble
  const bubble = createMsgBubble(m);
  wrap.appendChild(bubble);

  // hover action arrow
  const hoverWrap = document.createElement('div');
  hoverWrap.className = 'msg-hover-actions';
  const arrow = document.createElement('div');
  arrow.className = 'msg-action-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  arrow.onclick = (e) => {
    e.stopPropagation();
    showContextMenu(e, m, row);
  };
  hoverWrap.appendChild(arrow);
  wrap.appendChild(hoverWrap);

  row.appendChild(wrap);

  // selection logic: click anywhere in row to select (in select mode)
  row.addEventListener('click', e => {
    if (!s.selecting) return;
    if (e.target.closest('.msg-hover-actions') || e.target.closest('.msg-action-arrow')) return;
    if (e.target.tagName === 'A') return;
    toggleSelect(m.msg_id, row);
  });

  // double-click to reply
  row.addEventListener('dblclick', e => {
    if (s.selecting) return;
    setReply(m.msg_id, m.text || m.media_type || '');
  });

  // drag-select support
  row.addEventListener('mousedown', e => {
    if (s.selecting && e.button === 0) {
      e.preventDefault();
      s.dragSelecting = true;
    }
  });
  row.addEventListener('mouseenter', () => {
    if (s.dragSelecting && s.selecting) {
      if (!s.selectedMsgs.has(m.msg_id)) {
        toggleSelect(m.msg_id, row);
      }
    }
  });

  if (s.selectedMsgs.has(m.msg_id)) {
    row.classList.add('selected-row');
  }

  return row;
}

function createMsgBubble(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.direction}`;

  let html = '';



  // add sender name for incoming messages in group chats
  const chatConfig = s.users.find(x => String(x.user_id) === String(s.currentUserId));
  const isGroup = chatConfig && (chatConfig.type === 'group' || chatConfig.type === 'supergroup');
  if (isGroup && m.direction === 'in' && m.sender_name) {
    const sCol = avatarColor(m.sender_id || 0);
    html += `<div class="msg-sender" style="color: ${sCol}; font-weight: 500; font-size: 13px; margin-bottom: 2px;">${esc(m.sender_name)}</div>`;
  }

  // forwarded
  if (m.forwarded_from) {
    html += `<div class="msg-fwd">↗️ Forwarded from ${esc(m.forwarded_from)}</div>`;
  }

  // reply — show rich preview of replied-to message
  if (m.reply_to) {
    html += `<div class="msg-reply" data-reply="${m.reply_to}"><div class="reply-preview-content" data-reply-id="${m.reply_to}"><span class="reply-loading">↩ Loading…</span></div></div>`;
  }

  // media
  if (m.media_type && m.media_file) {
    const url = `/api/media/${s.currentUserId}/${m.media_file}`;
    if (m.media_type === 'sticker') {
      html += `<div class="msg-media"><img class="sticker-img" src="${url}" alt="sticker" loading="lazy" onerror="this.outerHTML='<video class=\\'sticker-video\\' src=\\'${url}\\' autoplay loop muted playsinline></video>'"/></div>`;
    } else if (m.media_type === 'video_sticker') {
      html += `<div class="msg-media"><video class="sticker-video" src="${url}" autoplay loop muted playsinline></video></div>`;
    } else if (m.media_type === 'animated_sticker') {
      // TGS files can't be rendered natively; show placeholder
      html += `<div class="msg-media"><div class="doc-file">🎭 Animated sticker</div></div>`;
    } else if (m.media_type === 'photo') {
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
    html += `<div class="msg-text">${linkify(m.text)}</div>`;
  }

  // reactions
  if (m.reactions && Object.keys(m.reactions).length > 0) {
    html += buildReactionsHtml(m.reactions, m.reactor_names, m.msg_id);
  }

  // time + edited label
  const editedLabel = m.edited ? `<span class="msg-edited-label" data-msgid="${m.msg_id}">edited</span>` : '';
  html += `<div class="msg-time">${editedLabel}${fmtTime(m.timestamp)}</div>`;

  div.innerHTML = html;

  // populate reply preview
  if (m.reply_to) {
    const previewEl = div.querySelector('.reply-preview-content');
    if (previewEl) fillReplyPreview(previewEl, m.reply_to);
  }

  // reply link click
  const replyEl = div.querySelector('.msg-reply');
  if (replyEl) {
    replyEl.addEventListener('click', async () => {
      let target = document.querySelector(`.msg-row[data-id="${m.reply_to}"]`);
      if (!target) {
        replyEl.style.opacity = '0.5';
        while (!target && s.hasMore) {
          await loadMessages(true);
          target = document.querySelector(`.msg-row[data-id="${m.reply_to}"]`);
        }
        replyEl.style.opacity = '1';
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '2px solid var(--accent)';
        setTimeout(() => target.style.outline = '', 1500);
      }
    });
  }

  // edited label click
  const editLabel = div.querySelector('.msg-edited-label');
  if (editLabel) {
    editLabel.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showEditHistory(m.msg_id);
    });
  }

  // reaction badge clicks (toggle own reaction)
  div.querySelectorAll('.reaction-badge').forEach(badge => {
    badge.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const emoji = badge.dataset.emoji;
      await api('/api/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: s.currentUserId, msg_id: m.msg_id, emoji }),
      });
    });
  });

  return div;
}

function buildReactionsHtml(reactions, reactorNames, msgId) {
  reactions = reactions || {};
  reactorNames = reactorNames || {};

  // reactions = {reactor: emoji} — aggregate by emoji for display
  const agg = {};
  for (const [reactor, emoji] of Object.entries(reactions)) {
    if (!agg[emoji]) agg[emoji] = { count: 0, isMine: false, users: [] };
    agg[emoji].count++;
    if (reactor === 'me') agg[emoji].isMine = true;
    else {
      let rName = 'User ' + reactor;
      if (reactorNames[reactor]) {
        rName = reactorNames[reactor];
      } else if (s.groupMembers[s.currentUserId] && s.groupMembers[s.currentUserId][reactor]) {
        rName = s.groupMembers[s.currentUserId][reactor];
      } else {
        const u = s.users.find(x => String(x.user_id) === String(reactor));
        if (u) rName = u.full_name || u.username;
      }
      agg[emoji].users.push(rName);
    }
  }
  let html = '<div class="msg-reactions">';
  for (const [emoji, info] of Object.entries(agg)) {
    let tooltip = '';
    if (info.users.length) tooltip = info.users.join('\n');
    if (info.isMine) tooltip = ('You\n' + tooltip).trim();
    html += `<span class="reaction-badge${info.isMine ? ' my-reaction' : ''}" data-emoji="${emoji}" title="${esc(tooltip)}">
      ${emoji}<span class="reaction-count">${info.count}</span>
    </span>`;
  }
  html += '</div>';
  return html;
}

function updateReactionsDisplay(bubble, reactions, reactorNames, msgId) {
  let reactionsEl = bubble.querySelector('.msg-reactions');
  if (!reactions || Object.keys(reactions).length === 0) {
    if (reactionsEl) reactionsEl.remove();
    return;
  }
  const html = buildReactionsHtml(reactions, reactorNames, msgId);
  if (reactionsEl) {
    reactionsEl.outerHTML = html;
  } else {
    const timeEl = bubble.querySelector('.msg-time');
    timeEl.insertAdjacentHTML('beforebegin', html);
  }
  // re-bind click handlers
  bubble.querySelectorAll('.reaction-badge').forEach(badge => {
    badge.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const emoji = badge.dataset.emoji;
      await api('/api/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: s.currentUserId, msg_id: msgId, emoji }),
      });
    });
  });
}

function appendMessage(m) {
  // avoid duplicates
  if (messagesEl.querySelector(`.msg-row[data-id="${m.msg_id}"]`)) return;
  cacheMsg(s.currentUserId, m);
  messagesEl.appendChild(createMsgRow(m));
}

// Build a pretty reply preview from a replied-to message
function replyPreviewHtml(repliedMsg) {
  const senderName = repliedMsg.sender_name || (repliedMsg.direction === 'out' ? 'You' : 'User');
  const sCol = repliedMsg.sender_id ? avatarColor(repliedMsg.sender_id) : 'var(--accent)';
  let content = '';
  if (repliedMsg.media_type) {
    const mediaIcons = { photo: '🖼 Photo', video: '📹 Video', audio: '🎵 Audio', voice: '🎤 Voice', sticker: '🎭 Sticker', video_sticker: '🎭 Sticker', animated_sticker: '🎭 Sticker', document: '📄 Document', video_note: '📹 Video Note' };
    content = mediaIcons[repliedMsg.media_type] || '📎 Media';
    if (repliedMsg.text) content += ' — ' + repliedMsg.text.slice(0, 60);
  } else {
    content = repliedMsg.text ? repliedMsg.text.slice(0, 80) : '…';
  }
  return `<span class="reply-sender" style="color:${sCol}">${esc(senderName)}</span><span class="reply-body">${esc(content)}</span>`;
}

// Fill a reply preview element — try cache first, then API
async function fillReplyPreview(el, replyMsgId) {
  const cached = getCachedMsg(s.currentUserId, replyMsgId);
  if (cached) {
    el.innerHTML = replyPreviewHtml(cached);
    return;
  }
  // Fetch from API
  try {
    const data = await api(`/api/message/${s.currentUserId}/${replyMsgId}`);
    if (data.message) {
      cacheMsg(s.currentUserId, data.message);
      el.innerHTML = replyPreviewHtml(data.message);
    } else {
      el.innerHTML = `<span class="reply-body">↩ Deleted message</span>`;
    }
  } catch {
    el.innerHTML = `<span class="reply-body">↩ Message #${replyMsgId}</span>`;
  }
}

async function updatePinnedBar(msgId) {
  if (!msgId) {
    pinnedBar.classList.add('hidden');
    pinnedContent.innerHTML = '';
    pinnedBar.onclick = null;
    return;
  }

  pinnedBar.classList.remove('hidden');
  pinnedContent.textContent = 'Loading...';

  // fetch and fill
  let m = getCachedMsg(s.currentUserId, msgId);
  if (!m) {
    try {
      const resp = await api(`/api/message/${s.currentUserId}/${msgId}`);
      m = resp.message;
      if (m) cacheMsg(s.currentUserId, m);
    } catch { }
  }

  if (m) {
    const rawContent = m.media_type ? `📎 ${m.media_type} ${m.text || ''}` : (m.text || 'Pinned Message');
    pinnedContent.textContent = rawContent.slice(0, 80);
  } else {
    pinnedContent.innerHTML = '<i>Deleted message</i>';
  }

  // click to scroll
  pinnedBar.onclick = async () => {
    let target = document.querySelector(`.msg-row[data-id="${msgId}"]`);
    if (!target) {
      pinnedBar.style.opacity = '0.5';
      while (!target && s.hasMore) {
        await loadMessages(true);
        target = document.querySelector(`.msg-row[data-id="${msgId}"]`);
      }
      pinnedBar.style.opacity = '1';
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.style.outline = '2px solid var(--accent)';
      setTimeout(() => target.style.outline = '', 1500);
    }
  };
}

function scrollBottom(instant = false) {
  setTimeout(() => {
    messagesWrap.scrollTo({ top: messagesWrap.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  }, 50);
}

messagesWrap.addEventListener('scroll', () => {
  if (isNearBottom(150)) {
    scrollDownBtn.classList.add('hidden');
    if (unreadBelow > 0) {
      unreadBelow = 0;
      updateScrollBadge();
      clearUnread(s.currentUserId);
      refreshUsers();
    }
  } else {
    scrollDownBtn.classList.remove('hidden');
  }
});

scrollDownBtn.addEventListener('click', () => {
  scrollBottom(false);
  if (unreadBelow > 0) {
    unreadBelow = 0;
    updateScrollBadge();
    clearUnread(s.currentUserId);
    refreshUsers();
  }
});

// context menu
function showContextMenu(e, m, row) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';
  s.contextMenuEl = menu;
  s.contextMsgId = m.msg_id;

  // quick reactions row
  const reactRow = document.createElement('div');
  reactRow.className = 'ctx-reaction-row';
  quick_reactions.forEach(emoji => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.onclick = async () => {
      closeContextMenu();
      await api('/api/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: s.currentUserId, msg_id: m.msg_id, emoji }),
      });
    };
    reactRow.appendChild(btn);
  });
  menu.appendChild(reactRow);

  // menu items
  const items = [
    { label: '↩ Reply', icon: '', action: () => { setReply(m.msg_id, m.text || m.media_type || ''); } },
    { label: '📋 Copy', icon: '', action: () => { if (m.text) { navigator.clipboard.writeText(m.text); toast('Copied'); } } },
    { label: '☑ Select', icon: '', action: () => { enterSelectMode(); toggleSelect(m.msg_id, row); } },
  ];

  if (m.reactions && Object.keys(m.reactions).length > 0) {
    items.unshift({
      label: '👥 View Reactions', icon: '', action: () => {
        let text = [];
        for (const [r, e] of Object.entries(m.reactions)) {
          let n = (m.reactor_names && m.reactor_names[r]) ? m.reactor_names[r] : ('User');
          if (r === 'me') {
            text.push(`${e} - You`);
          } else {
            text.push(`${e} - ${n} (${r})`);
          }
        }
        customAlert("Reactions:\n\n" + text.join('\n'), "Reactions");
      }
    });
  }

  // only allow editing own messages
  if (m.direction === 'out' && m.text) {
    items.push({ label: '✏ Edit', icon: '', action: () => { openEditModal(m.msg_id, m.text); } });
  }

  items.push(
    { label: '↗ Forward', icon: '', action: () => { enterSelectMode(); toggleSelect(m.msg_id, row); openForwardModal(); } },
    {
      label: '🗑 Delete for me', icon: '', cls: 'danger', action: async () => {
        if (!(await customConfirm('Delete this message for yourself?'))) return;
        try {
          await api('/api/messages', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: s.currentUserId, msg_ids: [m.msg_id], for_everyone: false }),
          });
        } catch (e) { }
      }
    },
    {
      label: '🗑 Delete for everyone', icon: '', cls: 'danger', action: async () => {
        if (!(await customConfirm('Delete this message for everyone?'))) return;
        try {
          await api('/api/messages', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: s.currentUserId, msg_ids: [m.msg_id], for_everyone: true }),
          });
        } catch (e) { }
      }
    },
  );

  const chatConfig = s.users.find(x => x.user_id === s.currentUserId);
  const isGroup = chatConfig && (chatConfig.type === 'group' || chatConfig.type === 'supergroup');

  // pin / unpin actions 
  items.push({
    label: '📌 Pin', icon: '', action: async () => {
      await api('/api/pin', { method: 'POST', body: JSON.stringify({ chat_id: s.currentUserId, msg_id: m.msg_id }) });
      toast('Pinned');
    }
  });
  items.push({
    label: '🧷 Unpin', icon: '', action: async () => {
      await api('/api/unpin', { method: 'POST', body: JSON.stringify({ chat_id: s.currentUserId, msg_id: m.msg_id }) });
      toast('Unpinned');
    }
  });

  // group admin actions
  if (isGroup) {
    if (m.direction === 'in' && m.sender_id) {
      items.push({
        label: '⛔ Ban', icon: '', cls: 'danger', action: async () => {
          if (!(await customConfirm(`Ban ${m.sender_name}?`))) return;
          await api('/api/ban', { method: 'POST', body: JSON.stringify({ chat_id: s.currentUserId, user_id: m.sender_id }) });
          toast(`Banned ${m.sender_name}`);
        }
      });
    }
  }

  items.forEach(it => {
    const btn = document.createElement('button');
    btn.className = `ctx-item${it.cls ? ' ' + it.cls : ''}`;
    btn.textContent = it.label;
    btn.onclick = () => { closeContextMenu(); it.action(); };
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // position — measure natural size first
  const rect = menu.getBoundingClientRect();
  const pad = 8;

  let x = e.clientX !== undefined ? e.clientX : (e.touches && e.touches.length > 0 ? e.touches[0].clientX : window.innerWidth / 2);
  let y = e.clientY !== undefined ? e.clientY : (e.touches && e.touches.length > 0 ? e.touches[0].clientY : window.innerHeight / 2);

  // clamp horizontal
  if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
  if (x < pad) x = pad;

  // clamp vertical — prefer showing below cursor, shift up if needed
  if (y + rect.height > window.innerHeight - pad) {
    y = window.innerHeight - rect.height - pad;
  }
  if (y < pad) y = pad;

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // constrain max height so it never overflows the viewport from its final position
  menu.style.maxHeight = (window.innerHeight - y - pad) + 'px';
  menu.style.overflowY = 'auto';

  // mark arrow active
  const hoverWrap = row.querySelector('.msg-hover-actions');
  if (hoverWrap) hoverWrap.classList.add('active');
}

function closeContextMenu() {
  if (s.contextMenuEl) {
    s.contextMenuEl.remove();
    s.contextMenuEl = null;
    document.querySelectorAll('.msg-hover-actions.active').forEach(el => el.classList.remove('active'));
  }
}

// edit modal
function openEditModal(msgId, currentText) {
  editMsgInput.value = currentText;
  editModal.classList.remove('hidden');
  editMsgInput.focus();

  $('editMsgSave').onclick = async () => {
    const newText = editMsgInput.value.trim();
    if (!newText) return;
    await api('/api/edit-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: s.currentUserId, msg_id: msgId, text: newText }),
    });
    editModal.classList.add('hidden');
  };
}

// edit history
async function showEditHistory(msgId) {
  const data = await api(`/api/edit-history/${s.currentUserId}/${msgId}`);
  const history = data.edit_history || [];
  editHistoryBody.innerHTML = '';
  if (history.length === 0) {
    editHistoryBody.innerHTML = '<div style="padding:16px;color:var(--text-dim);">No edit history.</div>';
  } else {
    history.forEach((h, i) => {
      const item = document.createElement('div');
      item.className = 'edit-history-item';
      item.innerHTML = `
        <div class="edit-history-time">${fmtTime(h.edited_at)} — version ${i + 1}</div>
        <div class="edit-history-text">${esc(h.text)}</div>
      `;
      editHistoryBody.appendChild(item);
    });
  }
  editHistoryModal.classList.remove('hidden');
}

// selection
function enterSelectMode() {
  s.selecting = true;
  s.selectedMsgs.clear();
  selectionBar.classList.remove('hidden');
  messagesEl.querySelectorAll('.msg-row').forEach(el => el.classList.add('selecting'));
  updateSelCount();
}
function exitSelectMode() {
  s.selecting = false;
  s.selectedMsgs.clear();
  s.dragSelecting = false;
  selectionBar.classList.add('hidden');
  messagesEl.querySelectorAll('.msg-row').forEach(el => {
    el.classList.remove('selecting', 'selected-row');
    const cb = el.querySelector('.msg-row-checkbox');
    if (cb) cb.checked = false;
  });
}
function toggleSelect(msgId, row) {
  if (s.selectedMsgs.has(msgId)) {
    s.selectedMsgs.delete(msgId);
    row.classList.remove('selected-row');
    row.querySelector('.msg-row-checkbox').checked = false;
  } else {
    s.selectedMsgs.add(msgId);
    row.classList.add('selected-row');
    row.querySelector('.msg-row-checkbox').checked = true;
  }
  updateSelCount();
}
function updateSelCount() {
  selCount.textContent = `${s.selectedMsgs.size} selected`;
}

// send
async function sendMessage() {
  const text = msgInput.value.trim();
  const hasFiles = s.pendingFiles.length > 0;

  if (!text && !hasFiles) return;
  if (!s.currentUserId) return;

  // If we have files, send them (with caption = text)
  if (hasFiles) {
    for (const file of s.pendingFiles) {
      await sendFile(file, text);
    }
    s.pendingFiles = [];
    filePreviewBar.classList.add('hidden');
    filePreviewList.innerHTML = '';
    msgInput.value = '';
    autoResize();
    clearReply();
    return;
  }

  // text only
  msgInput.value = '';
  autoResize();
  await api('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: s.currentUserId,
      text,
      reply_to: s.replyTo,
    }),
  });
  clearReply();
}

async function sendFile(file, caption = '') {
  if (!s.currentUserId) return;
  const fd = new FormData();
  fd.append('user_id', s.currentUserId);
  fd.append('reply_to', s.replyTo || '');
  fd.append('caption', caption);
  fd.append('file', file);
  await api('/api/upload', { method: 'POST', body: fd });
  clearReply();
}

// file preview
function addPendingFiles(files) {
  for (const f of files) {
    s.pendingFiles.push(f);
  }
  renderFilePreview();
}

function renderFilePreview() {
  filePreviewList.innerHTML = '';
  if (s.pendingFiles.length === 0) {
    filePreviewBar.classList.add('hidden');
    return;
  }
  filePreviewBar.classList.remove('hidden');
  s.pendingFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-preview-item';
    if (f.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      item.appendChild(img);
    }
    const name = document.createElement('span');
    name.textContent = f.name;
    item.appendChild(name);
    filePreviewList.appendChild(item);
  });
}

// reply
function setReply(msgId, text) {
  s.replyTo = msgId;
  replyText.textContent = text.slice(0, 80) || '📎 Media';
  replyBar.classList.remove('hidden');
  msgInput.focus();
}
function clearReply() {
  s.replyTo = null;
  replyBar.classList.add('hidden');
}

// delete / copy / forward
async function deleteSelected() {
  if (!s.selectedMsgs.size) return;

  const choice = await openCustomDialog('Delete Messages', `Are you sure you want to delete ${s.selectedMsgs.size} message(s)?`, [
    { text: 'Cancel', value: 'cancel' },
    { text: 'Delete for Me', value: 'me', danger: true },
    { text: 'Delete for Everyone', value: 'everyone', danger: true }
  ]);

  if (!choice || choice === 'cancel') return;
  const forEveryone = choice === 'everyone';

  try {
    await api('/api/messages', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: s.currentUserId, msg_ids: [...s.selectedMsgs], for_everyone: forEveryone }),
    });
    exitSelectMode();
  } catch (e) { }
}

function copySelected() {
  const texts = [];
  s.selectedMsgs.forEach(id => {
    const el = document.querySelector(`.msg-row[data-id="${id}"] .msg-text`);
    if (el) texts.push(el.textContent);
  });
  if (texts.length) {
    navigator.clipboard.writeText(texts.join('\n\n'));
    toast('Copied to clipboard');
  }
  exitSelectMode();
}

function openForwardModal() {
  s.forwardTargets.clear();
  forwardList.innerHTML = '';
  s.users.forEach(u => {
    if (u.user_id === s.currentUserId) return;
    const div = document.createElement('div');
    div.className = 'fwd-user';
    div.innerHTML = `
      <div class="fwd-avatar" style="background:${avatarColor(u.user_id)}">${avatarHtml(u.user_id, u.full_name)}</div>
      <span class="fwd-name">${esc(u.full_name)}</span>`;
    div.onclick = () => {
      if (s.forwardTargets.has(u.user_id)) {
        s.forwardTargets.delete(u.user_id);
        div.classList.remove('chosen');
      } else {
        s.forwardTargets.add(u.user_id);
        div.classList.add('chosen');
      }
    };
    forwardList.appendChild(div);
  });
  forwardModal.classList.remove('hidden');
}

async function confirmForward() {
  if (!s.forwardTargets.size || !s.selectedMsgs.size) return;
  await api('/api/forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_user_id: s.currentUserId,
      to_user_ids: [...s.forwardTargets],
      msg_ids: [...s.selectedMsgs],
    }),
  });
  forwardModal.classList.add('hidden');
  exitSelectMode();
  toast('Messages forwarded');
}

// unread
async function clearUnread(uid) {
  await api('/api/clear-unread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: uid }),
  });
  refreshUsers();
}

// media viewer
function openMedia(url, type) {
  mediaContent.innerHTML = type === 'image'
    ? `<img src="${url}" alt=""/>`
    : `<video src="${url}" controls autoplay></video>`;
  mediaViewer.classList.remove('hidden');
}

// emoji picker
const emojis = {
  '⭐': frequent_emojis,
  '😀': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖'],
  '👋': ['👋', '🤚', '🖐', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁', '👅', '👄', '🫦', '💋'],
  '❤️': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '🔥', '⭐', '🌟', '✨', '⚡', '💫', '💥', '💢', '💦', '💨', '🕳', '💣', '💬', '💭', '🏳️‍🌈', '🏴‍☠️'],
  '🐶': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪲', '🪳', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫'],
  '🍎': ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🫛', '🥦', '🥬', '🥒', '🌶', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🫘', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥗', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🎂', '🍰', '🧁', '🥧', '🍫', '🍬', '🍭', '🍮', '🍯', '🍼', '🥛', '☕', '🫖', '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂', '🥃'],
  '⚽': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸', '🥌', '🎿', '⛷', '🏂', '🪂', '🏋️', '🤸', '🤺', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖', '🏵', '🎗', '🎫', '🎟', '🎪'],
  '🚗': ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🛵', '🏍', '🛺', '🚲', '🛴', '🚏', '🛣', '🛤', '⛽', '🚨', '🚥', '🚦', '🛑', '🚧', '⚓', '⛵', '🛶', '🚤', '🛳', '⛴', '🛥', '🚢', '✈️', '🛩', '🛫', '🛬', '🪂', '💺', '🚁', '🚟', '🚠', '🚡', '🛰', '🚀', '🛸', '🌍', '🌎', '🌏', '🗺', '🧭', '🏔', '⛰', '🌋', '🗻', '🏕', '🏖', '🏜', '🏝', '🏞'],
};
const emoji_tabs = Object.keys(emojis);
let currentEmojiTab = emoji_tabs[0]; // ⭐ frequent first

function initEmojiPicker() {
  emoji_tabs.forEach(tab => {
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
    ? Object.values(emojis).flat().filter(e => e.includes(q))
    : emojis[currentEmojiTab] || [];
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

function openEmojiPicker() {
  if (s.emojiOpen) return;
  s.emojiOpen = true;
  emojiPicker.classList.remove('hidden');
}

function closeEmojiPicker() {
  if (!s.emojiOpen) return;
  s.emojiOpen = false;
  emojiPicker.classList.add('hidden');
}

// auto‑resize textarea
function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
}

// toast
function toast(msg, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// util
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function openCustomDialog(title, text, buttons) {
  return new Promise(resolve => {
    const modal = document.getElementById('customDialogModal');
    document.getElementById('customDialogTitle').textContent = title;
    document.getElementById('customDialogBody').textContent = text;
    const footer = document.getElementById('customDialogFooter');
    footer.innerHTML = '';

    const closeIt = () => modal.classList.add('hidden');
    document.getElementById('customDialogClose').onclick = () => { closeIt(); resolve(null); };

    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.text;
      if (b.primary) {
        btn.className = 'btn-primary';
        if (b.danger) {
          btn.style.background = 'var(--danger)';
          btn.style.borderColor = 'var(--danger)';
        }
      } else {
        btn.style.background = b.danger ? 'var(--danger)' : 'var(--bg-hover)';
        btn.style.color = b.danger ? '#fff' : 'var(--text)';
        btn.style.border = 'none';
        btn.style.padding = '8px 16px';
        btn.style.borderRadius = 'var(--radius-sm)';
        btn.style.cursor = 'pointer';
      }
      btn.onclick = () => { closeIt(); resolve(b.value); };
      footer.appendChild(btn);
    });
    modal.classList.remove('hidden');
  });
}

function customConfirm(text, title = 'Confirm') {
  return openCustomDialog(title, text, [
    { text: 'Cancel', value: false },
    { text: 'OK', value: true, primary: true }
  ]);
}

function customAlert(text, title = 'Notice') {
  return openCustomDialog(title, text, [
    { text: 'OK', value: true, primary: true }
  ]);
}

// fetch bot name & set branding
async function fetchBotInfo() {
  try {
    const info = await api('/api/bot-info');
    const name = info.name || info.username || 'Chat';
    $('logoText').textContent = name;
    $('pageTitle').textContent = `${name} Chat`;
  } catch (e) { /* ignore */ }
}

// sidebar resize
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

  // touch support
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

// event wiring
function init() {
  connectWS();
  fetchBotInfo();
  refreshUsers();
  initEmojiPicker();
  initSidebarResize();

  // send
  sendBtn.onclick = sendMessage;
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener('input', autoResize);

  // attach
  attachBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    addPendingFiles([...fileInput.files]);
    fileInput.value = '';
    msgInput.focus();
  };

  // clear pending files
  fileClearBtn.onclick = () => {
    s.pendingFiles = [];
    filePreviewBar.classList.add('hidden');
    filePreviewList.innerHTML = '';
  };

  // paste images into textbox
  msgInput.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addPendingFiles(imageFiles);
    }
  });

  // drag-drop files onto input area
  inputFieldWrap.addEventListener('dragover', e => {
    e.preventDefault();
    inputFieldWrap.classList.add('drag-over');
  });
  inputFieldWrap.addEventListener('dragleave', () => {
    inputFieldWrap.classList.remove('drag-over');
  });
  inputFieldWrap.addEventListener('drop', e => {
    e.preventDefault();
    inputFieldWrap.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) {
      addPendingFiles([...e.dataTransfer.files]);
    }
  });

  // emoji: hover open/close
  let emojiHoverTimeout = null;

  function enterEmojiZone() {
    clearTimeout(emojiHoverTimeout);
    openEmojiPicker();
  }
  function leaveEmojiZone() {
    clearTimeout(emojiHoverTimeout);
    emojiHoverTimeout = setTimeout(() => {
      closeEmojiPicker();
    }, 250);
  }

  emojiBtnWrap.addEventListener('mouseenter', enterEmojiZone);
  emojiBtnWrap.addEventListener('mouseleave', leaveEmojiZone);
  emojiPicker.addEventListener('mouseenter', enterEmojiZone);
  emojiPicker.addEventListener('mouseleave', leaveEmojiZone);

  // also open on click for mobile
  emojiBtn.onclick = () => {
    if (s.emojiOpen) closeEmojiPicker();
    else openEmojiPicker();
  };

  // reply
  replyClose.onclick = clearReply;

  // selection
  $('selectModeBtn').onclick = () => s.selecting ? exitSelectMode() : enterSelectMode();
  $('selCancel').onclick = exitSelectMode;
  $('selDelete').onclick = deleteSelected;
  $('selCopy').onclick = copySelected;
  $('selForward').onclick = openForwardModal;

  // forward modal
  $('forwardClose').onclick = () => forwardModal.classList.add('hidden');
  $('forwardConfirm').onclick = confirmForward;

  // edit modals
  $('editHistoryClose').onclick = () => editHistoryModal.classList.add('hidden');
  $('editModalClose').onclick = () => editModal.classList.add('hidden');

  // group info
  groupInfoBtn.onclick = async () => {
    groupInfoBody.innerHTML = 'Loading group data...';
    groupInfoModal.classList.remove('hidden');
    try {
      const data = await api(`/api/group-info/${s.currentUserId}`);
      let html = `<p><strong>Total Members:</strong> ${data.member_count > 0 ? data.member_count : 'Unknown'}</p>`;

      html += `<h4>Known Active Members</h4>`;
      if (data.active_members && data.active_members.length) {
        if (!s.groupMembers[s.currentUserId]) s.groupMembers[s.currentUserId] = {};
        html += `<ul style="list-style:none; padding:0; margin: 8px 0;">`;
        data.active_members.forEach(m => {
          s.groupMembers[s.currentUserId][m.id] = m.name;
          const uColor = avatarColor(m.id);
          const avDom = `<div class="chat-avatar" style="background:${uColor}; flex-shrink:0;">${avatarHtml(m.id, m.name)}</div>`;
          html += `<li style="padding: 4px; display:flex; align-items:center; gap:10px;">${avDom} <span style="font-weight:500;">${esc(m.name)}</span></li>`;
        });
        html += `</ul>`;
      } else {
        html += `<p>No recent actively speaking members recorded.</p>`;
      }

      groupInfoBody.innerHTML = html;
    } catch (e) {
      groupInfoBody.innerHTML = `<p style="color:var(--danger);">Failed to load group data.</p>`;
    }
  };

  // chat settings (block/leave)
  const chatSettingsBtn = $('chatSettingsBtn');
  if (chatSettingsBtn) {
    chatSettingsBtn.onclick = (e) => {
      e.stopPropagation();
      const rect = chatSettingsBtn.getBoundingClientRect();
      const u = s.users.find(x => String(x.user_id) === String(s.currentUserId));
      if (!u) return;
      const isGrp = (u.type === 'group' || u.type === 'supergroup');

      const items = [];
      if (isGrp) {
        items.push({
          label: '🚫 Leave Group', textCls: 'danger', action: async () => {
            if (!(await customConfirm('Leave this group permanently?'))) return;
            await api('/api/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: s.currentUserId }) });
            refreshUsers();
          }
        });
      } else {
        if (u.is_banned) {
          items.push({
            label: '✅ Unblock User', action: async () => {
              await api('/api/unblock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: s.currentUserId }) });
              refreshUsers();
            }
          });
        } else {
          items.push({
            label: '⛔ Block User', textCls: 'danger', action: async () => {
              if (!(await customConfirm('Block this user? You will not receive their messages.'))) return;
              await api('/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: s.currentUserId }) });
              refreshUsers();
            }
          });
        }
      }

      closeContextMenu(); // clear old
      const body = document.getElementById('chatSettingsBody');
      body.innerHTML = '';
      items.forEach(it => {
        const btn = document.createElement('button');
        btn.textContent = it.label;
        btn.className = 'btn-primary';
        if (it.textCls) {
          btn.style.background = `var(--${it.textCls})`;
          btn.style.borderColor = `var(--${it.textCls})`;
          btn.style.color = '#fff';
        }
        btn.onclick = (ev) => {
          ev.stopPropagation();
          document.getElementById('chatSettingsModal').classList.add('hidden');
          it.action();
        };
        body.appendChild(btn);
      });
      document.getElementById('chatSettingsModal').classList.remove('hidden');
    };
  }

  // media viewer
  $('mediaClose').onclick = () => mediaViewer.classList.add('hidden');
  mediaViewer.onclick = e => { if (e.target === mediaViewer) mediaViewer.classList.add('hidden'); };

  // load older
  loadMoreBtn.onclick = () => loadMessages(true);

  // scroll detection for load more
  messagesWrap.addEventListener('scroll', () => {
    if (messagesWrap.scrollTop < 60 && s.hasMore && !s.loading) {
      loadMessages(true);
    }
  });

  // search
  searchInput.oninput = () => renderUserList(s.users);

  // back (mobile)
  backBtn.onclick = () => {
    sidebar.classList.remove('collapsed');
    activeChat.classList.add('hidden');
    noChat.classList.remove('hidden');
    s.currentUserId = null;
  };

  // close context menu on click outside
  document.addEventListener('click', e => {
    if (s.contextMenuEl && !s.contextMenuEl.contains(e.target)) {
      closeContextMenu();
    }
  });

  // end drag-select on mouseup
  document.addEventListener('mouseup', () => {
    s.dragSelecting = false;
  });

  // Focus fix: re-focus input when clicking in chat area (not on interactive elements)
  document.addEventListener('mousedown', e => {
    // Don't interfere if clicking on interactive controls
    if (e.target.closest('.sidebar') ||
      e.target.closest('.emoji-picker') ||
      e.target.closest('.modal-overlay') ||
      e.target.closest('.media-viewer') ||
      e.target.closest('.msg-context-menu') ||
      e.target.closest('.msg-hover-actions') ||
      e.target.closest('button') ||
      e.target.closest('a') ||
      e.target.closest('input') ||
      e.target.closest('textarea') ||
      e.target.closest('video') ||
      e.target.closest('audio') ||
      e.target.closest('.file-preview-bar')) {
      return;
    }
    // Re-focus input after a tick
    setTimeout(() => {
      if (s.currentUserId && document.activeElement !== msgInput) {
        msgInput.focus();
      }
    }, 0);
  });

  // keyboard shortcut: Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (s.contextMenuEl) { closeContextMenu(); return; }
      if (s.emojiOpen) { closeEmojiPicker(); return; }
      if (!editModal.classList.contains('hidden')) { editModal.classList.add('hidden'); return; }
      if (!editHistoryModal.classList.contains('hidden')) { editHistoryModal.classList.add('hidden'); return; }
      if (!forwardModal.classList.contains('hidden')) { forwardModal.classList.add('hidden'); return; }
      if (!mediaViewer.classList.contains('hidden')) { mediaViewer.classList.add('hidden'); return; }
      if (s.selecting) exitSelectMode();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
