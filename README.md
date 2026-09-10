# Thoughtbin for Obsidian

Thoughtbin is a lightweight, privacy-first microblogging feed built directly into your Obsidian vault. Inspired by usememos.com, it provides a seamless, Twitter-like feed for capturing quick thoughts, ideas, and notes without breaking your flow.

## Features

* **Quick Capture:** A dedicated composer that auto-expands and supports Markdown, allowing you to instantly log thoughts using `Ctrl+Enter` or `Cmd+Enter`.
* **Tagging & Filtering:** Full support for inline `#tags`. Click on any tag in the filter bar to instantly organize and view related memos.
* **Archive System:** Keep your main feed clean by archiving memos. Archived memos are hidden from the default view but remain safely stored in your vault.
* **Custom Storage:** Choose exactly where your memos live. Configure a custom default save folder in the plugin settings (defaults to `memos/`).
* **Safety First:** Built-in delete confirmation prompts ensure you never accidentally lose a memo.
* **Native Integration:** Memos are saved as standard `.md` files in your vault. They can be opened in the standard Obsidian editor, linked to, and backed up like any other note.

## Installation

### Manual Installation

1. Navigate to the **Releases** tab of this repository.
2. Download the latest release `.zip` file, or manually download `main.js`, `manifest.json`, and `styles.css`.


3. Locate your Obsidian vault's plugin folder: `<vault>/.obsidian/plugins/`.
4. Create a new folder named `thoughtbin`.
5. Place the downloaded files into the `thoughtbin` folder.
6. Restart Obsidian, go to **Settings > Community Plugins**, and enable **Thoughtbin**.

## Usage

1. **Open the Feed:** Click the `message-square` icon in your left ribbon, or open the Command Palette (`Ctrl/Cmd + P`) and search for **"Open Thoughtbin Feed"**.
2. **Write a Memo:** Type your thought into the composer. Use tags like `#idea` or `#todo`. Press `Ctrl+Enter` (or `Cmd+Enter`) to save.
3. **Manage Memos:**
* **Archive:** Click the box icon on any memo to move it to the Archive tab. This adds an `archived: true` property to the file's frontmatter.
* **Delete:** Click the trash icon to delete a memo (a confirmation prompt will appear).
* **Edit:** Click the file icon to open the memo in standard Obsidian edit mode.


4. **Settings:** Navigate to Obsidian's settings menu under **Thoughtbin** to change the default folder where your memos are saved.

## Contributing and Development

If you'd like to contribute or tweak the plugin:

1. Clone the repository into your Obsidian plugins folder.
2. Make changes to `main.js` or `styles.css`.
3. Reload the plugin in Obsidian to see your changes applied.

## Credits

Developed by Real-Fruit-Snacks.
Inspired by the open-source project [Memos (usememos.com)](https://usememos.com).
