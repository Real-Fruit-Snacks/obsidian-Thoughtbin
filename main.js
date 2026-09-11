'use strict';

const obsidian = require('obsidian');
const {
  Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, TFile,
  MarkdownRenderer, Menu, Component, normalizePath, moment, setIcon, debounce, Platform, Keymap,
} = obsidian;

const VIEW_TYPE = 'thoughtbin';

const DEFAULT_SETTINGS = {
  memosFolder: 'Thoughtbin',
  attachmentsFolder: 'Thoughtbin/attachments',
  filenameFormat: 'YYYY-MM-DD HHmmss',
  pageSize: 30,
  viewLocation: 'tab', // 'tab' | 'right' | 'left'
  sidebarCollapsed: false,
  openOnStartup: false,
  defaultCodeLanguage: '',
  saveWithEnter: false,
  composerTemplate: '',
  timeDisplay: 'relative', // 'relative' | 'absolute'
  dateFormat: 'MMM D, YYYY HH:mm',
  sortOrder: 'newest', // 'newest' | 'oldest'
  pinnedFirst: true,
  firstDayOfWeek: 'locale', // 'locale' | 'sunday' | 'monday'
  showTagStrip: true,
  confirmDelete: true,
  collapseLongThoughts: 0, // px, 0 = never collapse
};

const TAG_RE = /(^|[\s(\[])#([\p{L}\p{N}_\/-]+)/gu;
const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/gm;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'pdf']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: text.slice(m[0].length) };
}

function buildFile(fm, body) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function extractTags(body) {
  const stripped = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const tags = new Set();
  const re = new RegExp(TAG_RE.source, 'gu');
  let m;
  while ((m = re.exec(stripped))) tags.add(m[2]);
  return [...tags];
}

function parseMemo(file, text) {
  const { fm, body } = splitFrontmatter(text);
  const created = fm.created ? moment(fm.created) : null;
  const updated = fm.updated ? moment(fm.updated) : null;
  return {
    file,
    path: file.path,
    created: created && created.isValid() ? created.valueOf() : file.stat.ctime,
    updated: updated && updated.isValid() ? updated.valueOf() : file.stat.mtime,
    pinned: fm.pinned === 'true',
    archived: fm.archived === 'true',
    body: body.replace(/\s+$/, ''),
    tags: extractTags(body),
  };
}

function formatTime(ts, settings) {
  const m = moment(ts);
  const fmt = settings.dateFormat || 'MMM D, YYYY HH:mm';
  if (settings.timeDisplay === 'absolute') return m.format(fmt);
  return moment().diff(m, 'days') < 7 ? m.fromNow() : m.format(fmt);
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|#^\[\]]/g, '-').trim();
}

// ---------------------------------------------------------------------------
// Store: one markdown file per memo, indexed in memory
// ---------------------------------------------------------------------------

class MemoStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.memos = new Map();
    this.listeners = new Set();
    this.ready = false;
    this.emit = debounce(() => this.listeners.forEach((fn) => fn()), 120, true);
  }

  get folder() {
    return normalizePath(this.plugin.settings.memosFolder || 'Thoughtbin');
  }

  isMemoFile(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    return file.path.startsWith(this.folder + '/');
  }

  async loadAll() {
    this.memos.clear();
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.isMemoFile(f));
    await Promise.all(files.map((f) => this.index(f)));
    this.ready = true;
    this.emit();
  }

  async index(file) {
    try {
      const text = await this.app.vault.cachedRead(file);
      this.memos.set(file.path, parseMemo(file, text));
    } catch (e) {
      console.error('Thoughtbin: failed to read', file.path, e);
    }
  }

  remove(path) {
    this.memos.delete(path);
  }

  all() {
    return [...this.memos.values()];
  }

  tagCounts(archived = false) {
    const counts = new Map();
    for (const m of this.memos.values()) {
      if (m.archived !== archived) continue;
      for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  tagNames() {
    const s = new Set();
    for (const m of this.memos.values()) m.tags.forEach((t) => s.add(t));
    return [...s].sort();
  }

  async ensureFolder(path) {
    const parts = normalizePath(path).split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (e) { /* exists */ }
      }
    }
  }

  async create(content) {
    await this.ensureFolder(this.folder);
    const now = moment();
    const base = safeName(now.format(this.plugin.settings.filenameFormat || 'YYYY-MM-DD HHmmss')) || String(now.valueOf());
    let path = normalizePath(`${this.folder}/${base}.md`);
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${this.folder}/${base}-${i++}.md`);
    const text = buildFile(
      { created: now.format(), updated: now.format(), pinned: 'false', archived: 'false' },
      content.trim() + '\n',
    );
    const file = await this.app.vault.create(path, text);
    await this.index(file);
    this.emit();
    return this.memos.get(file.path);
  }

  async updateBody(memo, body) {
    await this.app.vault.process(memo.file, (text) => {
      const { fm } = splitFrontmatter(text);
      fm.updated = moment().format();
      return buildFile(fm, body.trim() + '\n');
    });
    await this.index(memo.file);
    this.emit();
  }

  async setFlags(memo, flags) {
    await this.app.vault.process(memo.file, (text) => {
      const { fm, body } = splitFrontmatter(text);
      for (const [k, v] of Object.entries(flags)) fm[k] = String(v);
      fm.updated = moment().format();
      return buildFile(fm, body);
    });
    await this.index(memo.file);
    this.emit();
  }

  async toggleTask(memo, idx) {
    await this.app.vault.process(memo.file, (text) => {
      const { fm, body } = splitFrontmatter(text);
      let n = -1;
      const nb = body.replace(TASK_RE, (m, a, b, c) => {
        n++;
        if (n !== idx) return m;
        return a + (b === ' ' ? 'x' : ' ') + c;
      });
      return buildFile(fm, nb);
    });
    await this.index(memo.file);
    this.emit();
  }

  async delete(memo) {
    if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(memo.file);
    else await this.app.vault.trash(memo.file, true);
    this.remove(memo.path);
    this.emit();
  }

  async saveAttachment(file) {
    const folder = normalizePath(this.plugin.settings.attachmentsFolder || `${this.folder}/attachments`);
    await this.ensureFolder(folder);
    const name = safeName(file.name) || 'attachment';
    let path = normalizePath(`${folder}/${moment().format('YYYYMMDD-HHmmss')}-${name}`);
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${moment().format('YYYYMMDD-HHmmss')}-${i++}-${name}`);
    const buf = await file.arrayBuffer();
    const tf = await this.app.vault.createBinary(path, buf);
    const link = this.app.fileManager.generateMarkdownLink(tf, `${this.folder}/memo.md`);
    const isEmbed = IMAGE_EXT.has(tf.extension.toLowerCase());
    return isEmbed && !link.startsWith('!') ? `!${link}` : link;
  }
}

// ---------------------------------------------------------------------------
// Live-styled markdown editor (CodeMirror 6, provided by Obsidian) with a
// plain-textarea fallback.
// ---------------------------------------------------------------------------

let CM = null;
try {
  CM = {
    state: require('@codemirror/state'),
    view: require('@codemirror/view'),
    commands: require('@codemirror/commands'),
  };
  try { CM.autocomplete = require('@codemirror/autocomplete'); } catch (e) { CM.autocomplete = null; }
} catch (e) {
  CM = null;
}

function liveMarkdownExtension() {
  const { Decoration, ViewPlugin, WidgetType, EditorView } = CM.view;

  class CheckboxWidget extends WidgetType {
    constructor(pos, checked) { super(); this.pos = pos; this.checked = checked; }
    eq(o) { return o.checked === this.checked && o.pos === this.pos; }
    toDOM(view) {
      const wrap = document.createElement('span');
      wrap.className = 'tb-checkbox';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.checked;
      cb.addEventListener('mousedown', (e) => e.preventDefault());
      cb.addEventListener('click', (e) => {
        e.preventDefault();
        view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' } });
      });
      wrap.appendChild(cb);
      return wrap;
    }
    ignoreEvent() { return false; }
  }

  class TextWidget extends WidgetType {
    constructor(text, cls) { super(); this.text = text; this.cls = cls; }
    eq(o) { return o.text === this.text && o.cls === this.cls; }
    toDOM() { const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
  }

  const mark = (cls) => Decoration.mark({ class: cls });
  const hide = Decoration.replace({});
  const lineDeco = (cls) => Decoration.line({ class: cls });

  const INLINE = [
    { re: /`[^`\n]+`/g, cls: 'tb-code', m: 1, code: true },
    { re: /\*\*[^*\n]+\*\*/g, cls: 'tb-bold', m: 2 },
    { re: /__[^_\n]+__/g, cls: 'tb-bold', m: 2 },
    { re: /~~[^~\n]+~~/g, cls: 'tb-strike', m: 2 },
    { re: /==[^=\n]+==/g, cls: 'tb-highlight', m: 2 },
    { re: /(?<![*\w])\*[^*\n]+\*(?!\*)/g, cls: 'tb-italic', m: 1 },
    { re: /(?<![_\w])_[^_\n]+_(?![_\w])/g, cls: 'tb-italic', m: 1 },
  ];
  const TAG = /(?:^|[\s(\[])(#[\p{L}\p{N}_\/-]+)/gu;
  const WIKILINK = /!?\[\[[^\]\n]+\]\]/g;
  const MDLINK = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  const URL = /https?:\/\/[^\s<>)\]]+/g;

  function build(view) {
    const decos = [];
    const doc = view.state.doc;
    const cursorLines = new Set();
    for (const r of view.state.selection.ranges) {
      const a = doc.lineAt(r.from).number, b = doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) cursorLines.add(n);
    }
    const focused = view.hasFocus;

    // Fenced code detection over the whole doc (cheap for memo-sized text)
    let inFence = false;
    const fenceLines = new Set();
    const fenceMarkers = new Set();
    for (let n = 1; n <= doc.lines; n++) {
      const t = doc.line(n).text;
      if (/^\s*(```|~~~)/.test(t)) { fenceMarkers.add(n); inFence = !inFence; continue; }
      if (inFence) fenceLines.add(n);
    }

    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const text = line.text;
      const active = focused && cursorLines.has(n);
      const add = (from, to, d) => decos.push(d.range(line.from + from, line.from + to));

      if (fenceMarkers.has(n)) { decos.push(lineDeco('tb-line-fence').range(line.from)); if (!active) add(0, text.length, mark('tb-fence-marker')); continue; }
      if (fenceLines.has(n)) { decos.push(lineDeco('tb-line-code').range(line.from)); continue; }

      const skip = [];
      const overlaps = (a, b) => skip.some(([x, y]) => a < y && b > x);
      let m;

      // Block-level
      if ((m = text.match(/^(#{1,6})\s+/))) {
        decos.push(lineDeco('tb-line-h tb-h' + m[1].length).range(line.from));
        add(0, m[0].length, active ? mark('tb-marker') : hide);
      } else if ((m = text.match(/^>\s?/))) {
        decos.push(lineDeco('tb-line-quote').range(line.from));
        add(0, m[0].length, active ? mark('tb-marker') : hide);
      } else if ((m = text.match(/^(\s*)([-*+])\s+\[([ xX])\]\s?/))) {
        const checked = m[3] !== ' ';
        decos.push(lineDeco('tb-line-task' + (checked ? ' tb-done' : '')).range(line.from));
        const boxPos = line.from + m[1].length + m[2].length + 2;
        if (!active) {
          add(m[1].length, m[0].length, Decoration.replace({ widget: new CheckboxWidget(boxPos, checked) }));
        } else {
          add(m[1].length, m[0].length, mark('tb-marker'));
        }
      } else if ((m = text.match(/^(\s*)([-*+])\s+/))) {
        decos.push(lineDeco('tb-line-list').range(line.from));
        const s = m[1].length, e = s + 1;
        add(s, e, active ? mark('tb-marker') : Decoration.replace({ widget: new TextWidget('•', 'tb-bullet') }));
      } else if ((m = text.match(/^(\s*)(\d+)[.)]\s+/))) {
        decos.push(lineDeco('tb-line-list').range(line.from));
        add(m[1].length, m[0].length, mark('tb-num'));
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
        decos.push(lineDeco('tb-line-hr').range(line.from));
      }

      // Inline code first so nothing styles inside it
      for (const spec of INLINE) {
        spec.re.lastIndex = 0;
        while ((m = spec.re.exec(text))) {
          const a = m.index, b = a + m[0].length;
          if (overlaps(a, b)) continue;
          if (spec.code) skip.push([a, b]);
          add(a, b, mark(spec.cls));
          if (!spec.code) {
            add(a, a + spec.m, active ? mark('tb-marker') : hide);
            add(b - spec.m, b, active ? mark('tb-marker') : hide);
          } else {
            add(a, a + 1, active ? mark('tb-marker') : hide);
            add(b - 1, b, active ? mark('tb-marker') : hide);
          }
          skip.push([a, b]);
        }
      }
      WIKILINK.lastIndex = 0;
      while ((m = WIKILINK.exec(text))) {
        const a = m.index, b = a + m[0].length;
        if (overlaps(a, b)) continue;
        add(a, b, mark('tb-link'));
        const open = m[0].startsWith('!') ? 3 : 2;
        add(a, a + open, active ? mark('tb-marker') : hide);
        add(b - 2, b, active ? mark('tb-marker') : hide);
        skip.push([a, b]);
      }
      MDLINK.lastIndex = 0;
      while ((m = MDLINK.exec(text))) {
        const a = m.index, b = a + m[0].length;
        if (overlaps(a, b)) continue;
        const labelEnd = a + 1 + m[1].length;
        add(a, a + 1, active ? mark('tb-marker') : hide);
        add(a + 1, labelEnd, mark('tb-link'));
        add(labelEnd, b, active ? mark('tb-marker tb-url') : hide);
        skip.push([a, b]);
      }
      TAG.lastIndex = 0;
      while ((m = TAG.exec(text))) {
        const a = m.index + m[0].length - m[1].length, b = a + m[1].length;
        if (overlaps(a, b)) continue;
        add(a, b, mark('tb-tag'));
        skip.push([a, b]);
      }
      URL.lastIndex = 0;
      while ((m = URL.exec(text))) {
        const a = m.index, b = a + m[0].length;
        if (overlaps(a, b)) continue;
        add(a, b, mark('tb-url'));
      }
    }
    return Decoration.set(decos, true);
  }

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) {
      if (u.docChanged || u.selectionSet || u.focusChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  }, { decorations: (v) => v.decorations });

  return [plugin, EditorView.lineWrapping];
}

// Continue "- ", "1. ", "- [ ] " and "> " on Enter; an empty item ends the list.
function continueListOnEnter(view) {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) return false;
  const line = state.doc.lineAt(r.from);
  if (r.from !== line.to) return false;
  const text = line.text;
  let m;
  if ((m = text.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/))) {
    const [, indent, marker, sp, task, rest] = m;
    if (!rest.trim()) {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    const next = /^\d+/.test(marker) ? (parseInt(marker, 10) + 1) + marker.slice(-1) : marker;
    const insert = '\n' + indent + next + sp + (task ? '[ ] ' : '');
    view.dispatch({ changes: { from: r.from, insert }, selection: { anchor: r.from + insert.length } });
    return true;
  }
  if ((m = text.match(/^(>\s?)(.*)$/))) {
    if (!m[2].trim()) {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    const insert = '\n' + m[1];
    view.dispatch({ changes: { from: r.from, insert }, selection: { anchor: r.from + insert.length } });
    return true;
  }
  return false;
}

function toggleWrap(view, wrap) {
  const { state } = view;
  const r = state.selection.main;
  const sel = state.sliceDoc(r.from, r.to);
  const w = wrap.length;
  const before = state.sliceDoc(Math.max(0, r.from - w), r.from);
  const after = state.sliceDoc(r.to, Math.min(state.doc.length, r.to + w));
  if (before === wrap && after === wrap) {
    view.dispatch({ changes: [{ from: r.from - w, to: r.from, insert: '' }, { from: r.to, to: r.to + w, insert: '' }],
      selection: { anchor: r.from - w, head: r.to - w } });
  } else if (sel.startsWith(wrap) && sel.endsWith(wrap) && sel.length >= 2 * w) {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: sel.slice(w, -w) }, selection: { anchor: r.from, head: r.to - 2 * w } });
  } else {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: wrap + sel + wrap }, selection: { anchor: r.from + w, head: r.to + w } });
  }
  return true;
}

function insertLink(view) {
  const { state } = view;
  const r = state.selection.main;
  const sel = state.sliceDoc(r.from, r.to);
  if (/^https?:\/\//.test(sel)) {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `[](${sel})` }, selection: { anchor: r.from + 1 } });
  } else {
    const text = `[${sel}]()`;
    view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length - 1 } });
  }
  return true;
}

class MemoEditor {
  constructor(plugin, containerEl, opts = {}) {
    this.plugin = plugin;
    this.opts = opts;
    this.suggestItems = [];
    this.suggestIndex = 0;
    this.build(containerEl);
  }

  build(containerEl) {
    this.el = containerEl.createDiv('memo-editor');
    const inputHost = this.el.createDiv('memo-editor-host');
    const placeholder = this.opts.placeholder || "What's on your mind...";

    if (CM) {
      this.buildCodeMirror(inputHost, placeholder);
    } else {
      this.buildTextarea(inputHost, placeholder);
    }

    this.suggestEl = this.el.createDiv('memo-suggest');
    this.suggestEl.hide();

    const bar = this.el.createDiv('memo-editor-bar');
    const left = bar.createDiv('memo-editor-tools');
    this.tool(left, 'hash', 'Add tag', () => this.insert('#', true));
    this.tool(left, 'check-square', 'Add task', () => this.insertLine('- [ ] '));
    this.tool(left, 'list', 'Add list', () => this.insertLine('- '));
    this.tool(left, 'code', 'Code block', () => this.insertBlock('```' + (this.plugin.settings.defaultCodeLanguage || '').trim() + '\n', '\n```'));
    this.tool(left, 'paperclip', 'Attach file', () => this.fileInput.click());
    this.fileInput = left.createEl('input', { type: 'file', attr: { multiple: '', hidden: '' } });
    this.fileInput.addEventListener('change', () => {
      this.handleFiles(this.fileInput.files);
      this.fileInput.value = '';
    });

    const right = bar.createDiv('memo-editor-actions');
    if (this.opts.onCancel) {
      const cancel = right.createEl('button', { text: 'Cancel' });
      cancel.addEventListener('click', () => this.opts.onCancel());
    }
    if (!Platform.isMobile) {
      const mod = Platform.isMacOS ? '⌘' : 'Ctrl+';
      const hint = this.plugin.settings.saveWithEnter ? 'Enter to save · Shift+Enter for new line' : `${mod}Enter to save`;
      right.createSpan({ cls: 'memo-editor-hint', text: hint });
    }
    this.saveBtn = right.createEl('button', { cls: 'mod-cta', text: this.opts.saveLabel || 'Save' });
    this.saveBtn.addEventListener('click', () => this.save());

    if (this.opts.autofocus) this.focus(true);
  }

  // ---- CodeMirror backend -------------------------------------------------

  buildCodeMirror(host, placeholderText) {
    const { EditorState, Prec } = CM.state;
    const { EditorView, keymap, placeholder, drawSelection } = CM.view;
    const { history, historyKeymap, defaultKeymap, indentWithTab, insertNewlineAndIndent } = CM.commands;

    const suggestKeys = Prec.highest(keymap.of([
      { key: 'ArrowDown', run: () => this.suggestVisible() && (this.moveSuggest(1), true) },
      { key: 'ArrowUp', run: () => this.suggestVisible() && (this.moveSuggest(-1), true) },
      { key: 'Enter', run: (view) => {
        if (this.suggestVisible()) { this.applySuggest(this.suggestItems[this.suggestIndex]); return true; }
        if (this.plugin.settings.saveWithEnter) { this.save(); return true; }
        return continueListOnEnter(view);
      } },
      { key: 'Shift-Enter', run: (view) => continueListOnEnter(view) || insertNewlineAndIndent(view) },
      { key: 'Mod-b', run: (view) => toggleWrap(view, '**') },
      { key: 'Mod-i', run: (view) => toggleWrap(view, '*') },
      { key: 'Mod-k', run: insertLink },
      { key: 'Tab', run: () => this.suggestVisible() && (this.applySuggest(this.suggestItems[this.suggestIndex]), true) },
      { key: 'Escape', run: () => {
        if (this.suggestVisible()) { this.hideSuggest(); return true; }
        if (this.opts.onCancel) { this.opts.onCancel(); return true; }
        return false;
      } },
      { key: 'Mod-Enter', run: () => { this.save(); return true; } },
    ]));

    const handlers = EditorView.domEventHandlers({
      click: (e, view) => {
        if (!Keymap.isModEvent(e)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        const re = /\[\[([^\]\n]+)\]\]/g;
        let m;
        while ((m = re.exec(line.text))) {
          const a = line.from + m.index, b = a + m[0].length;
          if (pos >= a && pos <= b) {
            e.preventDefault();
            const target = m[1].split('|')[0];
            this.plugin.app.workspace.openLinkText(target, `${this.plugin.store.folder}/memo.md`, true);
            return true;
          }
        }
        return false;
      },
      paste: (e) => {
        const files = e.clipboardData && e.clipboardData.files;
        if (files && files.length) { e.preventDefault(); this.handleFiles(files); return true; }
        return false;
      },
      drop: (e) => {
        this.el.removeClass('is-dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) { e.preventDefault(); this.handleFiles(files); return true; }
        return false;
      },
      dragover: (e) => { this.el.addClass('is-dragover'); return false; },
      dragleave: () => { this.el.removeClass('is-dragover'); return false; },
      blur: () => { setTimeout(() => this.hideSuggest(), 150); return false; },
    });

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) this.updateSuggest();
    });

    this.cm = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: this.opts.initial || '',
        extensions: [
          suggestKeys,
          history(),
          drawSelection(),
          keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
          placeholder(placeholderText),
          CM.autocomplete ? [CM.autocomplete.closeBrackets(), keymap.of(CM.autocomplete.closeBracketsKeymap)] : [],
          liveMarkdownExtension(),
          handlers,
          updateListener,
          EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
          EditorView.theme({}, { dark: false }),
        ],
      }),
    });
    this.cm.dom.addClass('tb-cm');
  }

  // ---- textarea fallback --------------------------------------------------

  buildTextarea(host, placeholderText) {
    this.textarea = host.createEl('textarea', {
      cls: 'memo-editor-input',
      attr: { placeholder: placeholderText, rows: '3' },
    });
    this.textarea.value = this.opts.initial || '';
    const ta = this.textarea;
    const resize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 72), 480) + 'px'; };
    this.resize = resize;
    ta.addEventListener('input', () => { resize(); this.updateSuggest(); });
    ta.addEventListener('click', () => this.updateSuggest());
    ta.addEventListener('keydown', (e) => {
      if (this.suggestVisible()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSuggest(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this.moveSuggest(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.applySuggest(this.suggestItems[this.suggestIndex]); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.hideSuggest(); return; }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (this.plugin.settings.saveWithEnter && !e.shiftKey))) { e.preventDefault(); this.save(); return; }
      if (e.key === 'Escape' && this.opts.onCancel) { e.preventDefault(); this.opts.onCancel(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => this.hideSuggest(), 150));
    ta.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); this.handleFiles(files); }
    });
    ta.addEventListener('dragover', (e) => { e.preventDefault(); this.el.addClass('is-dragover'); });
    ta.addEventListener('dragleave', () => this.el.removeClass('is-dragover'));
    ta.addEventListener('drop', (e) => {
      this.el.removeClass('is-dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) { e.preventDefault(); this.handleFiles(files); }
    });
    resize();
  }

  // ---- backend-agnostic accessors ----------------------------------------

  getValue() { return this.cm ? this.cm.state.doc.toString() : this.textarea.value; }

  setValue(v) {
    if (this.cm) this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: v } });
    else { this.textarea.value = v; this.resize(); }
  }

  cursor() {
    if (this.cm) { const r = this.cm.state.selection.main; return { from: r.from, to: r.to }; }
    return { from: this.textarea.selectionStart, to: this.textarea.selectionEnd };
  }

  replaceRange(from, to, text, cursorAt) {
    const pos = cursorAt == null ? from + text.length : cursorAt;
    if (this.cm) {
      this.cm.dispatch({ changes: { from, to, insert: text }, selection: { anchor: pos } });
    } else {
      const v = this.textarea.value;
      this.textarea.value = v.slice(0, from) + text + v.slice(to);
      this.textarea.selectionStart = this.textarea.selectionEnd = pos;
      this.resize();
    }
  }

  focus(toEnd = false) {
    if (this.cm) {
      this.cm.focus();
      if (toEnd) { const end = this.cm.state.doc.length; this.cm.dispatch({ selection: { anchor: end } }); }
    } else {
      this.textarea.focus();
      if (toEnd) this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
    }
  }

  insert(text, thenSuggest = false) {
    const { from, to } = this.cursor();
    this.replaceRange(from, to, text);
    this.focus();
    if (thenSuggest) this.updateSuggest();
  }

  insertLine(text) {
    const { from } = this.cursor();
    const v = this.getValue();
    const atLineStart = from === 0 || v[from - 1] === '\n';
    this.insert((atLineStart ? '' : '\n') + text);
  }

  insertBlock(before, after) {
    const { from, to } = this.cursor();
    const v = this.getValue();
    const sel = v.slice(from, to);
    const lead = from === 0 || v[from - 1] === '\n' ? '' : '\n';
    const text = lead + before + sel + after + '\n';
    this.replaceRange(from, to, text, from + lead.length + before.length + sel.length);
    this.focus();
  }

  tool(parent, icon, label, onClick) {
    const b = parent.createEl('button', { cls: 'clickable-icon memo-tool', attr: { 'aria-label': label } });
    setIcon(b, icon);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  }

  async handleFiles(files) {
    for (const f of files) {
      try {
        const link = await this.plugin.store.saveAttachment(f);
        this.insertLine(link + '\n');
      } catch (e) {
        console.error(e);
        new Notice(`Could not attach ${f.name}`);
      }
    }
  }

  // ---- tag suggestions ----------------------------------------------------

  suggestVisible() { return this.suggestEl.isShown(); }

  updateSuggest() {
    const { from, to } = this.cursor();
    if (from !== to) return this.hideSuggest();
    const value = this.getValue();
    const before = value.slice(0, from);
    let m;

    // [[wikilink autocomplete
    if ((m = before.match(/\[\[([^\[\]\n]*)$/))) {
      const q = m[1];
      const items = this.linkCandidates(q).map((file) => {
        const isMd = file.extension === 'md';
        return {
          label: isMd ? file.basename : file.name,
          detail: file.parent && file.parent.path !== '/' ? file.parent.path : '',
          icon: isMd ? 'file-text' : 'paperclip',
          apply: () => {
            const src = `${this.plugin.store.folder}/memo.md`;
            const text = this.plugin.app.metadataCache.fileToLinktext(file, src, true);
            const after = this.getValue().slice(this.cursor().from);
            const closing = after.startsWith(']]') ? '' : ']]';
            const start = from - q.length;
            this.replaceRange(start, from, text + closing, start + text.length + 2);
          },
        };
      });
      return this.showSuggest(items);
    }

    // #tag autocomplete
    if ((m = before.match(/(?:^|[\s(\[])#([\p{L}\p{N}_\/-]*)$/u))) {
      const prefix = m[1];
      const lower = prefix.toLowerCase();
      const items = this.plugin.store.tagNames()
        .filter((t) => t.toLowerCase().startsWith(lower) && t !== prefix)
        .slice(0, 8)
        .map((t) => ({
          label: '#' + t,
          icon: 'hash',
          apply: () => this.replaceRange(from - prefix.length, from, t + ' '),
        }));
      return this.showSuggest(items);
    }

    this.hideSuggest();
  }

  linkCandidates(q) {
    const files = this.plugin.app.vault.getFiles();
    const query = q.trim().toLowerCase();
    const scored = [];
    for (const f of files) {
      const name = (f.extension === 'md' ? f.basename : f.name).toLowerCase();
      const path = f.path.toLowerCase();
      let score;
      if (!query) score = 3;
      else if (name === query) score = 0;
      else if (name.startsWith(query)) score = 1;
      else if (name.includes(query)) score = 2;
      else if (path.includes(query)) score = 4;
      else continue;
      if (f.extension !== 'md') score += 0.5;
      scored.push({ f, score, mtime: f.stat.mtime });
    }
    scored.sort((a, b) => a.score - b.score || b.mtime - a.mtime || a.f.path.localeCompare(b.f.path));
    return scored.slice(0, 10).map((x) => x.f);
  }

  showSuggest(items) {
    if (!items.length) return this.hideSuggest();
    this.suggestItems = items;
    this.suggestIndex = 0;
    this.renderSuggest();
    this.suggestEl.show();
  }

  renderSuggest() {
    this.suggestEl.empty();
    this.suggestItems.forEach((it, i) => {
      const item = this.suggestEl.createDiv({ cls: 'memo-suggest-item' });
      if (it.icon) setIcon(item.createSpan('memo-suggest-icon'), it.icon);
      item.createSpan({ cls: 'memo-suggest-label', text: it.label });
      if (it.detail) item.createSpan({ cls: 'memo-suggest-detail', text: it.detail });
      if (i === this.suggestIndex) item.addClass('is-selected');
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this.applySuggest(it); });
    });
    const sel = this.suggestEl.querySelector('.is-selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  moveSuggest(d) {
    this.suggestIndex = (this.suggestIndex + d + this.suggestItems.length) % this.suggestItems.length;
    this.renderSuggest();
  }

  applySuggest(item) {
    if (!item) return;
    this.hideSuggest();
    item.apply();
    this.focus();
  }

  hideSuggest() { this.suggestEl.hide(); }

  // ---- save / lifecycle ---------------------------------------------------

  async save() {
    const v = this.getValue().trim();
    if (!v) { new Notice('Thought is empty'); return; }
    this.saveBtn.disabled = true;
    try {
      await this.opts.onSave(v);
      if (this.opts.clearOnSave) { const t = this.opts.template || ''; this.setValue(t); this.focus(true); }
    } catch (e) {
      console.error(e);
      new Notice('Could not save thought');
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  destroy() {
    if (this.cm) this.cm.destroy();
    this.el.remove();
  }
}

class QuickCaptureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    this.modalEl.addClass('memos-modal');
    this.titleEl.setText('New thought');
    this.editor = new MemoEditor(this.plugin, this.contentEl, {
      autofocus: true,
      initial: this.plugin.settings.composerTemplate || '',
      onSave: async (text) => {
        await this.plugin.store.create(text);
        new Notice('Thought saved');
        this.close();
      },
      onCancel: () => this.close(),
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, body, onConfirm) {
    super(app);
    this.t = title; this.b = body; this.onConfirm = onConfirm;
  }
  onOpen() {
    this.titleEl.setText(this.t);
    this.contentEl.createEl('p', { text: this.b });
    const row = this.contentEl.createDiv('modal-button-container');
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    row.createEl('button', { cls: 'mod-warning', text: 'Delete' }).addEventListener('click', () => { this.close(); this.onConfirm(); });
  }
  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Timeline view
// ---------------------------------------------------------------------------

class MemosView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.filter = { tag: null, date: null, query: '', archived: false };
    this.limit = plugin.settings.pageSize;
    this.calMonth = moment().startOf('month');
    this.editingCount = 0;
    this.pendingRefresh = false;
    this.cardComponents = [];
    this.onStore = () => this.refresh();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Thoughtbin'; }
  getIcon() { return 'brain'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('memos-view');
    const layout = root.createDiv('memos-layout');
    this.layoutEl = layout;
    if (!Platform.isMobile && this.plugin.settings.sidebarCollapsed) layout.addClass('sidebar-hidden');
    this.sidebarEl = layout.createDiv('memos-sidebar');
    const main = layout.createDiv('memos-main');

    // Header: search
    const header = main.createDiv('memos-header');
    const search = header.createDiv('memos-search');
    setIcon(search.createSpan('memos-search-icon'), 'search');
    this.searchInput = search.createEl('input', { type: 'text', attr: { placeholder: 'Search thoughts', enterkeyhint: 'search', autocomplete: 'off' } });
    const clearBtn = search.createEl('button', { cls: 'clickable-icon memos-search-clear', attr: { 'aria-label': 'Clear search' } });
    setIcon(clearBtn, 'x');
    clearBtn.hide();
    const applySearch = debounce(() => {
      this.filter.query = this.searchInput.value.trim();
      this.limit = this.plugin.settings.pageSize;
      this.renderChips();
      this.renderList();
    }, 200, true);
    this.searchInput.addEventListener('input', () => { clearBtn.toggle(!!this.searchInput.value); applySearch(); });
    clearBtn.addEventListener('click', () => { this.searchInput.value = ''; clearBtn.hide(); this.filter.query = ''; this.refresh(); });
    this.searchClearBtn = clearBtn;
    const sidebarToggle = header.createEl('button', { cls: 'clickable-icon memos-sidebar-toggle', attr: { 'aria-label': 'Toggle sidebar' } });
    setIcon(sidebarToggle, 'panel-left');
    sidebarToggle.addEventListener('click', () => this.toggleSidebar());

    // Composer
    this.composerEl = main.createDiv('memos-composer');
    this.composer = new MemoEditor(this.plugin, this.composerEl, {
      clearOnSave: true,
      initial: this.plugin.settings.composerTemplate || '',
      template: this.plugin.settings.composerTemplate || '',
      onSave: async (text) => {
        await this.store.create(text);
        new Notice('Thought saved');
      },
    });

    this.chipsEl = main.createDiv('memos-chips');
    this.stripEl = main.createDiv('memos-tagstrip');
    this.contextEl = main.createDiv('memos-context');
    this.listEl = main.createDiv('memos-list');
    this.moreEl = main.createDiv('memos-more');

    this.store.listeners.add(this.onStore);
    this.refresh();
  }

  async onClose() {
    this.store.listeners.delete(this.onStore);
    this.closeDrawer(true);
    if (this.composer) this.composer.destroy();
    this.unloadCards();
  }

  toggleSidebar() {
    if (Platform.isMobile) { this.overlayEl ? this.closeDrawer() : this.openDrawer(); return; }
    const hidden = !this.layoutEl.hasClass('sidebar-hidden');
    this.layoutEl.toggleClass('sidebar-hidden', hidden);
    this.plugin.settings.sidebarCollapsed = hidden;
    this.plugin.saveData(this.plugin.settings);
  }

  openDrawer() {
    if (this.overlayEl) return;
    const overlay = document.body.createDiv('memos-overlay');
    overlay.addClass(document.body.hasClass('theme-dark') ? 'theme-dark' : 'theme-light');
    const backdrop = overlay.createDiv('memos-backdrop');
    backdrop.addEventListener('click', () => this.closeDrawer());
    overlay.appendChild(this.sidebarEl);
    this.overlayEl = overlay;
    this.renderSidebar();
    requestAnimationFrame(() => overlay.addClass('is-open'));
  }

  closeDrawer(immediate = false) {
    const overlay = this.overlayEl;
    if (!overlay) return;
    this.overlayEl = null;
    const finish = () => {
      if (this.layoutEl && this.sidebarEl) this.layoutEl.insertBefore(this.sidebarEl, this.layoutEl.firstChild);
      overlay.remove();
    };
    if (immediate) { finish(); return; }
    overlay.removeClass('is-open');
    setTimeout(finish, 240);
  }

  unloadCards() {
    for (const c of this.cardComponents) this.removeChild(c);
    this.cardComponents = [];
  }

  refresh() {
    if (this.editingCount > 0) { this.pendingRefresh = true; return; }
    this.pendingRefresh = false;
    this.renderSidebar();
    this.renderChips();
    this.renderStrip();
    this.renderList();
  }

  // ---- filtering ----------------------------------------------------------

  filtered() {
    const f = this.filter;
    let items = this.store.all().filter((m) => m.archived === f.archived);
    if (f.tag) items = items.filter((m) => m.tags.some((t) => t === f.tag || t.startsWith(f.tag + '/')));
    if (f.date) items = items.filter((m) => moment(m.created).isSame(f.date, 'day'));
    if (f.query) {
      const q = f.query.toLowerCase();
      items = items.filter((m) => m.body.toLowerCase().includes(q));
    }
    const st = this.plugin.settings;
    const dir = st.sortOrder === 'oldest' ? 1 : -1;
    items.sort((a, b) => (st.pinnedFirst && !f.archived ? Number(b.pinned) - Number(a.pinned) : 0) || dir * (a.created - b.created));
    return items;
  }

  setTag(tag) {
    this.filter.tag = this.filter.tag === tag ? null : tag;
    this.closeDrawer();
    this.limit = this.plugin.settings.pageSize;
    this.refresh();
  }

  setDate(day) {
    this.filter.date = this.filter.date && moment(this.filter.date).isSame(day, 'day') ? null : day.valueOf();
    this.closeDrawer();
    this.limit = this.plugin.settings.pageSize;
    this.refresh();
  }

  setArchived(v) {
    this.filter.archived = v;
    this.closeDrawer();
    this.filter.tag = null;
    this.limit = this.plugin.settings.pageSize;
    this.refresh();
  }

  // ---- sidebar ------------------------------------------------------------

  renderSidebar() {
    const el = this.sidebarEl;
    el.empty();

    const top = el.createDiv('memos-sidebar-top');
    top.createSpan({ cls: 'memos-sidebar-title', text: 'Thoughtbin' });
    const close = top.createEl('button', { cls: 'clickable-icon memos-drawer-close', attr: { 'aria-label': 'Close' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.closeDrawer());

    // Navigation
    const nav = el.createDiv('memos-nav');
    const navItem = (icon, label, active, onClick) => {
      const b = nav.createEl('button', { cls: 'memos-nav-item' + (active ? ' is-active' : '') });
      setIcon(b.createSpan('memos-nav-icon'), icon);
      b.createSpan({ text: label });
      b.addEventListener('click', onClick);
    };
    navItem('home', 'Home', !this.filter.archived, () => this.setArchived(false));
    navItem('archive', 'Archived', this.filter.archived, () => this.setArchived(true));

    // Activity calendar
    this.renderCalendar(el.createDiv('memos-calendar'));

    // Stats
    const memos = this.store.all().filter((m) => !m.archived);
    const days = new Set(memos.map((m) => moment(m.created).format('YYYY-MM-DD')));
    const stats = el.createDiv('memos-stats');
    const stat = (n, label) => {
      const s = stats.createDiv('memos-stat');
      s.createDiv({ cls: 'memos-stat-n', text: String(n) });
      s.createDiv({ cls: 'memos-stat-l', text: label });
    };
    const tagN = this.store.tagCounts(false).length;
    stat(memos.length, memos.length === 1 ? 'thought' : 'thoughts');
    stat(tagN, tagN === 1 ? 'tag' : 'tags');
    stat(days.size, days.size === 1 ? 'day' : 'days');

    // Tags
    const tagsBox = el.createDiv('memos-tags');
    const tagsHead = tagsBox.createDiv('memos-section-title');
    tagsHead.setText('Tags');
    const counts = this.store.tagCounts(this.filter.archived);
    if (!counts.length) {
      tagsBox.createDiv({ cls: 'memos-muted', text: 'No tags yet. Type #tag in a thought.' });
    }
    const list = tagsBox.createDiv('memos-tag-list');
    for (const [tag, n] of counts) {
      const t = list.createDiv({ cls: 'memos-tag-item' + (this.filter.tag === tag ? ' is-active' : '') });
      t.createSpan({ cls: 'memos-tag-name', text: '#' + tag });
      t.createSpan({ cls: 'memos-tag-count', text: String(n) });
      t.addEventListener('click', () => this.setTag(tag));
    }
  }

  renderCalendar(el) {
    const month = this.calMonth;
    const head = el.createDiv('memos-cal-head');
    const prev = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Previous month' } });
    setIcon(prev, 'chevron-left');
    prev.addEventListener('click', () => { this.calMonth = moment(month).subtract(1, 'month'); this.renderSidebar(); });
    head.createSpan({ cls: 'memos-cal-title', text: month.format('MMMM YYYY') });
    const next = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Next month' } });
    setIcon(next, 'chevron-right');
    next.addEventListener('click', () => { this.calMonth = moment(month).add(1, 'month'); this.renderSidebar(); });

    const counts = new Map();
    for (const m of this.store.all()) {
      if (m.archived !== this.filter.archived) continue;
      const k = moment(m.created).format('YYYY-MM-DD');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const max = Math.max(1, ...counts.values());

    const grid = el.createDiv('memos-cal-grid');
    const weekdays = moment.weekdaysMin();
    const fdw = this.plugin.settings.firstDayOfWeek;
    const firstDow = fdw === 'sunday' ? 0 : fdw === 'monday' ? 1 : moment.localeData().firstDayOfWeek();
    for (let i = 0; i < 7; i++) {
      grid.createDiv({ cls: 'memos-cal-dow', text: weekdays[(firstDow + i) % 7].charAt(0) });
    }
    const start = moment(month);
    while (start.day() !== firstDow) start.subtract(1, 'day');
    const end = moment(month).endOf('month');
    while ((end.day() + 1) % 7 !== firstDow) end.add(1, 'day');
    const today = moment();
    for (let d = moment(start); d.isSameOrBefore(end, 'day'); d.add(1, 'day')) {
      const key = d.format('YYYY-MM-DD');
      const n = counts.get(key) || 0;
      const level = n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4));
      const cell = grid.createDiv({ cls: `memos-cal-day level-${level}`, text: String(d.date()) });
      if (!d.isSame(month, 'month')) cell.addClass('is-outside');
      if (d.isSame(today, 'day')) cell.addClass('is-today');
      if (this.filter.date && d.isSame(this.filter.date, 'day')) cell.addClass('is-selected');
      cell.setAttr('aria-label', `${d.format('ll')}: ${n} thought${n === 1 ? '' : 's'}`);
      const day = moment(d);
      cell.addEventListener('click', () => this.setDate(day));
    }
  }

  // ---- filter chips -------------------------------------------------------

  renderChips() {
    const el = this.chipsEl;
    el.empty();
    const f = this.filter;
    const chip = (label, icon, clear) => {
      const c = el.createDiv('memos-chip');
      setIcon(c.createSpan('memos-chip-icon'), icon);
      c.createSpan({ text: label });
      const x = c.createSpan({ cls: 'memos-chip-x' });
      setIcon(x, 'x');
      x.addEventListener('click', clear);
    };
    if (f.tag) chip('#' + f.tag, 'hash', () => this.setTag(f.tag));
    if (f.date) chip(moment(f.date).format('ll'), 'calendar', () => this.setDate(moment(f.date)));
    if (f.query) chip(`"${f.query}"`, 'search', () => { this.searchInput.value = ''; this.searchClearBtn.hide(); f.query = ''; this.refresh(); });
    if (f.archived) chip('Archived', 'archive', () => this.setArchived(false));
    el.toggle(el.childElementCount > 0);
  }

  renderStrip() {
    const el = this.stripEl;
    el.empty();
    const counts = this.store.tagCounts(this.filter.archived);
    const mk = (label, active, onClick, icon) => {
      const c = el.createDiv({ cls: 'memos-strip-chip' + (active ? ' is-active' : '') });
      if (icon) setIcon(c.createSpan('memos-strip-icon'), icon);
      c.createSpan({ text: label });
      c.addEventListener('click', onClick);
    };
    mk(this.filter.archived ? 'Archived' : 'All', !this.filter.tag, () => { this.filter.tag = null; this.refresh(); }, this.filter.archived ? 'archive' : 'home');
    for (const [tag, n] of counts) mk(`#${tag} ${n}`, this.filter.tag === tag, () => this.setTag(tag));
    el.toggle(this.plugin.settings.showTagStrip && counts.length > 0);
  }

  // ---- list ---------------------------------------------------------------

  renderList() {
    this.unloadCards();
    this.listEl.empty();
    this.moreEl.empty();
    const items = this.filtered();

    this.renderContext(items.length);
    if (!items.length) {
      const empty = this.listEl.createDiv('memos-empty');
      setIcon(empty.createDiv('memos-empty-icon'), 'sparkles');
      const hasFilter = this.filter.tag || this.filter.date || this.filter.query;
      empty.createDiv({ cls: 'memos-empty-title', text: !this.store.ready ? 'Loading...' : hasFilter ? 'Nothing matches' : 'Nothing here yet' });
      empty.createDiv({ cls: 'memos-empty-sub', text: !this.store.ready ? '' : hasFilter ? 'Try clearing a filter.' : this.filter.archived ? 'Archived thoughts will show up here.' : 'Capture your first thought above.' });
      return;
    }

    for (const memo of items.slice(0, this.limit)) this.renderCard(memo);

    if (items.length > this.limit) {
      const b = this.moreEl.createEl('button', { text: `Load more (${items.length - this.limit} left)` });
      b.addEventListener('click', () => { this.limit += this.plugin.settings.pageSize; this.renderList(); });
    }
  }

  renderContext(count) {
    const el = this.contextEl;
    el.empty();
    const f = this.filter;
    const parts = [];
    if (f.tag) parts.push('#' + f.tag);
    if (f.date) parts.push(moment(f.date).format('ll'));
    if (f.query) parts.push(`"${f.query}"`);
    const label = parts.length ? parts.join(' · ') : f.archived ? 'Archived' : 'Timeline';
    el.createSpan({ cls: 'memos-context-label', text: label });
    el.createSpan({ cls: 'memos-context-count', text: `${count} thought${count === 1 ? '' : 's'}` });
  }

  renderCard(memo) {
    const card = this.listEl.createDiv({ cls: 'memo-card' });
    if (memo.pinned) card.addClass('is-pinned');
    if (memo.archived) card.addClass('is-archived');

    const head = card.createDiv('memo-card-head');
    const time = head.createSpan({ cls: 'memo-time', text: formatTime(memo.created, this.plugin.settings) });
    time.setAttr('title', moment(memo.created).format('LLLL'));
    time.addEventListener('click', () => this.app.workspace.getLeaf('tab').openFile(memo.file));
    if (memo.pinned) setIcon(head.createSpan({ cls: 'memo-pin', attr: { 'aria-label': 'Pinned' } }), 'pin');
    const spacer = head.createDiv('memo-card-spacer');
    void spacer;
    const menuBtn = head.createEl('button', { cls: 'clickable-icon memo-menu-btn', attr: { 'aria-label': 'More' } });
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.addEventListener('click', (e) => this.showMenu(memo, card, e));

    const content = card.createDiv('memo-content markdown-rendered');
    const comp = new Component();
    this.addChild(comp);
    this.cardComponents.push(comp);
    MarkdownRenderer.render(this.app, memo.body, content, memo.file.path, comp).then(() => {
      content.querySelectorAll('input.task-list-item-checkbox').forEach((cb) => { cb.disabled = false; });
      const max = this.plugin.settings.collapseLongThoughts;
      if (max > 0 && content.scrollHeight > max + 40) {
        content.addClass('is-collapsed');
        content.style.maxHeight = max + 'px';
        const more = card.createEl('button', { cls: 'memo-expand', text: 'Show more' });
        more.addEventListener('click', () => {
          const open = content.hasClass('is-collapsed');
          content.toggleClass('is-collapsed', !open);
          content.style.maxHeight = open ? '' : max + 'px';
          more.setText(open ? 'Show less' : 'Show more');
        });
      }
    });

    content.addEventListener('click', (e) => {
      const link = e.target.closest('a.internal-link');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute('data-href') || link.getAttribute('href');
        if (href) this.app.workspace.openLinkText(href, memo.file.path, Keymap.isModEvent(e));
        return;
      }
      const tagEl = e.target.closest('a.tag');
      if (tagEl) {
        e.preventDefault();
        e.stopPropagation();
        this.setTag(tagEl.textContent.replace(/^#/, ''));
      }
    });
    content.addEventListener('change', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'checkbox') {
        const boxes = [...content.querySelectorAll('input[type="checkbox"]')];
        const idx = boxes.indexOf(t);
        if (idx >= 0) this.store.toggleTask(memo, idx);
      }
    });

    content.addEventListener('mouseover', (e) => {
      const link = e.target.closest('a.internal-link');
      if (!link) return;
      this.app.workspace.trigger('hover-link', {
        event: e,
        source: 'thoughtbin',
        hoverParent: this,
        targetEl: link,
        linktext: link.getAttribute('data-href') || link.getAttribute('href'),
        sourcePath: memo.file.path,
      });
    });
    card.addEventListener('contextmenu', (e) => {
      if (e.target.closest('a, input, .memo-card-editor')) return;
      e.preventDefault();
      this.showMenu(memo, card, e);
    });
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('a, input, button')) return;
      this.editCard(card, memo);
    });
    return card;
  }

  showMenu(memo, card, evt) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(memo.pinned ? 'Unpin' : 'Pin').setIcon('pin')
      .onClick(() => this.store.setFlags(memo, { pinned: !memo.pinned })));
    menu.addItem((i) => i.setTitle('Edit').setIcon('pencil').onClick(() => this.editCard(card, memo)));
    menu.addItem((i) => i.setTitle(memo.archived ? 'Restore' : 'Archive').setIcon('archive')
      .onClick(() => this.store.setFlags(memo, { archived: !memo.archived, pinned: false })));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Open note').setIcon('file-text')
      .onClick(() => this.app.workspace.getLeaf('tab').openFile(memo.file)));
    menu.addItem((i) => i.setTitle('Copy content').setIcon('copy')
      .onClick(async () => { await navigator.clipboard.writeText(memo.body); new Notice('Copied'); }));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Delete').setIcon('trash').setWarning(true)
      .onClick(() => {
        if (this.plugin.settings.confirmDelete) new ConfirmModal(this.app, 'Delete thought?', 'This will move the note to trash.', () => this.store.delete(memo)).open();
        else this.store.delete(memo);
      }));
    menu.showAtMouseEvent(evt);
  }

  editCard(card, memo) {
    if (card.hasClass('is-editing')) return;
    card.addClass('is-editing');
    this.editingCount++;
    const holder = card.createDiv('memo-card-editor');
    const finish = () => {
      editor.destroy();
      holder.remove();
      card.removeClass('is-editing');
      this.editingCount--;
      if (this.pendingRefresh || this.editingCount === 0) this.refresh();
    };
    const editor = new MemoEditor(this.plugin, holder, {
      initial: memo.body,
      autofocus: true,
      onSave: async (text) => { await this.store.updateBody(memo, text); finish(); },
      onCancel: finish,
    });
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

class MemosSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };

    new Setting(containerEl).setName('Storage').setHeading();

    new Setting(containerEl).setName('Thoughtbin folder')
      .setDesc('Each thought is stored as its own markdown note in this folder.')
      .addText((t) => t.setPlaceholder('Thoughtbin').setValue(s.memosFolder).onChange(async (v) => {
        s.memosFolder = v.trim() || 'Thoughtbin';
        await save();
        await this.plugin.store.loadAll();
      }));

    new Setting(containerEl).setName('Attachments folder')
      .setDesc('Where pasted, dropped or attached files are saved.')
      .addText((t) => t.setPlaceholder('Thoughtbin/attachments').setValue(s.attachmentsFolder).onChange(async (v) => {
        s.attachmentsFolder = v.trim() || 'Thoughtbin/attachments';
        await save();
      }));

    new Setting(containerEl).setName('Filename format')
      .setDesc('Moment.js format used for new note filenames.')
      .addText((t) => t.setPlaceholder('YYYY-MM-DD HHmmss').setValue(s.filenameFormat).onChange(async (v) => {
        s.filenameFormat = v.trim() || 'YYYY-MM-DD HHmmss';
        await save();
      }));

    new Setting(containerEl).setName('Composer').setHeading();

    new Setting(containerEl).setName('Default code block language')
      .setDesc('Inserted after the opening ``` when you use the code block button. Leave blank for none.')
      .addText((t) => t.setPlaceholder('e.g. bash, python, js').setValue(s.defaultCodeLanguage).onChange(async (v) => {
        s.defaultCodeLanguage = v.trim();
        await save();
      }));

    new Setting(containerEl).setName('Save with Enter')
      .setDesc('Enter saves the thought and Shift+Enter adds a new line. Off: Ctrl/Cmd+Enter saves.')
      .addToggle((t) => t.setValue(s.saveWithEnter).onChange(async (v) => { s.saveWithEnter = v; await save(); }));

    new Setting(containerEl).setName('Composer template')
      .setDesc('Text pre-filled in the composer for every new thought, e.g. a default tag like #inbox.')
      .addTextArea((t) => t.setPlaceholder('#inbox ').setValue(s.composerTemplate).onChange(async (v) => {
        s.composerTemplate = v;
        await save();
      }));

    new Setting(containerEl).setName('Timeline').setHeading();

    new Setting(containerEl).setName('Sort order')
      .addDropdown((d) => d.addOptions({ newest: 'Newest first', oldest: 'Oldest first' })
        .setValue(s.sortOrder).onChange(async (v) => { s.sortOrder = v; await save(); }));

    new Setting(containerEl).setName('Keep pinned thoughts on top')
      .addToggle((t) => t.setValue(s.pinnedFirst).onChange(async (v) => { s.pinnedFirst = v; await save(); }));

    new Setting(containerEl).setName('Time display')
      .setDesc('Relative shows "3 hours ago" for the last 7 days, then switches to the date format below.')
      .addDropdown((d) => d.addOptions({ relative: 'Relative', absolute: 'Absolute' })
        .setValue(s.timeDisplay).onChange(async (v) => { s.timeDisplay = v; await save(); }));

    new Setting(containerEl).setName('Date format')
      .setDesc('Moment.js format for absolute timestamps.')
      .addText((t) => t.setPlaceholder('MMM D, YYYY HH:mm').setValue(s.dateFormat).onChange(async (v) => {
        s.dateFormat = v.trim() || 'MMM D, YYYY HH:mm';
        await save();
      }));

    new Setting(containerEl).setName('Thoughts per page')
      .addSlider((sl) => sl.setLimits(10, 200, 10).setValue(s.pageSize).setDynamicTooltip().onChange(async (v) => {
        s.pageSize = v;
        await save();
      }));

    new Setting(containerEl).setName('Collapse long thoughts')
      .setDesc('Maximum height in pixels before a "Show more" button appears. 0 disables collapsing.')
      .addSlider((sl) => sl.setLimits(0, 1000, 50).setValue(s.collapseLongThoughts).setDynamicTooltip().onChange(async (v) => {
        s.collapseLongThoughts = v;
        await save();
      }));

    new Setting(containerEl).setName('Confirm before deleting')
      .addToggle((t) => t.setValue(s.confirmDelete).onChange(async (v) => { s.confirmDelete = v; await save(); }));

    new Setting(containerEl).setName('Layout').setHeading();

    new Setting(containerEl).setName('Open timeline in')
      .addDropdown((d) => d.addOptions({ tab: 'Main area', right: 'Right sidebar', left: 'Left sidebar' })
        .setValue(s.viewLocation).onChange(async (v) => { s.viewLocation = v; await save(); }));

    new Setting(containerEl).setName('Show tag strip')
      .setDesc('Horizontal row of tag chips above the timeline on phones.')
      .addToggle((t) => t.setValue(s.showTagStrip).onChange(async (v) => { s.showTagStrip = v; await save(); }));

    new Setting(containerEl).setName('First day of week')
      .addDropdown((d) => d.addOptions({ locale: 'System locale', sunday: 'Sunday', monday: 'Monday' })
        .setValue(s.firstDayOfWeek).onChange(async (v) => { s.firstDayOfWeek = v; await save(); }));

    new Setting(containerEl).setName('Open timeline on startup')
      .addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await save(); }));
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class ThoughtbinPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.store = new MemoStore(this);

    this.registerView(VIEW_TYPE, (leaf) => new MemosView(leaf, this));
    this.addRibbonIcon('brain', 'Open Thoughtbin', () => this.activateView());

    this.addCommand({ id: 'open-timeline', name: 'Open timeline', callback: () => this.activateView() });
    this.addCommand({ id: 'quick-capture', name: 'Quick capture', callback: () => new QuickCaptureModal(this.app, this).open() });
    this.addCommand({
      id: 'focus-composer',
      name: 'Focus composer',
      callback: async () => {
        const leaf = await this.activateView();
        const view = leaf && leaf.view;
        if (view && view.composer) view.composer.focus(true);
      },
    });
    this.registerHoverLinkSource('thoughtbin', { display: 'Thoughtbin', defaultMod: true });
    this.addCommand({
      id: 'capture-selection',
      name: 'Save selection as thought',
      editorCallback: async (editor) => {
        const sel = editor.getSelection().trim();
        if (!sel) { new Notice('Nothing selected'); return; }
        await this.store.create(sel);
        new Notice('Thought saved');
      },
    });

    this.addSettingTab(new MemosSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.store.loadAll();

      const vault = this.app.vault;
      this.registerEvent(vault.on('create', (f) => {
        if (this.store.isMemoFile(f)) this.store.index(f).then(() => this.store.emit());
      }));
      this.registerEvent(vault.on('modify', (f) => {
        if (this.store.isMemoFile(f)) this.store.index(f).then(() => this.store.emit());
      }));
      this.registerEvent(vault.on('delete', (f) => {
        if (this.store.memos.has(f.path)) { this.store.remove(f.path); this.store.emit(); }
        else if (!(f instanceof TFile)) this.store.loadAll();
      }));
      this.registerEvent(vault.on('rename', (f, oldPath) => {
        if (this.store.memos.has(oldPath)) this.store.remove(oldPath);
        if (this.store.isMemoFile(f)) this.store.index(f).then(() => this.store.emit());
        else if (!(f instanceof TFile)) this.store.loadAll();
        else this.store.emit();
      }));

      if (this.settings.openOnStartup) this.activateView();
    });
  }

  onunload() {}

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const loc = this.settings.viewLocation;
      leaf = loc === 'right' ? workspace.getRightLeaf(false)
        : loc === 'left' ? workspace.getLeftLeaf(false)
        : workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.store) this.store.emit();
  }
}

module.exports = ThoughtbinPlugin;
