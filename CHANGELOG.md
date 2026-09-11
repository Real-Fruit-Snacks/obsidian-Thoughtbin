# Changelog

All notable changes to Thoughtbin are recorded here. Versions follow [Semantic Versioning](https://semver.org/); each release ships `main.js`, `styles.css` and `manifest.json` on the [Releases](https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/releases) page.

## [1.2.2] - 2026-09-11

### Fixed
- Composer placeholder and text no longer fall back to a monospace font on desktop.

## [1.2.1] - 2026-09-11

### Changed
- Activity calendar and pinned cards now follow the theme's accent colour instead of fixed green and yellow.
- Sidebar stat labels pluralise correctly ("1 day", "2 days").

## [1.2.0] - 2026-09-11

### Added
- Composer is now a CodeMirror editor with live Markdown styling: headings, lists, checkboxes, code, quotes, tags and links render as you type, with syntax markers shown only on the active line.
- `[[` autocompletes files in the vault; `#` autocompletes existing tags. Brackets and quotes auto-pair.
- Enter continues lists, numbered lists, checklists and quotes. Ctrl/Cmd+B, I and K for bold, italic and links.
- Links in saved thoughts open on click, with hover previews. Ctrl/Cmd+click a `[[link]]` while composing.
- Right-click a card for the pin / edit / archive / delete menu.
- "Focus composer" command.
- Mobile: sidebar slides in as a drawer; horizontal tag strip above the timeline.
- Settings: default code block language, save with Enter, composer template, sort order, time display and date format, collapse long thoughts, confirm before deleting, first day of week, tag strip toggle.

### Changed
- Desktop: the sidebar always sits beside the timeline in the same pane; the panel button collapses it.
- Cards, composer and search field restyled; context row shows the active filter and count.
- Plugin icon is now `brain`.

### Removed
- "Show sidebar by default" setting (replaced by the per-platform behaviour above).

## [1.1.1] - 2026-09-11

### Fixed
- Release workflow tag trigger so releases match Obsidian's plugin requirements.

## [1.1.0] - 2026-09-11

### Added
- First public release: timeline view with composer, tags, pins, archive, task toggling, attachments, search, activity calendar, quick capture and settings.

[1.2.2]: https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/releases/tag/1.2.2
[1.2.1]: https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/releases/tag/1.2.1
[1.2.0]: https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/releases/tag/1.2.0
[1.1.1]: https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/releases/tag/1.1.1
[1.1.0]: https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/releases/tag/1.1.0
