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
    profileActions: document.getElementById('profileActions'),
    profileDmBtn: document.getElementById('profileDmBtn'),
    sidebar: document.getElementById('sidebar'),
    main: document.getElementById('main'),
    backBtn: document.getElementById('backBtn'),
    menuBtn: document.getElementById('menuBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    newMenu: document.getElementById('newMenu'),
    menuNewGroup: document.getElementById('menuNewGroup'),
    menuNewDm: document.getElementById('menuNewDm'),
    menuBirth: document.getElementById('menuBirth'),
    birthModal: document.getElementById('birthModal'),
    birthBackdrop: document.getElementById('birthBackdrop'),
    birthClose: document.getElementById('birthClose'),
    birthCancel: document.getElementById('birthCancel'),
    birthCreate: document.getElementById('birthCreate'),
    birthDisplayName: document.getElementById('birthDisplayName'),
    birthPersona: document.getElementById('birthPersona'),
    birthInterests: document.getElementById('birthInterests'),
    birthMood: document.getElementById('birthMood'),
    birthId: document.getElementById('birthId'),
    birthStatus: document.getElementById('birthStatus'),
    newGroupModal: document.getElementById('newGroupModal'),
    newGroupBackdrop: document.getElementById('newGroupBackdrop'),
    newGroupClose: document.getElementById('newGroupClose'),
    newGroupCancel: document.getElementById('newGroupCancel'),
    newGroupCreate: document.getElementById('newGroupCreate'),
    newGroupName: document.getElementById('newGroupName'),
    newGroupMembers: document.getElementById('newGroupMembers'),
    newGroupStatus: document.getElementById('newGroupStatus'),
    dmPickModal: document.getElementById('dmPickModal'),
    dmPickBackdrop: document.getElementById('dmPickBackdrop'),
    dmPickClose: document.getElementById('dmPickClose'),
    dmPickList: document.getElementById('dmPickList'),
    settingsDrawer: document.getElementById('settingsDrawer'),
    settingsBackdrop: document.getElementById('settingsBackdrop'),
    settingsClose: document.getElementById('settingsClose'),
    settingsBody: document.getElementById('settingsBody'),
  };

  /** @type {any} */
  let state = null;
  /** @type {any} */
  let settingsCache = null;
  let selectedChatId = localStorage.getItem('society.selectedChat') || '';
  let searchQ = '';
  let sending = false;
  let stickBottom = true;
  let profileAgentId = '';
  let creating = false;
  let birthing = false;

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


  const MOOD_ICONS = {
    友善: '😊',
    好奇: '🤔',
    警惕: '🤨',
    平静: '😌',
    开心: '😄',
    兴奋: '🤩',
    疲惫: '😮‍💨',
    焦虑: '😰',
    专注: '🧐',
    放松: '😎',
  };


  const STAT_ICONS = {
    openness: { icon: '🌐', label: '开放' },
    trust: { icon: '🤝', label: '信任' },
    energy: { icon: '⚡', label: '精力' },
  };

  function parseStatDeltas(raw) {
    const out = [];
    const re = /(openness|trust|energy)\s*([+-]\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = re.exec(String(raw || '')))) {
      const key = m[1].toLowerCase();
      const meta = STAT_ICONS[key];
      if (!meta) continue;
      const num = Number(m[2]);
      out.push({
        key,
        icon: meta.icon,
        label: meta.label,
        text: `${m[2]}`,
        up: num >= 0,
      });
    }
    return out;
  }

  function deltaPillsHtml(deltas) {
    if (!deltas || !deltas.length) return '';
    return deltas
      .map(
        (d) =>
          `<span class="tg-delta-pill ${d.up ? 'up' : 'down'}" title="${esc(d.key)}">${d.icon}<span class="tg-delta-lab">${esc(d.label)}</span><span class="tg-delta-val">${esc(d.text)}</span></span>`,
      )
      .join('');
  }

  const KIND_ICONS = {
    soul: '✨',
    tool: '🔧',
    diary: '📔',
    system: 'ℹ️',
    room: '👥',
    memory: '🧠',
  };

  function moodIcon(mood) {
    const m = String(mood || '').trim();
    if (!m) return '🙂';
    if (MOOD_ICONS[m]) return MOOD_ICONS[m];
    for (const [k, v] of Object.entries(MOOD_ICONS)) {
      if (m.includes(k)) return v;
    }
    return '🙂';
  }

  /** Parse system/soul/tool/diary bodies into a compact banner. */
  function parseSystemBanner(m) {
    const kind = String(m.kind || 'system');
    const raw = String(m.body || '').replace(/\s+/g, ' ').trim();
    let deltas = [];
    const moodMatch = raw.match(/心情\s*([^\s·]+)/);
    const mood = moodMatch ? moodMatch[1] : '';
    const hasRoom = /群聊|room:/.test(raw);
    const hasDm = /私信|dm-from:|dm:/.test(raw);
    const hasFile = /文件\s|\.md\b|\.txt\b|\.json\b|workspace|📄/.test(raw);
    const hasTool = kind === 'tool' || /🛠|工具/.test(raw);
    const hasDiary = kind === 'diary' || /日记|diary/.test(raw);
    const hasMemory = kind === 'memory' || /记忆|memory|压缩/.test(raw);
    const hasSoul = kind === 'soul' || /性格|灵魂|心情/.test(raw);

    let lead = KIND_ICONS.system;
    let kindGlyph = KIND_ICONS[kind] || KIND_ICONS.system;
    let label = raw.replace(/^[✦🛠📄📔]\s*/, '');

    if (hasSoul) {
      lead = mood ? moodIcon(mood) : KIND_ICONS.soul;
      kindGlyph = hasRoom ? KIND_ICONS.room : hasDm ? '💬' : KIND_ICONS.soul;
      const parts = [];
      if (mood) parts.push(`心情 ${mood}`);
      else parts.push('性格微调');
      if (hasRoom) parts.push('群聊');
      else if (hasDm) parts.push('私信');
      const statDeltas = parseStatDeltas(raw);
      deltas = statDeltas;
      if (!statDeltas.length) {
        const other = raw
          .replace(/^✦\s*/, '')
          .replace(/性格微调/g, '')
          .replace(/心情\s*[^\s·]+/g, '')
          .replace(/群聊|私信(?:·\S+)?|room:\S+|dm-from:\S+|原因[：:]\s*/g, '')
          .replace(/(?:openness|trust|energy)\s*[+-][\d.]+/gi, '')
          .replace(/^[·•\s]+|[·•\s]+$/g, '')
          .replace(/[·•]\s*[·•]/g, '·')
          .trim();
        if (other) parts.push(other.slice(0, 36));
      }
      label = parts.filter(Boolean).join(' · ');
    } else if (hasDiary) {
      lead = KIND_ICONS.diary;
      kindGlyph = KIND_ICONS.diary;
    } else if (hasFile) {
      lead = '📄';
      kindGlyph = KIND_ICONS.tool;
      label = label.replace(/^文件\s*/, '文件 ');
    } else if (hasTool) {
      lead = KIND_ICONS.tool;
      kindGlyph = KIND_ICONS.tool;
    } else if (hasMemory) {
      lead = KIND_ICONS.memory;
      kindGlyph = KIND_ICONS.memory;
    } else if (hasRoom) {
      lead = KIND_ICONS.room;
      kindGlyph = KIND_ICONS.room;
    }

    if (label.length > 96) label = label.slice(0, 95) + '…';
    if (!deltas.length) deltas = parseStatDeltas(raw);
    return { lead, kindGlyph, kind, label, deltas, title: String(m.body || '').trim() };
  }

  function renderSystemBanner(m) {
    const b = parseSystemBanner(m);
    return `<div class="tg-row system" title="${esc(b.title)}">
      <div class="tg-msg-wrap">
        <div class="tg-bubble tg-sys-banner">
          <span class="tg-sys-icon" aria-hidden="true">${b.lead}</span>
          <span class="tg-sys-text">${esc(b.label)}</span>
          <span class="tg-sys-deltas">${deltaPillsHtml(b.deltas || [])}</span>
          <span class="tg-sys-kind" title="${esc(b.kind)}" aria-label="${esc(b.kind)}">${b.kindGlyph}</span>
        </div>
        <time class="tg-msg-time" datetime="${esc(m.createdAt || '')}">${esc(fmtClock(m.createdAt))}</time>
      </div>
    </div>`;
  }


  function isSystemish(m) {
    return m.kind === 'soul' || m.kind === 'tool' || m.kind === 'diary' || m.kind === 'system' || m.from === 'system';
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
        html += renderSystemBanner(m);
        continue;
      }
      const out = isOutgoing(m.from);
      const rowClass = out ? 'out' : 'in';
      const agent = agentById(m.from);
      const modelLabel = (agent && agent.llmModel) || '';
      const modelTitle = agent?.llmProvider
        ? `${agent.llmProvider} · ${modelLabel || agent.llmProvider}`
        : modelLabel;
      const showNameRow = !out && (showNames || chat.kind === 'self' || !!modelLabel);
      const nameHtml = showNameRow
          ? `<div class="tg-name-row"><span class="name" style="color:${esc(bubbleNameColor(m.from))}">${esc(m.fromName || agent?.displayName || m.from)}</span>${
              modelLabel ? `<span class="tg-model-pill" title="${esc(modelTitle)}">${esc(modelLabel)}</span>` : ''
            }</div>`
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
    if (window.matchMedia('(max-width: 900px)').matches && selectedChatId) {
      el.sidebar.classList.add('collapsed');
      el.main.classList.add('with-chat');
    }
  }

  function profileTargetFromChat(chat) {
    if (!chat) return null;
    if (chat.kind === 'self') return chat.agentId;
    if (chat.kind === 'group') return null;
    if (chat.kind === 'dm') {
      const peers = chat.peerIds || [];
      return peers.find((p) => p !== 'human') || peers[0] || null;
    }
    return null;
  }

  function openProfile(agentId) {
    profileAgentId = '';
    const a = agentById(agentId);
    if (!a) {
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
      el.profileActions.classList.add('hidden');
      el.profileModal.classList.remove('hidden');
      el.profileModal.setAttribute('aria-hidden', 'false');
      return;
    }

    profileAgentId = a.id;
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
        <div class="tg-profile-row"><span>今日调用</span><span>${esc(a.llmCallsToday)}（仅统计）</span></div>
      </div>
      <div class="tg-profile-card">
        <h3>更新</h3>
        <div class="tg-profile-row"><span>灵魂</span><span>${esc(a.soulUpdatedAt || '—')}</span></div>
        <div class="tg-profile-row"><span>记忆</span><span>${esc(a.memoryUpdatedAt || '—')}</span></div>
      </div>`;
    if (state?.canSay) {
      el.profileActions.classList.remove('hidden');
    } else {
      el.profileActions.classList.add('hidden');
    }
    el.profileModal.classList.remove('hidden');
    el.profileModal.setAttribute('aria-hidden', 'false');
  }

  function closeProfile() {
    el.profileModal.classList.add('hidden');
    el.profileModal.setAttribute('aria-hidden', 'true');
    profileAgentId = '';
  }

  function openHeaderProfile() {
    const chat = chatById(selectedChatId);
    if (!chat) return;
    const aid = profileTargetFromChat(chat);
    openProfile(aid);
  }

  function closeNewMenu() {
    el.newMenu.classList.add('hidden');
    el.newMenu.setAttribute('aria-hidden', 'true');
  }

  function openNewMenu() {
    const btn = el.newChatBtn;
    const rect = btn.getBoundingClientRect();
    el.newMenu.style.top = Math.min(window.innerHeight - 120, rect.bottom + 6) + 'px';
    el.newMenu.style.left = Math.min(window.innerWidth - 220, Math.max(8, rect.right - 200)) + 'px';
    el.newMenu.classList.remove('hidden');
    el.newMenu.setAttribute('aria-hidden', 'false');
  }

  function fillAgentChecks(container, { checkbox }) {
    const agents = state?.agents || [];
    if (!agents.length) {
      container.innerHTML = `<div class="tg-muted" style="padding:10px">暂无 Agent</div>`;
      return;
    }
    container.innerHTML = agents
      .map((a) => {
        if (checkbox) {
          return `<label class="tg-check-item">
            <input type="checkbox" value="${esc(a.id)}" />
            <span class="tg-avatar sm" style="background:${esc(a.avatarColor)}">${esc(a.initials)}</span>
            <span class="meta"><span class="title">${esc(a.displayName)}</span>
            <span class="sub">@${esc(a.id)} · ${esc(a.llmProvider || '—')}</span></span>
          </label>`;
        }
        return `<button type="button" class="tg-check-item" data-dm-agent="${esc(a.id)}">
          <span class="tg-avatar sm" style="background:${esc(a.avatarColor)}">${esc(a.initials)}</span>
          <span class="meta"><span class="title">${esc(a.displayName)}</span>
          <span class="sub">@${esc(a.id)}</span></span>
        </button>`;
      })
      .join('');
  }

  function openNewGroupModal() {
    closeNewMenu();
    el.newGroupName.value = '';
    el.newGroupStatus.textContent = '';
    fillAgentChecks(el.newGroupMembers, { checkbox: true });
    el.newGroupModal.classList.remove('hidden');
    el.newGroupModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => el.newGroupName.focus(), 50);
  }

  function closeNewGroupModal() {
    el.newGroupModal.classList.add('hidden');
    el.newGroupModal.setAttribute('aria-hidden', 'true');
  }

  function openDmPickModal() {
    closeNewMenu();
    fillAgentChecks(el.dmPickList, { checkbox: false });
    el.dmPickList.querySelectorAll('[data-dm-agent]').forEach((btn) => {
      btn.addEventListener('click', () => startDm(btn.getAttribute('data-dm-agent')));
    });
    el.dmPickModal.classList.remove('hidden');
    el.dmPickModal.setAttribute('aria-hidden', 'false');
  }

  function closeDmPickModal() {
    el.dmPickModal.classList.add('hidden');
    el.dmPickModal.setAttribute('aria-hidden', 'true');
  }

  async function createGroup() {
    if (!state?.canSay || creating) return;
    const name = (el.newGroupName.value || '').trim();
    const memberIds = [...el.newGroupMembers.querySelectorAll('input[type=checkbox]:checked')].map(
      (n) => n.value,
    );
    if (!name) {
      el.newGroupStatus.textContent = '请填写群名称';
      return;
    }
    if (!memberIds.length) {
      el.newGroupStatus.textContent = '请至少选择一名成员';
      return;
    }
    creating = true;
    el.newGroupCreate.disabled = true;
    el.newGroupStatus.textContent = '创建中…';
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.newGroupStatus.textContent = '失败：' + (data.error || res.status);
        return;
      }
      closeNewGroupModal();
      await tick();
      if (data.chatId) selectChat(data.chatId);
      el.sayStatus.textContent = `已创建群聊「${data.roomName || name}」`;
    } catch (e) {
      el.newGroupStatus.textContent = '失败：' + e;
    } finally {
      creating = false;
      el.newGroupCreate.disabled = false;
    }
  }

  async function startDm(agentId) {
    if (!agentId) return;
    if (!state?.canSay) {
      el.sayStatus.textContent = '只读旁观无法发起私信（请用 society-live）';
      return;
    }
    closeProfile();
    closeDmPickModal();
    closeNewMenu();
    try {
      const res = await fetch('/api/dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.sayStatus.textContent = '私信失败：' + (data.error || res.status);
        return;
      }
      await tick();
      if (data.chatId) selectChat(data.chatId);
      el.sayStatus.textContent = data.created ? '已打开新私信' : '已打开已有私信';
    } catch (e) {
      el.sayStatus.textContent = '私信失败：' + e;
    }
  }


  function openBirthModal() {
    closeNewMenu();
    closeSettings();
    el.birthDisplayName.value = '';
    el.birthPersona.value = '';
    el.birthInterests.value = '';
    el.birthMood.value = '';
    el.birthId.value = '';
    const max = settingsCache?.maxAgents || state?.agents?.length || '—';
    const cur = state?.agents?.length ?? 0;
    el.birthStatus.textContent =
      `将自动均衡分配免费 LLM，并加入广场。当前 ${cur} / 上限 ${max}`;
    el.birthModal.classList.remove('hidden');
    el.birthModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => el.birthDisplayName.focus(), 50);
  }

  function closeBirthModal() {
    el.birthModal.classList.add('hidden');
    el.birthModal.setAttribute('aria-hidden', 'true');
  }

  async function birthAgent() {
    if (!state?.canSay || birthing) return;
    const displayName = (el.birthDisplayName.value || '').trim();
    const persona = (el.birthPersona.value || '').trim();
    const interests = (el.birthInterests.value || '').trim();
    const mood = (el.birthMood.value || '').trim();
    const id = (el.birthId.value || '').trim();
    if (!displayName) {
      el.birthStatus.textContent = '请填写显示名';
      return;
    }
    if (!persona) {
      el.birthStatus.textContent = '请填写人设';
      return;
    }
    birthing = true;
    el.birthCreate.disabled = true;
    el.birthStatus.textContent = '诞生中…';
    try {
      const payload = { displayName, persona };
      if (interests) payload.interests = interests;
      if (mood) payload.mood = mood;
      if (id) payload.id = id;
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        el.birthStatus.textContent = '失败：' + (data.error || res.status);
        return;
      }
      closeBirthModal();
      await tick();
      const selfId = data.chatIds?.self;
      if (selfId) selectChat(selfId);
      const route = data.llm
        ? `${data.llm.provider}${data.llm.model ? '/' + data.llm.model : ''}`
        : '—';
      el.sayStatus.textContent =
        `已诞生 ${data.agent?.displayName || displayName}（@${data.agent?.id || ''} · ${route}）`;
    } catch (e) {
      el.birthStatus.textContent = '失败：' + e;
    } finally {
      birthing = false;
      el.birthCreate.disabled = false;
    }
  }

  function renderSettings(s) {
    const providers = (s.providers || [])
      .map((p) => {
        const dot = p.configured ? 'on' : 'off';
        const right = p.configured
          ? `${esc(p.model || 'configured')}`
          : '未配置';
        return `<div class="tg-settings-row"><span><span class="tg-dot ${dot}"></span>${esc(p.id)}</span><span>${right}</span></div>`;
      })
      .join('');
    el.settingsBody.innerHTML = `
      <div class="tg-settings-card">
        <h3>运行上限</h3>
        <div class="tg-settings-row"><span>并行回复</span><span>${esc(s.maxParallelReplies)}</span></div>
        <div class="tg-settings-row"><span>最大 exchanges</span><span>${esc(s.maxExchanges)}</span></div>
        <div class="tg-settings-row"><span>每日 LLM 预算</span><span>无上限（免费模型）</span></div>
        <div class="tg-settings-row"><span>Agent 上限</span><span>${esc(s.maxAgents)}</span></div>
        <div class="tg-settings-row"><span>心跳间隔</span><span>${esc(s.tickMs)} ms</span></div>
      </div>
      <div class="tg-settings-card">
        <h3>免费通道（不含密钥）</h3>
        ${providers || '<p class="tg-muted">无</p>'}
      </div>
      <div class="tg-settings-card">
        <h3>安全</h3>
        <div class="tg-settings-row"><span>远程插话</span><span>${s.allowRemoteSay ? '允许' : '仅本机'}</span></div>
        <div class="tg-settings-row"><span>模式</span><span>${esc(s.mode || state?.mode || '—')}</span></div>
      </div>
      <div class="tg-settings-card">
        <h3>.env</h3>
        <p class="tg-settings-note">${esc(s.envNote || '')}</p>
      </div>
      ${
        state?.canSay
          ? `<div class="tg-settings-card">
        <h3>角色</h3>
        <p class="tg-muted" style="margin:0 0 8px;font-size:12px">当前 ${(state.agents || []).length} / ${esc(s.maxAgents)} · LLM 自动均衡</p>
        <div class="tg-settings-actions">
          <button type="button" class="tg-btn primary" id="settingsBirthBtn">诞生新角色</button>
        </div>
      </div>`
          : ''
      }`;
    const birthBtn = document.getElementById('settingsBirthBtn');
    if (birthBtn) birthBtn.addEventListener('click', openBirthModal);
  }

  async function openSettings() {
    closeNewMenu();
    el.settingsDrawer.classList.remove('hidden');
    el.settingsDrawer.setAttribute('aria-hidden', 'false');
    el.settingsBody.innerHTML = `<p class="tg-muted">加载中…</p>`;
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      settingsCache = data;
      // Never display raw key fields if somehow present
      if (data.apiKey || data.AGNES_API_KEY || data.GLM_API_KEY) {
        throw new Error('settings response contained secrets (blocked in UI)');
      }
      renderSettings(data);
    } catch (e) {
      el.settingsBody.innerHTML = `<p class="tg-muted">加载失败：${esc(e)}</p>`;
    }
  }

  function closeSettings() {
    el.settingsDrawer.classList.add('hidden');
    el.settingsDrawer.setAttribute('aria-hidden', 'true');
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
  el.profileDmBtn.addEventListener('click', () => {
    if (profileAgentId) startDm(profileAgentId);
  });

  el.menuBtn.addEventListener('click', openSettings);
  el.settingsClose.addEventListener('click', closeSettings);
  el.settingsBackdrop.addEventListener('click', closeSettings);

  el.newChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.newMenu.classList.contains('hidden')) openNewMenu();
    else closeNewMenu();
  });
  el.menuNewGroup.addEventListener('click', openNewGroupModal);
  el.menuNewDm.addEventListener('click', openDmPickModal);
  el.menuBirth.addEventListener('click', openBirthModal);
  document.addEventListener('click', (e) => {
    if (!el.newMenu.classList.contains('hidden')) {
      if (!el.newMenu.contains(e.target) && e.target !== el.newChatBtn) closeNewMenu();
    }
  });

  el.newGroupClose.addEventListener('click', closeNewGroupModal);
  el.newGroupCancel.addEventListener('click', closeNewGroupModal);
  el.newGroupBackdrop.addEventListener('click', closeNewGroupModal);
  el.newGroupCreate.addEventListener('click', createGroup);

  el.dmPickClose.addEventListener('click', closeDmPickModal);
  el.dmPickBackdrop.addEventListener('click', closeDmPickModal);

  el.birthClose.addEventListener('click', closeBirthModal);
  el.birthCancel.addEventListener('click', closeBirthModal);
  el.birthBackdrop.addEventListener('click', closeBirthModal);
  el.birthCreate.addEventListener('click', birthAgent);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeProfile();
      closeNewGroupModal();
      closeDmPickModal();
      closeBirthModal();
      closeNewMenu();
      closeSettings();
    }
  });
  el.backBtn.addEventListener('click', () => {
    el.sidebar.classList.remove('collapsed');
    el.main.classList.remove('with-chat');
  });

  tick();
  setInterval(tick, 1500);
})();
