# Contributing to Thoughtbin

Thanks for taking the time. Bug reports, feature ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/Real-Fruit-Snacks/obsidian-Thoughtbin/issues/new/choose) using the bug template. Please include:

- Obsidian version and platform (Windows / macOS / Linux / iOS / Android)
- Thoughtbin version (Settings → Community plugins)
- Steps to reproduce, and what you expected instead
- Anything from the developer console (Ctrl/Cmd+Shift+I on desktop) that mentions Thoughtbin

## Suggesting a feature

Open an issue with the feature template. Describe the problem you're trying to solve rather than only the solution — it makes it easier to find the right fit for the plugin.

## Working on the code

There is no build step. The plugin is a single `main.js` plus `styles.css` and `manifest.json`.

1. Fork and clone the repo into `<your vault>/.obsidian/plugins/thoughtbin/`.
2. Enable the plugin in Obsidian.
3. Edit `main.js` or `styles.css`, then reload the plugin (toggle it off and on, or use the "Reload app without saving" command).

Guidelines:

- Use only the public Obsidian API and the CodeMirror packages Obsidian bundles. No private `app` internals, no hardcoded workspace class names.
- Register everything with `this.register*` so it's cleaned up on unload.
- Keep it working on mobile (`isDesktopOnly` is `false`). No Node or Electron APIs.
- Match the existing style: 2-space indent, single quotes, no semicolon-free code.
- Don't commit `data.json`.

## Pull requests

- One change per PR; keep them small enough to review.
- Describe what changed and why, and note anything you tested on mobile.
- Don't bump `manifest.json` or `versions.json` — that happens at release time.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and the site's `docs/changelog.html`.
2. Bump `version` in `manifest.json` and add the entry to `versions.json`.
3. Commit, then tag with the bare version number (no `v` prefix) and push the tag:
   ```bash
   git tag -a 1.3.0 -m "1.3.0" && git push origin 1.3.0
   ```
4. The release workflow builds the GitHub release and attaches the three plugin files.
