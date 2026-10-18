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
  const KEEP_MS = 5 * 60_000;     // memória: guarda só mensagens/janelas a ±5 min do playhead
  const PRUNE_AT = 2_000;         // só poda quando passar de tantas mensagens guardadas
  const FAILED_RETRY_MS = 10_000; // espera antes de tentar de novo uma janela que falhou
  const VIDEO_WAIT_MS = 30_000;   // sem player depois disso: desiste e devolve o chat original
  const WEB_API = 'https://web.kick.com/api/v1';

  // Textos do painel: português se o navegador estiver em PT, inglês no resto.
  const STRINGS = {
    en: {
      synced: 'Synced', nativeTitle: "Kick's original chat",
      toNative: 'Original chat', toSynced: 'Back to synced',
      toNativeTip: "Show Kick's original chat replay", toSyncedTip: 'Back to the chat synced with the video',
      more: 'New messages ↓', paused: 'paused', loading: 'loading VOD…',
      failed: 'failed: ', error: 'error: ', httpAt: 'at',
      noChannelId: (slug) => `channel "${slug}" has no id in the API`,
      vodNotListed: (n) => `VOD is not in the channel's list (${n} videos)`,
      noStart: 'VOD has no start_time',
      noVideo: 'video player not found', replyingTo: 'Replying to',
      hideTime: 'Hide timestamps', showTime: 'Show timestamps',
    },
    pt: {
      synced: 'Sincronizado', nativeTitle: 'Chat original da Kick',
      toNative: 'Chat original', toSynced: 'Voltar ao sincronizado',
      toNativeTip: 'Mostrar o replay original da Kick', toSyncedTip: 'Voltar ao chat sincronizado com o vídeo',
      more: 'Novas mensagens ↓', paused: 'pausado', loading: 'carregando VOD…',
      failed: 'falhou: ', error: 'erro: ', httpAt: 'em',
      noChannelId: (slug) => `canal "${slug}" sem id na API`,
      vodNotListed: (n) => `VOD não está na lista do canal (${n} vídeos)`,
      noStart: 'VOD sem start_time',
      noVideo: 'player de vídeo não encontrado', replyingTo: 'Respondendo a',
      hideTime: 'Ocultar horários', showTime: 'Mostrar horários',
    },
  };
  const uiLang = (() => {
    try { return globalThis.chrome?.i18n?.getUILanguage?.() || navigator.language || 'en'; }
    catch { return navigator.language || 'en'; }
  })();
  const T = /^pt\b/i.test(uiLang) ? STRINGS.pt : STRINGS.en;

  let ctx = null; // estado da VOD atual

  // Preferência "mostrar horários" (issue #1). Fica no localStorage do kick.com,
  // que o content script já acessa — não precisa da permissão "storage".
  const TIME_PREF_KEY = 'kvcs:showTime';
  const loadShowTime = () => {
    try { return localStorage.getItem(TIME_PREF_KEY) !== '0'; } catch { return true; }
  };
  const saveShowTime = (on) => {
    try { localStorage.setItem(TIME_PREF_KEY, on ? '1' : '0'); } catch { /* sem storage: só nesta página */ }
  };

  // ---------- utils ----------
  // A API manda "2026-09-26 08:00:00" ou ISO; sem fuso explícito é UTC (não hora local).
  const parseKickDate = (s) => {
    if (typeof s !== 'string' || !s) return NaN;
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : iso + 'Z');
  };

  const getJSON = async (url, signal) => {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' }, signal });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} ${T.httpAt} ${url.replace(/\?.*/, '')}`);
      err.status = r.status;
      const ra = Number(r.headers.get('Retry-After'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 30_000);
      throw err;
    }
    return r.json();
  };

  // sleep que pode ser cancelado (seek/teardown não ficam esperando um backoff à toa)
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

  // 429, 5xx e falha de rede/JSON inválido (sem status) valem nova tentativa; 4xx não.
  const isRetriable = (e) => e?.name !== 'AbortError' && (e?.status === undefined || e.status === 429 || e.status >= 500);

  async function getJSONRetry(url, signal, tries = 4) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getJSON(url, signal);
      } catch (e) {
        if (attempt >= tries - 1 || !isRetriable(e)) throw e;
        await sleep(e.retryAfterMs || 1000 * 2 ** attempt + Math.random() * 300, signal);
      }
    }
  }

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
    text = typeof text === 'string' ? text : '';
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
  const plainContent = (text) => (typeof text === 'string' ? text : '').replace(EMOTE_RE, '$2');

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
  const iconFor = (type) => (Object.hasOwn(ICONS, type) ? ICONS[type] : null);

  // Só https em <img src>; a cor entra num style="", então só aceita #hex (senão daria
  // para injetar outras declarações CSS pelo campo de cor do usuário).
  const safeSrc = (src) => (typeof src === 'string' && /^https:\/\//i.test(src) ? src : null);
  const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#53fc18');

  const pickSubBadge = (subBadges, months) => {
    let best = null;
    for (const b of subBadges || []) {
      if (b.months <= months && (!best || b.months > best.months)) best = b;
    }
    return safeSrc(best?.badge_image?.src);
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
        else if (iconFor('subscriber')) list.push({ sort: b.sort_order ?? 9, title, svg: ICONS.subscriber.svg });
        continue;
      }
      const icon = iconFor(b.type);
      if (icon) list.push({ sort: b.sort_order ?? 50, title: b.text || icon.title, svg: icon.svg });
    }
    for (const b of identity?.badges_v2 ?? []) {
      const src = b?.selected ? safeSrc(b.image_url) : null;
      if (!src) continue;
      const title = b.name === 'level' && b.metadata?.level ? `Level ${b.metadata.level}` : String(b.name ?? '');
      list.push({ sort: b.sort_order ?? 50, title, src });
    }
    return list.sort((a, b) => a.sort - b.sort);
  }

  // mensagem crua da API -> objeto enxuto
  const normalize = (m, meta) => ({
    id: m.id,
    t: parseKickDate(m.created_at),
    user: m.sender?.username ?? '???',
    color: safeColor(m.sender?.identity?.color),
    badges: buildBadges(m.sender?.identity, meta),
    reply: parseReply(m),
    html: renderContent(m.content),
  });

  const CLOCK_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const REPLY_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 3 1.5 7.5l5 4.5V9h3.25A3.25 3.25 0 0 1 13 12.25V14h1.5v-1.75A4.75 4.75 0 0 0 9.75 7.5H6.5V3Z"/></svg>';

  // Tempo desde o início da live, no mesmo formato do replay nativo:
  // "02:12" antes de 1h, "02:07:15" a partir de 1h.
  const fmtVodTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const mmss = `${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
    return h ? `${p(h)}:${mmss}` : mmss;
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
          `<div class="kvcs-reply">${REPLY_ICON}<span>${T.replyingTo} ${esc(m.reply.user)}: ${esc(m.reply.text)}</span></div>` +
          `<div class="kvcs-line">${line}</div></div>`
      : `<div class="kvcs-entry">${line}</div>`;
    return row;
  }

  // ---------- API ----------
  // Rotas usadas pela própria página da VOD (set/2026):
  //   kick.com/api/v2/channels/{slug}                      -> id do canal
  //   web.kick.com/api/v1/channels/{id}/videos             -> VODs (id = uuid da URL, start_time ISO)
  //   web.kick.com/api/v1/chat/{id}/history?start_time=ISO -> mensagens de [t, t+5s)
  async function loadVodMeta(uuid, slug, signal) {
    const ch = await getJSONRetry(`/api/v2/channels/${slug}`, signal);
    const channelId = ch?.id;
    if (!channelId) throw new Error(T.noChannelId(slug));

    const list = await getJSONRetry(`${WEB_API}/channels/${channelId}/videos`, signal);
    const items = list?.data ?? [];
    const vod = items.find((v) => v?.id === uuid);
    if (!vod) throw new Error(T.vodNotListed(items.length));

    const startMs = parseKickDate(vod.start_time);
    if (!Number.isFinite(startMs)) throw new Error(T.noStart);
    // badges de assinante do canal: [{ months, badge_image: { src } }]
    return { channelId, startMs, subBadges: ch.subscriber_badges ?? [] };
  }

  // A API aceita "2026-09-26T08:00:00Z" (sem milissegundos).
  const toApiIso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

  // Lança erro se todas as tentativas falharem: quem chama marca a janela para tentar de novo.
  async function fetchWindow(channelId, atMs, signal) {
    const url = `${WEB_API}/chat/${channelId}/history?start_time=${encodeURIComponent(toApiIso(atMs))}`;
    const j = await getJSONRetry(url, signal);
    return Array.isArray(j?.data?.messages) ? j.data.messages : [];
  }

  // ---------- estado de mensagens ----------
  // Janelas de 5s identificadas pelo início (múltiplo de FETCH_STEP_MS):
  //   c.done    já baixadas (as mensagens estão em c.msgs)
  //   c.pending em andamento (do AbortController atual)
  //   c.failed  falharam -> horário a partir do qual tentar de novo
  const floorStep = (ms) => Math.floor(ms / FETCH_STEP_MS) * FETCH_STEP_MS;

  function ingest(c, raw) {
    for (const r of raw) {
      if (!r?.id || c.seen.has(r.id)) continue;
      let m;
      try { m = normalize(r, c.meta); } catch { continue; } // uma mensagem estranha não derruba o lote
      if (!Number.isFinite(m.t)) continue;
      c.seen.add(r.id);
      c.msgs.splice(upperIdx(c.msgs, m.t), 0, m);
      // chegou depois do playhead já ter passado (backlog de um seek): entra na posição certa
      if (m.t <= c.renderedUntil && m.t > c.renderedUntil - BACKLOG_MS) insertRow(c, m);
    }
  }

  // Ordem: a janela do playhead primeiro, depois o que vem à frente, depois o backlog.
  function* windowsAround(abs) {
    const cur = floorStep(abs);
    for (let at = cur; at < abs + LOOKAHEAD_MS; at += FETCH_STEP_MS) yield at;
    for (let at = cur - FETCH_STEP_MS; at >= floorStep(abs - BACKLOG_MS); at -= FETCH_STEP_MS) yield at;
  }

  function pumpFetches(c, abs) {
    const now = Date.now();
    for (const at of windowsAround(abs)) {
      if (c.pending.size >= MAX_INFLIGHT) return;
      if (c.done.has(at) || c.pending.has(at)) continue;
      if ((c.failed.get(at) ?? 0) > now) continue;
      startFetch(c, at);
    }
  }

  function startFetch(c, at) {
    const signal = c.abort.signal;
    c.pending.add(at);
    fetchWindow(c.meta.channelId, at, signal)
      .then((msgs) => {
        if (ctx !== c) return;
        c.done.add(at);
        c.failed.delete(at);
        ingest(c, msgs);
      })
      .catch((e) => {
        if (ctx !== c || e?.name === 'AbortError') return;
        c.failed.set(at, Date.now() + FAILED_RETRY_MS);
        c.lastError = e?.message || String(e);
      })
      .finally(() => {
        if (signal === c.abort.signal) c.pending.delete(at); // seek limpou o pending: não mexe no novo
      });
  }

  // Memória constante em VODs longas: descarta o que está a mais de KEEP_MS do playhead.
  // Corta em fronteira de janela, para c.done nunca dizer "baixada" de uma janela pela metade.
  function prune(c, abs) {
    const lo = floorStep(abs - KEEP_MS);
    const hi = floorStep(abs + KEEP_MS);
    if (c.msgs.length > PRUNE_AT && (c.msgs[0].t < lo || c.msgs[c.msgs.length - 1].t >= hi)) {
      const a = upperIdx(c.msgs, lo - 1);
      const b = upperIdx(c.msgs, hi - 1);
      for (const m of c.msgs.slice(0, a)) c.seen.delete(m.id);
      for (const m of c.msgs.slice(b)) c.seen.delete(m.id);
      c.msgs = c.msgs.slice(a, b);
      for (const at of c.done) if (at < lo || at >= hi) c.done.delete(at);
    }
    for (const at of c.failed.keys()) if (at < lo || at >= hi) c.failed.delete(at);
  }

  // há janela com falha perto do playhead? (o erro some sozinho quando ela é recuperada)
  function nearbyError(c, abs) {
    const lo = floorStep(abs - BACKLOG_MS), hi = abs + LOOKAHEAD_MS;
    for (const at of c.failed.keys()) if (at >= lo && at < hi) return T.error + c.lastError;
    return '';
  }

  // ---------- UI ----------
  // Encaixa o painel por cima da lista nativa (#chatroom-messages).
  // A lista da Kick NÃO é escondida (display: none): escondida, ela para de acumular atraso
  // e ao reaparecer parece sincronizada. Coberta, continua rodando exatamente como a Kick
  // faz — ao trocar para o chat original você vê o estado real dele.
  // Sem lista nativa (layout mudou / chat fechado): painel flutuante à direita.
  function mountPanel(c) {
    const native = document.getElementById('chatroom-messages');
    if (native && native.parentElement) {
      // Só move quando o contêiner mudou (React recriou o chat). Mover zera o scrollTop,
      // então devolve a lista ao fim se ela estava no fim.
      if (c.panel.parentElement !== native.parentElement) {
        native.after(c.panel);
        if (c.stick) scrollToBottom(c);
      }
      c.panel.classList.remove('kvcs-floating');
      if (native.inert !== !c.showNative) native.inert = !c.showNative; // fora do foco/leitor de tela enquanto coberta
      if (c.native && c.native !== native) c.native.inert = false;
      c.native = native;
      c.panel.classList.toggle('kvcs-native-mode', c.showNative);
    } else if (c.panel.parentElement !== document.body) {
      document.body.appendChild(c.panel);
      c.panel.classList.add('kvcs-floating');
      c.panel.classList.remove('kvcs-native-mode');
      if (c.stick) scrollToBottom(c);
    }
  }

  function buildPanel(c) {
    const el = document.createElement('div');
    el.id = 'kvcs-panel';
    el.innerHTML = `
      <div class="kvcs-bar">
        <span class="kvcs-dot"></span>
        <span class="kvcs-title">${T.synced}</span>
        <span class="kvcs-rate"></span>
        <span class="kvcs-spacer"></span>
        <button type="button" class="kvcs-icon-btn" data-act="time">${CLOCK_ICON}</button>
        <button type="button" class="kvcs-switch" data-act="native" title="${T.toNativeTip}">${T.toNative}</button>
      </div>
      <div class="kvcs-list" role="log"></div>
      <button type="button" class="kvcs-more" hidden>${T.more}</button>
      <div class="kvcs-status"></div>`;
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.classList.contains('kvcs-more')) { scrollToBottom(c); return; }
      if (b.dataset.act === 'native') setNativeMode(c, !c.showNative);
      if (b.dataset.act === 'time') { setShowTime(c, !c.showTime); saveShowTime(c.showTime); }
    });
    c.panel = el;
    c.list = el.querySelector('.kvcs-list');
    c.more = el.querySelector('.kvcs-more');
    c.rateEl = el.querySelector('.kvcs-rate');
    // "colado no fim" é decidido pelo usuário (scroll), não medido a cada linha inserida
    c.list.addEventListener('scroll', () => {
      c.stick = isAtBottom(c);
      if (c.stick) c.more.hidden = true;
    }, { passive: true });
    setShowTime(c, loadShowTime());
    setNativeMode(c, false);
  }

  // Os horários continuam no DOM; só a classe do painel decide se aparecem.
  function setShowTime(c, on) {
    c.showTime = on;
    c.panel.classList.toggle('kvcs-hide-time', !on);
    const btn = c.panel.querySelector('[data-act="time"]');
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? T.hideTime : T.showTime;
    btn.setAttribute('aria-label', btn.title);
    if (c.stick) scrollToBottom(c); // as linhas quebram diferente e mudam de altura
  }

  // Alterna entre o chat sincronizado e o replay original da Kick.
  // No modo original o painel encolhe para só a barra, que continua com o botão de voltar.
  function setNativeMode(c, on) {
    c.showNative = on;
    c.panel.querySelector('.kvcs-title').textContent = on ? T.nativeTitle : T.synced;
    const btn = c.panel.querySelector('.kvcs-switch');
    btn.textContent = on ? T.toSynced : T.toNative;
    btn.title = on ? T.toSyncedTip : T.toNativeTip;
    mountPanel(c);
    if (!on) scrollToBottom(c);
  }

  // Não deu para iniciar: devolve o chat original e mostra o motivo na barra,
  // em vez de deixar o painel tapando (e travando) o chat da Kick.
  function fail(c, msg) {
    c.dead = true;
    setNativeMode(c, true);
    c.panel.classList.add('kvcs-dead');
    const title = c.panel.querySelector('.kvcs-title');
    title.textContent = T.failed + msg;
    title.title = title.textContent;
    clearInterval(c.timer);
    c.timer = setInterval(() => { if (ctx === c) mountPanel(c); }, 1000); // o React pode recriar o chat
  }

  function setStatus(c, text) {
    const s = c.panel?.querySelector('.kvcs-status');
    if (s && s.textContent !== (text || '')) s.textContent = text || '';
  }

  const isAtBottom = (c) => c.list.scrollHeight - c.list.scrollTop - c.list.clientHeight < 60;

  function scrollToBottom(c) {
    c.list.scrollTop = c.list.scrollHeight;
    c.stick = true;
    c.more.hidden = true;
  }

  // Depois de inserir: limita o DOM SEMPRE (com teto maior se o usuário está lendo mais acima,
  // para não sumir o que ele está lendo) e rola só se estava colado no fim.
  // Ao remover linhas acima, o scroll anchoring do Chrome mantém a posição de leitura.
  function afterInsert(c) {
    const cap = c.stick ? MAX_DOM_MSGS : MAX_DOM_MSGS * 4;
    while (c.list.childElementCount > cap) c.list.firstElementChild.remove();
    if (c.stick) c.list.scrollTop = c.list.scrollHeight;
    else c.more.hidden = false; // usuário está lendo mais acima: não rola, só avisa
  }

  // insere mantendo a ordem por tempo (mensagens que chegam atrasadas do backlog)
  function insertRow(c, m) {
    const row = renderRow(m, c.meta.startMs);
    let ref = c.list.lastElementChild;
    while (ref && Number(ref.dataset.t) > m.t) ref = ref.previousElementSibling;
    if (ref) ref.after(row); else c.list.prepend(row);
    afterInsert(c);
  }

  // ---------- sincronização ----------
  const currentAbs = (c) => c.meta.startMs + c.video.currentTime * 1000;

  function resetTo(c, absMs) {
    c.abort?.abort();                   // cancela fetches/backoffs da posição antiga
    c.abort = new AbortController();
    c.pending.clear();
    c.list.textContent = '';
    c.more.hidden = true;
    c.stick = true;
    c.renderedUntil = absMs - BACKLOG_MS;
  }

  // O player da VOD não é necessariamente o primeiro <video> da página: a Kick tem
  // vídeos decorativos (ex.: reward-available-CTA.webm, 1s em loop, 36px) que podem
  // vir antes no DOM. Pegar o primeiro prendia o chat em ~00:00:00.
  // Escolhe o maior <video> visível, desempatando pela duração.
  const MIN_PLAYER_W = 200;
  function pickVideo() {
    let best = null, bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      const area = v.clientWidth * v.clientHeight;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      if (v.clientWidth < MIN_PLAYER_W && dur < 60) continue; // ícone/animação
      const score = area + dur;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  // Além do timer, os eventos do próprio vídeo disparam o tick: o Chrome pode segurar
  // timers de abas sem foco/mudas por até 1 min, mas eventos de mídia continuam chegando.
  const VIDEO_EVENTS = ['timeupdate', 'seeking', 'seeked', 'ratechange', 'play', 'pause'];

  function bindVideo(c, v) {
    if (c.boundVideo === v) return;
    if (c.boundVideo) VIDEO_EVENTS.forEach((e) => c.boundVideo.removeEventListener(e, c.onVideoEvent));
    c.video = c.boundVideo = v;
    VIDEO_EVENTS.forEach((e) => v.addEventListener(e, c.onVideoEvent));
  }

  function tick(c) {
    if (ctx !== c || c.dead) return;
    mountPanel(c); // o React da Kick pode recriar a área do chat (mesmo com o player sumido)
    // Mantém o vídeo atual enquanto ele for o player; só procura outro se ele sumir/encolher
    // (evita pular para um preview maior que aparece por um instante).
    if (!(c.video?.isConnected && c.video.clientWidth >= MIN_PLAYER_W)) {
      const v = pickVideo();
      if (v && v !== c.video) bindVideo(c, v);
    }
    if (!c.video?.isConnected) return;

    const abs = currentAbs(c);
    // Seek: pelo evento "seeking" (qualquer pulo de verdade) ou, se o evento se perder,
    // pela heurística (voltou no tempo ou pulou muito pra frente).
    const jumped = abs < c.renderedUntil - 2000 || abs - c.renderedUntil > (c.seeking ? 3000 : SEEK_JUMP_MS + BACKLOG_MS);
    c.seeking = false;
    if (jumped) resetTo(c, abs);

    prune(c, abs);
    pumpFetches(c, abs);

    const from = upperIdx(c.msgs, c.renderedUntil);
    const to = upperIdx(c.msgs, abs);
    if (to > from) {
      // mensagens novas são todas posteriores às que estão na tela: um append só
      const frag = document.createDocumentFragment();
      for (let i = from; i < to; i++) frag.appendChild(renderRow(c.msgs[i], c.meta.startMs));
      c.list.appendChild(frag);
      afterInsert(c);
    }
    if (abs > c.renderedUntil) c.renderedUntil = abs;

    const rate = c.video.playbackRate;
    const rateTxt = rate !== 1 ? `${rate}x` : '';
    if (c.rateEl.textContent !== rateTxt) c.rateEl.textContent = rateTxt;
    setStatus(c, nearbyError(c, abs) || (c.video.paused ? T.paused : ''));
  }

  // ---------- ciclo de vida (Kick é SPA) ----------
  // Basta o <video> existir: o player pode ficar sem carregar (autoplay bloqueado,
  // aba em segundo plano) e só carregar quando o usuário der play. Os eventos do
  // vídeo (play/seeked/timeupdate) cuidam do resto.
  async function waitForVideo(c, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (ctx !== c) return null;
      const v = pickVideo();
      if (v) return v;
      await sleep(500);
    }
    return null;
  }

  function teardown() {
    if (!ctx) return;
    ctx.abort?.abort();
    clearInterval(ctx.timer);
    if (ctx.boundVideo) VIDEO_EVENTS.forEach((e) => ctx.boundVideo.removeEventListener(e, ctx.onVideoEvent));
    if (ctx.native) ctx.native.inert = false;
    ctx.panel?.remove();
    ctx = null;
  }

  async function setup(slug, uuid) {
    teardown();
    const c = {
      uuid, msgs: [], seen: new Set(), done: new Set(), pending: new Set(), failed: new Map(),
      renderedUntil: 0, showNative: false, stick: true, lastError: '', abort: new AbortController(),
    };
    ctx = c;
    buildPanel(c);
    setStatus(c, T.loading);
    try {
      c.meta = await loadVodMeta(uuid, slug, c.abort.signal);
    } catch (e) {
      if (ctx === c && e?.name !== 'AbortError') fail(c, e?.message || String(e));
      return;
    }
    c.video = await waitForVideo(c, VIDEO_WAIT_MS);
    if (ctx !== c) return;
    if (!c.video) { fail(c, T.noVideo); return; }
    setStatus(c, '');
    c.onVideoEvent = (ev) => {
      if (ev.type === 'seeking') c.seeking = true;
      tick(c);
    };
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
  // rodam num mundo isolado, então isso nunca acontece na extensão instalada
  // (e um elemento com id="__KVCS_TEST__" na página não conta: DOM clobbering).
  const hook = globalThis.__KVCS_TEST__;
  if (hook && typeof hook === 'object' && !(typeof Node !== 'undefined' && hook instanceof Node)) {
    Object.assign(hook, {
      normalize, renderRow, fetchWindow, loadVodMeta, setup, teardown, tick, getCtx: () => ctx,
      parseKickDate, safeColor, prune, pumpFetches,
    });
    return;
  }

  onRoute();
  setInterval(onRoute, 1000);
})();
