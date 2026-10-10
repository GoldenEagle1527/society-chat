/* society-chat Telegram-style observe / live UI — no secrets in client */
(() => {
  'use strict';

  const el = {
    chatList: document.getElementById('chatList'),
    chatSearch: document.getElementById('chatSearch'),
    modePill: document.getElementById('modePill'),
    liveNote: document.getElementById('liveNote'),
    llmTotal: document.getElementById('llmTotal'),
    stamp: document.getElementById('stamp'),
    emptyState: document.getElementById('emptyState'),
    chatPane: document.getElementById('chatPane'),
    messages: document.getElementById('messages'),
    headerAvatar: document.getElementById('headerAvatar'),
    headerAvatarBtn: document.getElementById('headerAvatarBtn'),
    headerMetaBtn: document.getElementById('headerMetaBtn'),
    headerTitle: document.getElementById('headerTitle'),
    headerSub: document.getElementById('headerSub'),
    chatKindPill: document.getElementById('chatKindPill'),
    sayText: document.getElementById('sayText'),
    sayBtn: document.getElementById('sayBtn'),
    sayStatus: document.getElementById('sayStatus'),
    composer: document.getElementById('composer'),
    profileModal: document.getElementById('profileModal'),
    profileBackdrop: document.getElementById('profileBackdrop'),
    profileClose: document.getElementById('profileClose'),
    profileAvatar: document.getElementById('profileAvatar'),
    profileName: document.getElementById('profileName'),
    profileId: document.getElementById('profileId'),
    profileBody: document.getElementById('profileBody'),
    sidebar: document.getElementById('sidebar'),
    main: document.getElementById('main'),
    backBtn: document.getElementById('backBtn'),
  };

  /** @type {any} */
  let state = null;
  let selectedChatId = localStorage.getItem('society.selectedChat') || '';
  let searchQ = '';
  let sending = false;
  let stickBottom = true;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }

  function fmtClock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function dayKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const yday = new Date();
    yday.setDate(today.getDate() - 1);
    if (dayKey(iso) === dayKey(today.toISOString())) return '今天';
    if (dayKey(iso) === dayKey(yday.toISOString())) return '昨天';
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function agentById(id) {
    return (state?.agents || []).find((a) => a.id === id) || null;
  }

  function chatById(id) {
    return (state?.chats || []).find((c) => c.id === id) || null;
  }

  function kindLabel(kind) {
    if (kind === 'group') return '群聊';
    if (kind === 'dm') return '私信';
    if (kind === 'self') return '个人';
    return kind || '';
  }

  function previewText(chat) {
    const lm = chat.lastMessage;
    if (!lm) return '暂无消息';
    const who =
      lm.from === 'human'
        ? '你'
        : lm.from === 'system'
          ? ''
          : lm.fromName || lm.from;
    const body = String(lm.body || '').replace(/\s+/g, ' ').trim();
    return who ? `${who}: ${body}` : body;
  }

  function filteredChats() {
    const chats = state?.chats || [];
    const q = searchQ.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.subtitle || '').toLowerCase().includes(q) ||
        (c.members || []).some((m) => String(m).toLowerCase().includes(q)),
    );
  }

  function groupChats(chats) {
    const groups = { group: [], dm: [], self: [] };
    for (const c of chats) {
      (groups[c.kind] || groups.group).push(c);
    }
    return [
      { key: 'group', label: '群聊', items: groups.group },
      { key: 'dm', label: '私信', items: groups.dm },
      { key: 'self', label: '个人空间', items: groups.self },
    ].filter((g) => g.items.length);
  }

  function renderChatList() {
    const sections = groupChats(filteredChats());
    if (!sections.length) {
      el.chatList.innerHTML = `<div class="tg-section-label">暂无会话</div>
        <div class="tg-muted" style="padding:8px 16px">先跑 society-live / smoke 产生房间与 Agent</div>`;
      return;
    }
    el.chatList.innerHTML = sections
      .map((sec) => {
        const items = sec.items
          .map((c) => {
            const active = c.id === selectedChatId ? ' active' : '';
            const groupClass = c.kind === 'group' ? ' group' : '';
            return `<button type="button" class="tg-chat-item${active}" data-chat-id="${esc(c.id)}">
              <span class="tg-avatar${groupClass}" style="background:${esc(c.avatarColor)}">${esc(c.initials)}</span>
              <div class="tg-chat-main">
                <div class="tg-chat-top">
                  <div class="tg-chat-title">${esc(c.title)}</div>
                  <div class="tg-chat-time">${esc(fmtTime(c.lastMessage?.createdAt))}</div>
                </div>
                <div class="tg-chat-preview">${esc(previewText(c))}</div>
              </div>
              <div>${c.messageCount ? '' : ''}</div>
            </button>`;
          })
          .join('');
        return `<div class="tg-section-label">${esc(sec.label)}</div>${items}`;
      })
      .join('');

    el.chatList.querySelectorAll('[data-chat-id]').forEach((btn) => {
      btn.addEventListener('click', () => selectChat(btn.getAttribute('data-chat-id')));
    });
  }

  function messagesForChat(chatId) {
    return (state?.messages || [])
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function isOutgoing(from) {
    return from === 'human';
  }

  function isSystemish(m) {
    return m.kind === 'soul' || m.kind === 'tool' || m.kind === 'system' || m.from === 'system';
  }

  function bubbleNameColor(from) {
    const a = agentById(from);
    return a?.avatarColor || '#64a9dc';
  }

  function renderMessages() {
    const chat = chatById(selectedChatId);
    if (!chat) {
      el.emptyState.classList.remove('hidden');
      el.chatPane.classList.add('hidden');
      return;
    }
    el.emptyState.classList.add('hidden');
    el.chatPane.classList.remove('hidden');

    el.headerAvatar.textContent = chat.initials;
    el.headerAvatar.style.background = chat.avatarColor;
    el.headerAvatar.className = 'tg-avatar sm' + (chat.kind === 'group' ? ' group' : '');
    el.headerTitle.textContent = chat.title;
    el.headerSub.textContent = chat.subtitle || kindLabel(chat.kind);
    el.chatKindPill.textContent = kindLabel(chat.kind);

    const canSay = !!state?.canSay;
    el.sayText.disabled = !canSay;
    el.sayBtn.disabled = !canSay || sending;
    el.sayText.placeholder = canSay
      ? chat.kind === 'self'
        ? '给个人空间留一句（会唤醒该 Agent）…'
        : chat.kind === 'dm'
          ? '发私信…'
          : '写入群聊…'
      : '只读旁观（society-live 可插话）';

    const msgs = messagesForChat(selectedChatId);
    const showNames = chat.kind === 'group' || chat.kind === 'dm';
    let html = '';
    let lastDay = '';
    for (const m of msgs) {
      const dk = dayKey(m.createdAt);
      if (dk && dk !== lastDay) {
        lastDay = dk;
        html += `<div class="tg-day">${esc(dayLabel(m.createdAt))}</div>`;
      }
      if (isSystemish(m) && chat.kind === 'self') {
        html += `<div class="tg-row system">
          <div class="tg-msg-wrap">
            <div class="tg-bubble">${esc(m.body)}
              <div class="meta"><span class="tg-kind-tag">${esc(m.kind || 'system')}</span></div>
            </div>
            <time class="tg-msg-time" datetime="${esc(m.createdAt || '')}">${esc(fmtClock(m.createdAt))}</time>
          </div>
        </div>`;
        continue;
      }
      const out = isOutgoing(m.from);
      const rowClass = out ? 'out' : 'in';
      const nameHtml =
        !out && showNames
          ? `<span class="name" style="color:${esc(bubbleNameColor(m.from))}">${esc(m.fromName || m.from)}</span>`
          : '';
      const avatarHtml =
        !out && chat.kind === 'group'
          ? `<span class="tg-avatar sm" style="background:${esc(bubbleNameColor(m.from))}" data-agent="${esc(m.from)}">${esc(
              (agentById(m.from)?.initials) || String(m.fromName || m.from).slice(0, 2).toUpperCase(),
            )}</span>`
          : '';
      html += `<div class="tg-row ${rowClass}">${avatarHtml}<div class="tg-msg-wrap">
        <div class="tg-bubble">${nameHtml}${esc(m.body)}</div>
        <time class="tg-msg-time" datetime="${esc(m.createdAt || '')}">${esc(fmtClock(m.createdAt))}</time>
      </div></div>`;
    }
    if (!msgs.length) {
      html = `<div class="tg-day">还没有消息</div>`;
    }

    const prevStick = stickBottom;
    const nearBottom =
      el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
    el.messages.innerHTML = html;
    if (prevStick || nearBottom) {
      el.messages.scrollTop = el.messages.scrollHeight;
      stickBottom = true;
    }

    el.messages.querySelectorAll('[data-agent]').forEach((node) => {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        openProfile(node.getAttribute('data-agent'));
      });
    });
  }

  function selectChat(chatId) {
    selectedChatId = chatId || '';
    if (selectedChatId) localStorage.setItem('society.selectedChat', selectedChatId);
    else localStorage.removeItem('society.selectedChat');
    stickBottom = true;
    renderChatList();
    renderMessages();
    // mobile: hide sidebar when chat open
    if (window.matchMedia('(max-width: 900px)').matches && selectedChatId) {
      el.sidebar.classList.add('collapsed');
      el.main.classList.add('with-chat');
    }
  }

  function profileTargetFromChat(chat) {
    if (!chat) return null;
    if (chat.kind === 'self') return chat.agentId;
    if (chat.kind === 'group') {
      // open first non-system member profile if only one interesting? Prefer none — show room info
      return null;
    }
    if (chat.kind === 'dm') {
      const peers = chat.peerIds || [];
      return peers.find((p) => p !== 'human') || peers[0] || null;
    }
    return null;
  }

  function openProfile(agentId) {
    const a = agentById(agentId);
    if (!a) {
      // room / missing — show lightweight card from chat
      const chat = chatById(selectedChatId);
      if (!chat) return;
      el.profileAvatar.textContent = chat.initials;
      el.profileAvatar.style.background = chat.avatarColor;
      el.profileName.textContent = chat.title;
      el.profileId.textContent = chat.id;
      el.profileBody.innerHTML = `
        <div class="tg-profile-card">
          <h3>会话</h3>
          <div class="tg-profile-row"><span>类型</span><span>${esc(kindLabel(chat.kind))}</span></div>
          <div class="tg-profile-row"><span>成员</span><span>${esc((chat.members || chat.peerIds || []).join(', ') || '—')}</span></div>
          <div class="tg-profile-row"><span>消息</span><span>${esc(chat.messageCount)}</span></div>
        </div>`;
      el.profileModal.classList.remove('hidden');
      el.profileModal.setAttribute('aria-hidden', 'false');
      return;
    }

    const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
    const bar = (label, v) => {
      const p = pct(v);
      return `<div class="tg-bar-row"><span>${esc(label)}</span><div class="tg-bar-track"><div class="tg-bar-fill" style="width:${p}%"></div></div><span>${p}%</span></div>`;
    };

    el.profileAvatar.textContent = a.initials;
    el.profileAvatar.style.background = a.avatarColor;
    el.profileName.textContent = a.displayName;
    el.profileId.textContent = `@${a.id}`;
    el.profileBody.innerHTML = `
      <div class="tg-profile-card">
        <h3>人设</h3>
        <p class="tg-persona">${esc(a.persona || '—')}</p>
      </div>
      <div class="tg-profile-card">
        <h3>灵魂状态</h3>
        <div class="tg-profile-row"><span>心情</span><span>${esc(a.mood)}</span></div>
        <div class="tg-bars" style="margin-top:8px">
          ${bar('开放', a.openness)}
          ${bar('信任', a.trust)}
          ${bar('精力', a.energy)}
        </div>
      </div>
      <div class="tg-profile-card">
        <h3>兴趣</h3>
        <div class="tg-tags">${
          (a.interests || []).length
            ? a.interests.map((t) => `<span class="tg-tag">${esc(t)}</span>`).join('')
            : '<span class="tg-muted">暂无</span>'
        }</div>
      </div>
      <div class="tg-profile-card">
        <h3>模型路由</h3>
        <div class="tg-profile-row"><span>通道</span><span>${esc(a.llmProvider || '—')}</span></div>
        <div class="tg-profile-row"><span>模型</span><span>${esc(a.llmModel || '—')}</span></div>
        <div class="tg-profile-row"><span>今日调用</span><span>${esc(a.llmCallsToday)}</span></div>
      </div>
      <div class="tg-profile-card">
        <h3>更新</h3>
        <div class="tg-profile-row"><span>灵魂</span><span>${esc(a.soulUpdatedAt || '—')}</span></div>
        <div class="tg-profile-row"><span>记忆</span><span>${esc(a.memoryUpdatedAt || '—')}</span></div>
      </div>`;
    el.profileModal.classList.remove('hidden');
    el.profileModal.setAttribute('aria-hidden', 'false');
  }

  function closeProfile() {
    el.profileModal.classList.add('hidden');
    el.profileModal.setAttribute('aria-hidden', 'true');
  }

  function openHeaderProfile() {
    const chat = chatById(selectedChatId);
    if (!chat) return;
    const aid = profileTargetFromChat(chat);
    openProfile(aid);
  }

  async function sendSay() {
    if (!state?.canSay || sending) return;
    const text = (el.sayText.value || '').trim();
    if (!text) {
      el.sayStatus.textContent = '请先输入内容';
      return;
    }
    if (!selectedChatId) {
      el.sayStatus.textContent = '请先选择会话';
      return;
    }
    sending = true;
    el.sayBtn.disabled = true;
    el.sayStatus.textContent = '发送中…';
    try {
      const res = await fetch('/api/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: selectedChatId, text, as: 'human' }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.sayStatus.textContent = '失败：' + (data.error || res.status);
        return;
      }
      el.sayText.value = '';
      autoSize();
      el.sayStatus.textContent =
        data.kind === 'dm'
          ? '私信已送达，等待心跳回复…'
          : data.kind === 'self'
            ? '已写入个人空间留言，等待唤醒…'
            : '已发送到群聊，等待 Agent 心跳回复…';
      stickBottom = true;
      await tick();
    } catch (e) {
      el.sayStatus.textContent = '失败：' + e;
    } finally {
      sending = false;
      el.sayBtn.disabled = !state?.canSay;
    }
  }

  function autoSize() {
    const ta = el.sayText;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  }

  async function tick() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      state = data;
      el.modePill.textContent = data.canSay ? '直播' : '旁观';
      el.modePill.className = 'tg-pill' + (data.canSay ? ' live' : '');
      el.liveNote.textContent = data.note || '';
      el.llmTotal.textContent = String(data.llmTotals?.today ?? 0);
      el.stamp.textContent = data.generatedAt
        ? '更新 ' + new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : '—';

      if (selectedChatId && !chatById(selectedChatId)) {
        selectedChatId = data.chats?.[0]?.id || '';
      }
      if (!selectedChatId && data.chats?.length) {
        // prefer plaza group
        const plaza = data.chats.find((c) => c.kind === 'group' && /plaza/i.test(c.title));
        selectedChatId = plaza?.id || data.chats[0].id;
        localStorage.setItem('society.selectedChat', selectedChatId);
      }

      renderChatList();
      renderMessages();
    } catch (e) {
      el.liveNote.textContent = '拉取失败：' + e;
    }
  }

  // events
  el.chatSearch.addEventListener('input', () => {
    searchQ = el.chatSearch.value || '';
    renderChatList();
  });
  el.sayBtn.addEventListener('click', sendSay);
  el.sayText.addEventListener('input', autoSize);
  el.sayText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendSay();
    }
  });
  el.messages.addEventListener('scroll', () => {
    stickBottom =
      el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
  });
  el.headerAvatarBtn.addEventListener('click', openHeaderProfile);
  el.headerMetaBtn.addEventListener('click', openHeaderProfile);
  el.headerMetaBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openHeaderProfile();
    }
  });
  el.profileClose.addEventListener('click', closeProfile);
  el.profileBackdrop.addEventListener('click', closeProfile);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProfile();
  });
  el.backBtn.addEventListener('click', () => {
    el.sidebar.classList.remove('collapsed');
    el.main.classList.remove('with-chat');
  });

  tick();
  setInterval(tick, 1500);
})();
