const { Plugin, ItemView, Notice, MarkdownRenderer, setIcon, PluginSettingTab, Setting, Modal } = require('obsidian');

const VIEW_TYPE_THOUGHTBIN = 'thoughtbin-feed-view';

const DEFAULT_SETTINGS = {
    storageFolder: 'memos'
};

// --- Settings Tab ---
class ThoughtbinSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
        .setName('Storage Folder')
        .setDesc('The folder where memos are saved (e.g., "memos").')
        .addText(text => text
        .setPlaceholder('memos')
        .setValue(this.plugin.settings.storageFolder)
        .onChange(async (value) => {
            this.plugin.settings.storageFolder = value;
            await this.plugin.saveData(this.plugin.settings);
        })
        );
    }
}

// --- Delete Confirmation Modal ---
class DeleteConfirmModal extends Modal {
    constructor(app, onConfirm) {
        super(app);
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Delete Memo' });
        contentEl.createEl('p', { text: 'Are you sure you want to delete this memo? This action cannot be undone.' });

        const btnContainer = contentEl.createDiv({ cls: 'memos-modal-buttons' });

        const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
        confirmBtn.addEventListener('click', () => {
            this.onConfirm();
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ThoughtbinView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.selectedTag = null;
        this.searchQuery = '';
        this.currentTab = 'feed'; // Track current tab (feed vs archive)
    }

    getViewType() {
        return VIEW_TYPE_THOUGHTBIN;
    }

    getDisplayText() {
        return 'Thoughtbin';
    }

    getIcon() {
        return 'message-square';
    }

    async onOpen() {
        await this.renderView();
    }

    async renderView() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('memos-container');

        // 1. Header & Search
        const headerEl = container.createDiv({ cls: 'memos-header' });

        // Title Row and Tabs
        const titleRow = headerEl.createDiv({ cls: 'memos-title-row' });
        titleRow.createEl('h3', { text: 'Thoughtbin', cls: 'memos-title' });

        const tabsEl = titleRow.createDiv({ cls: 'memos-tabs' });
        const feedTab = tabsEl.createEl('button', { text: 'Feed', cls: `memos-tab ${this.currentTab === 'feed' ? 'is-active' : ''}` });
        const archiveTab = tabsEl.createEl('button', { text: 'Archive', cls: `memos-tab ${this.currentTab === 'archive' ? 'is-active' : ''}` });

        feedTab.addEventListener('click', async () => {
            this.currentTab = 'feed';
            feedTab.addClass('is-active');
            archiveTab.removeClass('is-active');
            await this.refreshFeed();
        });

        archiveTab.addEventListener('click', async () => {
            this.currentTab = 'archive';
            archiveTab.addClass('is-active');
            feedTab.removeClass('is-active');
            await this.refreshFeed();
        });

        const searchInput = headerEl.createEl('input', {
            type: 'text',
            placeholder: 'Search memos or #tags...',
            cls: 'memos-search-input',
            value: this.searchQuery
        });

        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.trim().toLowerCase();
            this.refreshFeed();
        });

        // Tag Filter Bar
        this.tagListEl = container.createDiv({ cls: 'memos-tag-list' });

        // 2. Composer (Input Area with Auto-Expand)
        const composerEl = container.createDiv({ cls: 'memos-composer' });
        const textarea = composerEl.createEl('textarea', {
            cls: 'memos-textarea',
            placeholder: 'What is on your mind? Markdown & #tags supported...'
        });

        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
            if (textarea.scrollHeight > 400) {
                textarea.style.overflowY = 'auto';
            } else {
                textarea.style.overflowY = 'hidden';
            }
        };

        textarea.addEventListener('input', autoResize);

        const toolbar = composerEl.createDiv({ cls: 'memos-composer-toolbar' });
        toolbar.createSpan({
            text: 'Ctrl+Enter / Cmd+Enter to send',
            cls: 'memos-composer-shortcuts'
        });

        const submitBtn = toolbar.createEl('button', {
            text: 'Save Memo',
            cls: 'memos-submit-btn'
        });

        const handleCreateMemo = async () => {
            const content = textarea.value.trim();
            if (!content) {
                new Notice('Memo cannot be empty');
                return;
            }
            await this.saveMemo(content);
            textarea.value = '';
            autoResize();
            await this.refreshFeed();
        };

        submitBtn.addEventListener('click', handleCreateMemo);

        textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleCreateMemo();
            }
        });

        // 3. Memos Stream / Feed Container
        this.feedEl = container.createDiv({ cls: 'memos-feed' });

        await this.refreshFeed();
    }

    async saveMemo(content) {
        const folderPath = this.plugin.settings.storageFolder;
        const exists = this.app.vault.getAbstractFileByPath(folderPath);
        if (!exists) {
            await this.app.vault.createFolder(folderPath);
        }

        const now = new Date();
        const timestamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        ].join('-') + '_' + [
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0')
        ].join('');

        const fileName = `${folderPath}/memo_${timestamp}.md`;
        await this.app.vault.create(fileName, content);
        new Notice('Memo saved to Thoughtbin!');
    }

    async getMemos() {
        const folderPath = this.plugin.settings.storageFolder;
        const files = this.app.vault.getMarkdownFiles();
        const memoFiles = files.filter(file => file.path.startsWith(folderPath + '/'));

        memoFiles.sort((a, b) => b.stat.ctime - a.stat.ctime);

        const memos = [];
        for (const file of memoFiles) {
            const content = await this.app.vault.read(file);
            memos.push({ file, content });
        }
        return memos;
    }

    async refreshFeed() {
        this.feedEl.empty();
        this.tagListEl.empty();

        const memos = await this.getMemos();

        const allTags = new Set();
        memos.forEach(m => {
            const matchedTags = m.content.match(/#([\w\u4e00-\u9fa5]+)/g) || [];
            matchedTags.forEach(t => allTags.add(t));
        });

        if (allTags.size > 0) {
            const allChip = this.tagListEl.createSpan({
                text: 'All',
                cls: `memos-filter-tag ${this.selectedTag === null ? 'is-active' : ''}`
            });
            allChip.addEventListener('click', () => {
                this.selectedTag = null;
                this.refreshFeed();
            });

            allTags.forEach(tag => {
                const tagChip = this.tagListEl.createSpan({
                    text: tag,
                    cls: `memos-filter-tag ${this.selectedTag === tag ? 'is-active' : ''}`
                });
                tagChip.addEventListener('click', () => {
                    this.selectedTag = this.selectedTag === tag ? null : tag;
                    this.refreshFeed();
                });
            });
        }

        const filteredMemos = memos.filter(({ file, content }) => {
            // Filter by archive status
            const cache = this.app.metadataCache.getFileCache(file);
            const isArchived = cache?.frontmatter?.archived === true;

            if (this.currentTab === 'feed' && isArchived) return false;
            if (this.currentTab === 'archive' && !isArchived) return false;

            const lower = content.toLowerCase();
            const matchesSearch = !this.searchQuery || lower.includes(this.searchQuery);
            const matchesTag = !this.selectedTag || lower.includes(this.selectedTag.toLowerCase());
            return matchesSearch && matchesTag;
        });

        if (filteredMemos.length === 0) {
            this.feedEl.createDiv({
                cls: 'memos-empty-feed',
                text: this.currentTab === 'archive' ? 'No archived memos.' : 'No memos found.'
            });
            return;
        }

        for (const { file, content } of filteredMemos) {
            const card = this.feedEl.createDiv({ cls: 'memos-card' });

            // Header
            const header = card.createDiv({ cls: 'memos-card-header' });
            const timeStr = new Date(file.stat.ctime).toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            header.createSpan({ text: timeStr, cls: 'memos-card-time' });

            // Actions
            const actions = header.createDiv({ cls: 'memos-card-actions' });

            // Archive/Unarchive button
            const archiveBtn = actions.createEl('button', {
                cls: 'memos-icon-btn',
                title: this.currentTab === 'feed' ? 'Archive memo' : 'Unarchive memo'
            });
            setIcon(archiveBtn, this.currentTab === 'feed' ? 'archive' : 'archive-restore');
            archiveBtn.addEventListener('click', async () => {
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    frontmatter.archived = this.currentTab === 'feed';
                });
                new Notice(this.currentTab === 'feed' ? 'Memo archived' : 'Memo unarchived');
                // Give Obsidian a brief moment to update the file cache before refreshing
                setTimeout(() => this.refreshFeed(), 150);
            });

            const openBtn = actions.createEl('button', {
                cls: 'memos-icon-btn',
                title: 'Open in editor'
            });
            setIcon(openBtn, 'file-text');
            openBtn.addEventListener('click', async () => {
                await this.app.workspace.getLeaf().openFile(file);
            });

            // Delete memo button (Updated to use Modal)
            const deleteBtn = actions.createEl('button', {
                cls: 'memos-icon-btn is-danger',
                title: 'Delete memo'
            });
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.addEventListener('click', () => {
                new DeleteConfirmModal(this.app, async () => {
                    await this.app.vault.trash(file, true);
                    new Notice('Memo deleted');
                    await this.refreshFeed();
                }).open();
            });

            // Render Markdown
            const contentEl = card.createDiv({ cls: 'memos-card-content' });
            await MarkdownRenderer.render(
                this.app,
                content,
                contentEl,
                file.path,
                this
            );
        }
    }
}

module.exports = class ThoughtbinPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Register the settings tab
        this.addSettingTab(new ThoughtbinSettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_THOUGHTBIN,
            (leaf) => new ThoughtbinView(leaf, this)
        );

        this.addRibbonIcon('message-square', 'Open Thoughtbin', () => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-thoughtbin-feed',
            name: 'Open Thoughtbin Feed',
            callback: () => {
                this.activateView();
            }
        });
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_THOUGHTBIN)[0];

        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_THOUGHTBIN, active: true });
            }
        }
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_THOUGHTBIN);
    }
};
