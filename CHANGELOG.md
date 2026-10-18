# Changelog

All notable changes to this extension are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.6.2] - 2026-10-18

### Fixed
- With "Original chat" on, if Kick's chat column was collapsed, the floating panel kept the "Original chat" title while showing the synced chat. It now switches back to synced.

## [0.6.1] - 2026-10-18

### Fixed
- Chat gaps: a 5-second window that failed to load (rate limit, server or network error) was skipped for good, with no warning. It is now retried, network errors are retried too, and the error under the chat goes away once the missing messages arrive.
- After skipping to another point, the chat could stay blank for up to 15 seconds while requests for the old position finished. Those are now cancelled, and the window at the playhead loads first.
- When Kick re-rendered its chat, the panel lost its scroll position: it stopped following new messages, and the message limit on screen stopped applying, so a long session could slow the tab down. The panel now keeps its place (at the bottom, or where you were reading) and always limits the messages on screen.
- Memory no longer grows with the length of the VOD: only messages within 5 minutes of the playhead are kept.
- If the VOD couldn't be loaded, the error panel covered Kick's chat and left it unusable. Kick's chat now comes back, with the reason in the bar.
- VODs older than the channel's ~30 most recent ones failed with "VOD is not in the channel's list". Their start time now comes from the VOD id itself.
- Scrolling up to read was sometimes undone by new messages arriving.
- "Replying to" is now translated to Portuguese.

### Security
- Username colors are only accepted as `#hex`, and badge images only over `https`, so data from the API can't inject CSS or odd URLs into the panel.

## [0.6.0] - 2026-10-18

### Added
- Clock button in the panel bar to show or hide the timestamps of the synced chat ([#1](https://github.com/matBentes/kick-vod-chat-sync/issues/1)). The choice is remembered for the next VODs; timestamps stay visible by default.
- "Stable hooks for scripts" section in the README, listing the panel selectors that userscripts can rely on.

### Fixed
- The synced chat could get stuck at `00:00` and stop following the video. Kick sometimes adds a small animated `<video>` (the channel reward icon) before the player, and the extension was syncing to it instead of the VOD. It now picks the main player and switches if the page changes.

### Changed
- Timestamps use the same format as Kick's native replay: `MM:SS` during the first hour of the stream (`10:02`), `HH:MM:SS` after it (`04:25:12`). Previously the hour was always shown (`00:10:02`). Scripts that match the timestamp text with a fixed `HH:MM:SS` pattern should also accept `MM:SS`; selecting `.kvcs-time` is unaffected.

## [0.5.2] - 2026-09-27

### Changed
- Panel text in English by default, Portuguese when the browser is in Portuguese.
- First version published on the Chrome Web Store.

## [0.5.1] - 2026-09-26

### Fixed
- The extension no longer pauses, hides or realigns Kick's original replay; switching to "Original chat" shows its real state.

## [0.5.0] - 2026-09-26

### Added
- Sync with no manual adjustment, and a toggle between the synced chat and Kick's original chat with a way back.

## [0.4.0] - 2026-09-26

- First public version.

[0.6.2]: https://github.com/matBentes/kick-vod-chat-sync/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/matBentes/kick-vod-chat-sync/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/matBentes/kick-vod-chat-sync/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/matBentes/kick-vod-chat-sync/releases/tag/v0.5.1
