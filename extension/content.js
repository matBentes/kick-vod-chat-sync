// Kick VOD Chat Sync
// O replay nativo da Kick avança o chat pelo relógio real, então em 1.5x/2x ele fica pra trás.
// Aqui buscamos as mensagens pela API da própria Kick e mostramos cada uma quando
// video.currentTime chega no instante dela — funciona com qualquer velocidade, pause e seek.
(() => {
  'use strict';

  const VOD_PATH_RE = /^\/([^/]+)\/videos\/([0-9a-f-]{36})/i;
  const FETCH_STEP_MS = 5_000;   // a API devolve janelas de 5s: [start_time, start_time + 5s)
  const LOOKAHEAD_MS = 30_000;   // quanto buscar à frente do vídeo
  const BACKLOG_MS = 30_000;     // quanto mostrar "pra trás" ao cair num ponto novo (seek)
  const SEEK_JUMP_MS = 20_000;   // pulo maior que isso pra frente = seek
  const MAX_DOM_MSGS = 250;
  const MAX_INFLIGHT = 2;
  const WEB_API = 'https://web.kick.com/api/v1';

  let ctx = null; // estado da VOD atual

  // ---------- utils ----------
  const parseKickDate = (s) => {
    if (!s) return NaN;
    return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  };

  const getJSON = async (url) => {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} em ${url.replace(/\?.*/, '')}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // primeiro índice com t > x
  const upperIdx = (arr, x) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtOffset = (ms) => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(0)}s`;

  // ---------- render (mesma estrutura/medidas do chat nativo) ----------
  const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;

  // texto -> HTML seguro com links clicáveis (o nativo usa <a> sublinhado)
  const linkify = (text) => {
    let out = '', last = 0;
    for (const mt of text.matchAll(URL_RE)) {
      out += esc(text.slice(last, mt.index));
      out += `<a class="kvcs-link" href="${esc(mt[0])}" target="_blank" rel="noopener noreferrer nofollow">${esc(mt[0])}</a>`;
      last = mt.index + mt[0].length;
    }
    return out + esc(text.slice(last));
  };

  const renderContent = (text) => {
    text = text || '';
    let out = '', last = 0;
    for (const mt of text.matchAll(EMOTE_RE)) {
      out += linkify(text.slice(last, mt.index));
      const [, id, name] = mt;
      out += `<span class="kvcs-emote"><img src="https://files.kick.com/emotes/${id}/fullsize" alt="${esc(name)}" title="${esc(name)}" loading="lazy"></span>`;
      last = mt.index + mt[0].length;
    }
    return out + linkify(text.slice(last));
  };

  // Na linha "Replying to" o nativo mostra o nome do emote como texto.
  const plainContent = (text) => (text || '').replace(EMOTE_RE, '$2');

  // type "reply": metadata é uma string JSON com original_message / original_sender
  const parseReply = (m) => {
    if (m.type !== 'reply' || !m.metadata) return null;
    try {
      const md = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
      const om = md.original_message;
      if (!om) return null;
      return {
        user: md.original_sender?.username ?? om.sender?.username ?? '???',
        text: plainContent(om.content),
      };
    } catch { return null; }
  };

  // Badges, do jeito que o replay nativo mostra:
  //  - badges (v1) = do canal: moderator, vip, sub_gifter, subscriber… (sem imagem na API)
  //  - badges_v2   = globais: level, GOAT, Flyby… (com imagem) — só os que o usuário selecionou
  //  - tudo junto, ordenado por sort_order crescente
  const ICONS = globalThis.KVCS_BADGE_ICONS || {};

  const pickSubBadge = (subBadges, months) => {
    let best = null;
    for (const b of subBadges || []) {
      if (b.months <= months && (!best || b.months > best.months)) best = b;
    }
    return best?.badge_image?.src || null;
  };

  function buildBadges(identity, meta) {
    const list = [];
    for (const b of identity?.badges ?? []) {
      if (!b?.type) continue;
      if (b.type === 'subscriber') {
        const months = b.count ?? 1;
        const title = `${months}-Month Subscriber`;
        const src = pickSubBadge(meta?.subBadges, months);
        if (src) list.push({ sort: b.sort_order ?? 9, title, src });
        else if (ICONS.subscriber) list.push({ sort: b.sort_order ?? 9, title, svg: ICONS.subscriber.svg });
        continue;
      }
      const icon = ICONS[b.type];
      if (icon) list.push({ sort: b.sort_order ?? 50, title: b.text || icon.title, svg: icon.svg });
    }
    for (const b of identity?.badges_v2 ?? []) {
      if (!b?.selected || !b.image_url) continue;
      const title = b.name === 'level' && b.metadata?.level ? `Level ${b.metadata.level}` : b.name;
      list.push({ sort: b.sort_order ?? 50, title, src: b.image_url });
    }
    return list.sort((a, b) => a.sort - b.sort);
  }

  // mensagem crua da API -> objeto enxuto
  const normalize = (m, meta) => ({
    id: m.id,
    t: parseKickDate(m.created_at),
    user: m.sender?.username ?? '???',
    color: m.sender?.identity?.color || '#53fc18',
    badges: buildBadges(m.sender?.identity, meta),
    reply: parseReply(m),
    html: renderContent(m.content),
  });

  const REPLY_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 3 1.5 7.5l5 4.5V9h3.25A3.25 3.25 0 0 1 13 12.25V14h1.5v-1.75A4.75 4.75 0 0 0 9.75 7.5H6.5V3Z"/></svg>';

  // "02:07:15" — tempo desde o início da live, como o replay nativo mostra
  const fmtVodTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  };

  function renderRow(m, startMs) {
    const row = document.createElement('div');
    row.className = 'kvcs-row';
    row.dataset.t = m.t;
    const badges = m.badges.length
      ? `<span class="kvcs-badges">${m.badges.map((b) =>
          `<span class="kvcs-badge" title="${esc(b.title)}">${b.svg ?? `<img src="${esc(b.src)}" alt="${esc(b.title)}">`}</span>`).join('')}</span>`
      : '';
    const time = Number.isFinite(startMs) ? `<span class="kvcs-time">${fmtVodTime(m.t - startMs)}</span>` : '';
    const line = time +
      `<span class="kvcs-ident">${badges}<span class="kvcs-user" style="color:${esc(m.color)}">${esc(m.user)}</span></span>` +
      `<span class="kvcs-colon">:</span> ` +
      `<span class="kvcs-content">${m.html}</span>`;
    row.innerHTML = m.reply
      ? `<div class="kvcs-entry kvcs-has-reply">` +
          `<div class="kvcs-reply">${REPLY_ICON}<span>Replying to ${esc(m.reply.user)}: ${esc(m.reply.text)}</span></div>` +
          `<div class="kvcs-line">${line}</div></div>`
      : `<div class="kvcs-entry">${line}</div>`;
    return row;
  }

  // ---------- API ----------
  // Rotas usadas pela própria página da VOD (set/2026):
  //   kick.com/api/v2/channels/{slug}                      -> id do canal
  //   web.kick.com/api/v1/channels/{id}/videos             -> VODs (id = uuid da URL, start_time ISO)
  //   web.kick.com/api/v1/chat/{id}/history?start_time=ISO -> mensagens de [t, t+5s)
  async function loadVodMeta(uuid, slug) {
    const ch = await getJSON(`/api/v2/channels/${slug}`);
    const channelId = ch?.id;
    if (!channelId) throw new Error(`canal "${slug}" sem id na API`);

    const list = await getJSON(`${WEB_API}/channels/${channelId}/videos`);
    const items = list?.data ?? [];
    const vod = items.find((v) => v?.id === uuid);
    if (!vod) throw new Error(`VOD não está na lista do canal (${items.length} vídeos)`);

    const startMs = parseKickDate(vod.start_time);
    if (!Number.isFinite(startMs)) throw new Error('VOD sem start_time');
    // badges de assinante do canal: [{ months, badge_image: { src } }]
    return { channelId, startMs, subBadges: ch.subscriber_badges ?? [] };
  }

  // A API aceita "2026-09-26T08:00:00Z" (sem milissegundos).
  const toApiIso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

  async function fetchWindow(channelId, atMs) {
    const url = `${WEB_API}/chat/${channelId}/history?start_time=${encodeURIComponent(toApiIso(atMs))}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const j = await getJSON(url);
        return j?.data?.messages ?? [];
      } catch (e) {
        if (e.status === 429 || e.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
        throw e;
      }
    }
    return [];
  }

  // ---------- estado de mensagens ----------
  function ingest(c, raw) {
    for (const r of raw) {
      if (!r?.id || c.seen.has(r.id)) continue;
      const m = normalize(r, c.meta);
      if (!Number.isFinite(m.t)) continue;
      c.seen.add(r.id);
      c.msgs.splice(upperIdx(c.msgs, m.t), 0, m);
      // chegou depois do playhead já ter passado (backlog de um seek): entra na posição certa
      if (m.t <= c.renderedUntil && m.t > c.renderedUntil - BACKLOG_MS) insertRow(c, m);
    }
  }

  function pumpFetches(c, absMs) {
    const target = absMs + LOOKAHEAD_MS;
    while (c.inflight < MAX_INFLIGHT && c.fetchCursor < target) {
      const at = c.fetchCursor;
      c.fetchCursor += FETCH_STEP_MS;
      c.inflight++;
      const gen = c.gen;
      fetchWindow(c.meta.channelId, at)
        .then((msgs) => { c.error = ''; if (ctx === c && gen === c.gen) ingest(c, msgs); })
        .catch((e) => { c.error = `erro: ${e.message}`; })
        .finally(() => { c.inflight--; });
    }
  }

  // ---------- UI ----------
  // Encaixa o painel no lugar da lista nativa (#chatroom-messages) e esconde a nativa.
  // Sem lista nativa (layout mudou / chat fechado): painel flutuante à direita.
  function mountPanel(c) {
    const native = document.getElementById('chatroom-messages');
    if (native && native.parentElement) {
      if (c.panel.previousElementSibling !== native) native.after(c.panel);
      c.panel.classList.remove('kvcs-floating');
      native.classList.toggle('kvcs-native-hidden', !c.showNative);
      c.panel.classList.toggle('kvcs-hidden', c.showNative);
    } else if (c.panel.parentElement !== document.body) {
      document.body.appendChild(c.panel);
      c.panel.classList.add('kvcs-floating');
      c.panel.classList.remove('kvcs-hidden');
    }
  }

  function buildPanel(c) {
    const el = document.createElement('div');
    el.id = 'kvcs-panel';
    el.innerHTML = `
      <div class="kvcs-bar">
        <span class="kvcs-dot" title="Chat sincronizado com o vídeo"></span>
        <span class="kvcs-title">Sincronizado</span>
        <span class="kvcs-rate"></span>
        <span class="kvcs-spacer"></span>
        <button type="button" data-off="-1000" title="Mostrar o chat 1s antes">−1s</button>
        <b class="kvcs-offval" title="Ajuste fino do chat"></b>
        <button type="button" data-off="1000" title="Mostrar o chat 1s depois">+1s</button>
        <button type="button" data-off="reset" title="Zerar ajuste">↺</button>
        <button type="button" data-act="native" title="Alternar para o chat original da Kick">⇄</button>
      </div>
      <div class="kvcs-list" role="log"></div>
      <button type="button" class="kvcs-more" hidden>Novas mensagens ↓</button>
      <div class="kvcs-status"></div>`;
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.classList.contains('kvcs-more')) { scrollToBottom(c); return; }
      if (b.dataset.act === 'native') { c.showNative = !c.showNative; mountPanel(c); return; }
      if (b.dataset.off) {
        c.offsetMs = b.dataset.off === 'reset' ? 0 : c.offsetMs + Number(b.dataset.off);
        try { chrome.storage?.local.set({ kvcsOffsetMs: c.offsetMs }); } catch { /* ok */ }
        el.querySelector('.kvcs-offval').textContent = fmtOffset(c.offsetMs);
        if (c.meta && c.video) resetTo(c, currentAbs(c));
      }
    });
    c.panel = el;
    c.list = el.querySelector('.kvcs-list');
    c.more = el.querySelector('.kvcs-more');
    c.list.addEventListener('scroll', () => { if (isAtBottom(c)) c.more.hidden = true; }, { passive: true });
    el.querySelector('.kvcs-offval').textContent = fmtOffset(c.offsetMs);
    mountPanel(c);
  }

  function setStatus(c, text) {
    const s = c.panel?.querySelector('.kvcs-status');
    if (s && s.textContent !== (text || '')) s.textContent = text || '';
  }

  const isAtBottom = (c) => c.list.scrollHeight - c.list.scrollTop - c.list.clientHeight < 60;

  function scrollToBottom(c) {
    c.list.scrollTop = c.list.scrollHeight;
    c.more.hidden = true;
  }

  // insere mantendo a ordem por tempo (quase sempre é só um append no fim)
  function insertRow(c, m) {
    const stick = isAtBottom(c);
    const row = renderRow(m, c.meta.startMs);
    let ref = c.list.lastElementChild;
    while (ref && Number(ref.dataset.t) > m.t) ref = ref.previousElementSibling;
    if (ref) ref.after(row); else c.list.prepend(row);

    if (stick) {
      while (c.list.childElementCount > MAX_DOM_MSGS) c.list.firstElementChild.remove();
      c.list.scrollTop = c.list.scrollHeight;
    } else {
      c.more.hidden = false; // usuário está lendo mais acima: não rola, só avisa
    }
  }

  // ---------- sincronização ----------
  const currentAbs = (c) => c.meta.startMs + c.video.currentTime * 1000 + c.offsetMs;

  function resetTo(c, absMs) {
    c.gen++;
    c.list.textContent = '';
    c.more.hidden = true;
    c.renderedUntil = absMs - BACKLOG_MS;
    c.fetchCursor = Math.floor((absMs - BACKLOG_MS) / FETCH_STEP_MS) * FETCH_STEP_MS;
  }

  // Além do timer, os eventos do próprio vídeo disparam o tick: o Chrome pode segurar
  // timers de abas sem foco/mudas por até 1 min, mas eventos de mídia continuam chegando.
  const VIDEO_EVENTS = ['timeupdate', 'seeked', 'ratechange', 'play', 'pause'];

  function bindVideo(c, v) {
    if (c.boundVideo === v) return;
    if (c.boundVideo) VIDEO_EVENTS.forEach((e) => c.boundVideo.removeEventListener(e, c.onVideoEvent));
    c.video = c.boundVideo = v;
    VIDEO_EVENTS.forEach((e) => v.addEventListener(e, c.onVideoEvent));
  }

  function tick(c) {
    if (ctx !== c) return;
    if (!c.video.isConnected) {            // o player pode recriar o <video>
      const v = document.querySelector('video');
      if (!v) return;
      bindVideo(c, v);
    }
    mountPanel(c); // o React da Kick pode recriar a área do chat

    const abs = currentAbs(c);
    if (abs < c.renderedUntil - 2000 || abs - c.renderedUntil > SEEK_JUMP_MS + BACKLOG_MS) {
      resetTo(c, abs); // seek pra trás ou pulo grande pra frente
    }

    pumpFetches(c, abs);

    const from = upperIdx(c.msgs, c.renderedUntil);
    const to = upperIdx(c.msgs, abs);
    for (let i = from; i < to; i++) insertRow(c, c.msgs[i]);
    if (abs > c.renderedUntil) c.renderedUntil = abs;

    const rate = c.video.playbackRate;
    const rateEl = c.panel.querySelector('.kvcs-rate');
    const rateTxt = rate !== 1 ? `${rate}x` : '';
    if (rateEl.textContent !== rateTxt) rateEl.textContent = rateTxt;
    setStatus(c, c.error || (c.video.paused ? 'pausado' : ''));
  }

  // ---------- ciclo de vida (Kick é SPA) ----------
  async function waitForVideo(timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = document.querySelector('video');
      if (v && v.readyState >= 1) return v;
      await sleep(300);
    }
    return null;
  }

  function teardown() {
    if (!ctx) return;
    clearInterval(ctx.timer);
    if (ctx.boundVideo) VIDEO_EVENTS.forEach((e) => ctx.boundVideo.removeEventListener(e, ctx.onVideoEvent));
    document.querySelectorAll('.kvcs-native-hidden').forEach((n) => n.classList.remove('kvcs-native-hidden'));
    ctx.panel?.remove();
    ctx = null;
  }

  async function setup(slug, uuid) {
    teardown();
    const c = {
      uuid, gen: 0, msgs: [], seen: new Set(), inflight: 0,
      renderedUntil: 0, fetchCursor: 0, offsetMs: 0, showNative: false, error: '',
    };
    ctx = c;
    try {
      const stored = await chrome.storage?.local.get('kvcsOffsetMs');
      c.offsetMs = stored?.kvcsOffsetMs ?? 0;
    } catch { /* storage indisponível: segue com 0 */ }

    buildPanel(c);
    setStatus(c, 'carregando VOD…');
    try {
      c.meta = await loadVodMeta(uuid, slug);
      c.video = await waitForVideo();
      if (!c.video) throw new Error('player não encontrado');
    } catch (e) {
      setStatus(c, `falhou: ${e.message}`);
      return;
    }
    if (ctx !== c) return;
    setStatus(c, '');
    c.onVideoEvent = () => tick(c);
    bindVideo(c, c.video);
    resetTo(c, currentAbs(c));
    c.timer = setInterval(() => tick(c), 200);
  }

  let lastPath = null;
  function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const m = location.pathname.match(VOD_PATH_RE);
    if (m) setup(m[1], m[2]); else teardown();
  }

  // Gancho para testes manuais: se a página definir globalThis.__KVCS_TEST__ antes de
  // injetar este arquivo, expõe o renderizador e não inicia sozinho. Content scripts
  // rodam num mundo isolado, então isso nunca acontece na extensão instalada.
  if (typeof globalThis.__KVCS_TEST__ === 'object' && globalThis.__KVCS_TEST__) {
    Object.assign(globalThis.__KVCS_TEST__, {
      normalize, renderRow, fetchWindow, loadVodMeta, setup, teardown, tick, getCtx: () => ctx,
    });
    return;
  }

  onRoute();
  setInterval(onRoute, 1000);
})();
