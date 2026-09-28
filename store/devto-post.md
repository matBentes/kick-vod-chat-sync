---
title: I built a Chrome extension because Kick's VOD chat can't keep up with 1.5x
published: true
tags: javascript, chrome, webdev, opensource
cover_image: https://raw.githubusercontent.com/matBentes/kick-vod-chat-sync/main/store/en/screenshot-1.png
---

I watch most streams as VODs, and I watch them at 1.5x. On Kick that has one annoying side effect: the chat replay falls behind. Someone scores, the streamer screams, and the "GOOOL" wave in chat shows up 20 seconds later.

So I built **[VOD Chat Sync for Kick](https://chromewebstore.google.com/detail/vod-chat-sync-for-kick/deeikanpfgojedfhhooelogofoeafkhg)**, a small Chrome extension that keeps the chat replay in sync with the video at any speed. It's free and open source (MIT).

![Synced chat panel](https://raw.githubusercontent.com/matBentes/kick-vod-chat-sync/main/docs/chat.png)

## Why the chat lags

I measured the native replay before touching anything. It fetches message windows at video pace, but it *displays* them at wall-clock pace (1x). At 2x, after 30 seconds of watching, the native chat was about **40 seconds behind** the video. Pausing or seeking realigns it, and then it starts drifting again.

So it's not a network problem. The replay's clock is simply the wrong clock.

## The fix: use the video as the clock

Every VOD has the stream's real start time. That gives a simple mapping:

```js
const absoluteTime = vodStartMs + video.currentTime * 1000;
```

With that, the extension:

1. Fetches messages from the same endpoint the site uses, in 5-second windows, about 30 seconds ahead of the video.
2. Renders each message only when `absoluteTime` passes its timestamp.
3. Resets the list on a seek (backward, or a big jump forward).

Because the video drives everything, 1.25x, 1.5x, 2x, pause and seek all just work, with no speed-specific logic.

A few details that took longer than expected:

- **Throttled timers.** Chrome throttles `setInterval` in background or unfocused tabs, so the tick is also driven by `timeupdate`, `seeked`, `ratechange`, `play` and `pause` events.
- **SPA navigation.** Kick is a single-page app, so the extension watches `location.pathname` and tears everything down when you leave a VOD.
- **Looking native.** I matched the chat's spacing, fonts, badges, emotes and replies, and checked 54 messages side by side against the native chat, down to row height.
- **Being honest about the original.** There's an "Original chat" button. My panel covers the native list instead of hiding it, because hiding it with `display: none` made Kick's replay realign itself, which would make the comparison look better than reality. When you switch, you see the native chat exactly as it behaves.

## Privacy

No data is collected. No server, no analytics. Requests go straight from your browser to Kick, the same ones the site already makes. No build step either: what's in the `extension/` folder is what runs.

## Links

- Chrome Web Store: https://chromewebstore.google.com/detail/vod-chat-sync-for-kick/deeikanpfgojedfhhooelogofoeafkhg
- Source: https://github.com/matBentes/kick-vod-chat-sync

Hopefully Kick fixes this natively one day and this extension becomes useless. Until then, enjoy your VODs at any speed with a chat that keeps up. Bug reports and ideas are welcome in the issues.
