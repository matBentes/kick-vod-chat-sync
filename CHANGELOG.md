# Changelog

All notable changes to this extension are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

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

[0.6.0]: https://github.com/matBentes/kick-vod-chat-sync/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/matBentes/kick-vod-chat-sync/releases/tag/v0.5.1
