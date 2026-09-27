// Ícones dos badges de canal (moderador, VIP, etc.).
// A API de histórico manda só o tipo desses badges (sem imagem) e a Kick desenha SVGs próprios.
// Estes são desenhos originais, simples, nas mesmas cores dos badges da Kick, para o chat
// ficar reconhecível sem redistribuir os ícones dela.
// Badges globais (nível, GOAT, Flyby…) e de assinante usam as imagens oficiais que a API já manda.
globalThis.KVCS_BADGE_ICONS = (() => {
  const box = (bg, inner) =>
    `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="4" fill="${bg}"/>${inner}</svg>`;
  const INK = '#0b0e0f';

  return {
    // coroa sobre dourado
    vip: {
      title: 'VIP',
      svg: box('#ffb21e',
        `<path fill="${INK}" d="M4.2 13.2 3.4 6.6l3.7 2.7L10 4.8l2.9 4.5 3.7-2.7-.8 6.6H4.2Z"/><rect x="4.2" y="14.2" width="11.6" height="1.8" rx=".6" fill="${INK}"/>`),
    },
    // martelo sobre azul
    moderator: {
      title: 'Moderator',
      svg: box('#00aef5',
        `<path fill="${INK}" d="m11.6 3.3 5.1 5.1-2.3 2.3-5.1-5.1 2.3-2.3Z"/><path fill="${INK}" d="m9.6 8 2.4 2.4-6.1 6.1a1.3 1.3 0 0 1-1.8 0l-.6-.6a1.3 1.3 0 0 1 0-1.8L9.6 8Z"/>`),
    },
    // presente verde (sem fundo, como o da Kick)
    sub_gifter: {
      title: 'Sub Gifter',
      svg: `<svg viewBox="0 0 20 20" aria-hidden="true"><path fill="#53fc18" d="M6.4 2.6c1.4-.6 2.8.5 3.6 2.2.8-1.7 2.2-2.8 3.6-2.2 1.3.6 1.2 2.3.2 3.4H6.2c-1-1.1-1.1-2.8.2-3.4Z"/><rect x="2.5" y="6" width="15" height="4" rx="1" fill="#53fc18"/><rect x="3.5" y="10" width="13" height="8" rx="1" fill="#32970e"/><rect x="9" y="6" width="2" height="12" fill="#0b3d02"/></svg>`,
    },
    // selo de verificado
    verified: {
      title: 'Verified channel',
      svg: `<svg viewBox="0 0 20 20" aria-hidden="true"><path fill="#1eff6a" d="m10 1.2 2.3 1.6 2.8-.1.9 2.7 2.2 1.7-.9 2.7.9 2.7-2.2 1.7-.9 2.7-2.8-.1L10 18.8l-2.3-1.6-2.8.1-.9-2.7-2.2-1.7.9-2.7-.9-2.7L4 5.4l.9-2.7 2.8.1L10 1.2Z"/><path fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6.4 10.2 2.4 2.4 4.8-5"/></svg>`,
    },
    // moeda dourada com "1"
    founder: {
      title: 'Founder',
      svg: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.6" fill="#ffb21e"/><circle cx="10" cy="10" r="6.6" fill="none" stroke="#ffd766" stroke-width="1.2"/><path fill="${INK}" d="M10.6 5.6v8.8H8.8V7.9l-1.5.9V7l1.9-1.4h1.4Z"/></svg>`,
    },
    // "OG" sobre ciano
    og: {
      title: 'OG',
      svg: box('#00d5e6',
        `<text x="10" y="13.6" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="8.6" font-weight="800" fill="${INK}">OG</text>`),
    },
    // câmera sobre vermelho
    broadcaster: {
      title: 'Broadcaster',
      svg: box('#ff5c5c',
        `<rect x="3.5" y="6.5" width="9" height="7" rx="1.5" fill="${INK}"/><path fill="${INK}" d="m13.5 9 3-2v6l-3-2V9Z"/>`),
    },
    // escudo sobre roxo
    staff: {
      title: 'Staff',
      svg: box('#9b6bff',
        `<path fill="${INK}" d="M10 3.5 15.5 5.5v4c0 3.3-2.3 5.8-5.5 7-3.2-1.2-5.5-3.7-5.5-7v-4L10 3.5Z"/>`),
    },
    // assinante em canal sem badge personalizado
    subscriber: {
      title: 'Subscriber',
      svg: box('#53fc18',
        `<path fill="${INK}" d="m10 3.8 1.8 3.8 4.1.5-3 2.9.8 4.1L10 13.1l-3.7 2 .8-4.1-3-2.9 4.1-.5L10 3.8Z"/>`),
    },
  };
})();
