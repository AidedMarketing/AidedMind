import { allNotes, saveNote, saveMany, deleteNote, newId } from './db.js';
import { capture, DuplicateError, checkAuth, getSettings, saveSettings, splitInput, fetchInbox, removeInboxItem, serverBase, getLastUsage, adminListUsers, adminCreateUser } from './api.js';
import { buildGraph, GraphView } from './graph.js';
import { toMarkdown, fileName } from './markdown.js';
import { icon } from './icons.js';
import { createZip } from './zip.js';
import { preparePhoto, MAX_PHOTOS } from './photos.js';

const view = document.getElementById('view');
const navbar = document.getElementById('navbar');
const SOURCE_LABELS = { article: 'Article', youtube: 'YouTube', tiktok: 'TikTok', text: 'Text', photo: 'Photos' };
const SOURCE_ICONS = { article: 'article', youtube: 'youtube', tiktok: 'tiktok', text: 'text', concept: 'concept', photo: 'photo' };
const NOTE_TABS = ['Summary', 'Outline', 'Links', 'Notes'];
const PARTIAL_NOTES = {
    caption: 'Only the caption was available, so this is a partial breakdown. Paste the transcript for the full picture.',
    description: 'This video had no transcript, so the breakdown is based on its title and description. Paste the transcript for the full picture.',
    gemini: 'This video was very long, so its transcript was cut short. Paste the rest as text for the full picture.'
};
const TRANSCRIPT_LABELS = {
    captions: 'video captions',
    gemini: 'Gemini (watched the video)',
    supadata: 'Supadata',
    description: 'video description only',
    caption: 'caption only'
};
const DEPTH_INFO = {
    auto: { label: 'Auto', detail: 'Picks for each link: Quick for TikToks and short posts, Balanced for most articles, videos and photos, Thorough for very long pieces or 6+ photos.' },
    quick: { label: 'Quick', detail: 'Fastest and cheapest (Claude Haiku). Short summary; great for TikToks and short posts.' },
    balanced: { label: 'Balanced', detail: 'Fast, with a tight summary and strong quotes and takeaways (Claude Sonnet). Best for most things.' },
    thorough: { label: 'Thorough', detail: 'Deepest reasoning (Claude Opus). Slower and uses the most; for long or dense pieces.' }
};

function depthLabel(depth) {
    return DEPTH_INFO[depth]?.label || DEPTH_INFO.auto.label;
}
const TIP_KEY = 'aidedmind.tipDismissed';

let notes = [];
let draft = { input: '', title: '', photos: [] };
let pending = null;
let inboxRunning = false;
const noteTab = new Map();

// ---------- DOM helpers (no innerHTML: every string goes in as text) ----------

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') el.className = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'style') Object.entries(value).forEach(([prop, v]) => el.style.setProperty(prop, v));
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, value);
    });
    append(el, children);
    return el;
}

function append(el, children) {
    children.flat(Infinity).forEach((child) => {
        if (child === null || child === undefined || child === false) return;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return el;
}

function render(...nodes) {
    closeSheet();
    view.classList.remove('full');
    view.replaceChildren();
    append(view, nodes);
}

function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function sourceTile(type, size = 18) {
    return h('span', { class: `source-tile ${type}` }, icon(SOURCE_ICONS[type] || 'text', { size, strokeWidth: 2 }));
}

function relativeDate(iso) {
    const date = new Date(iso);
    const days = Math.floor((startOfDay(new Date()) - startOfDay(date)) / 86400000);
    if (days === 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return 'Yesterday';
    if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dateBucket(iso) {
    const days = Math.floor((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'This Week';
    if (days < 31) return 'This Month';
    return 'Earlier';
}

function safeHref(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

function noteRow(note) {
    const type = note.source?.sourceType || 'text';
    const origin = note.source?.author || note.source?.siteName || hostOf(note.source?.url) || SOURCE_LABELS[type];
    return h('a', { class: 'note-row', href: `#/note/${encodeURIComponent(note.id)}` },
        sourceTile(type),
        h('div', { class: 'body' },
            h('div', { class: 'title' }, note.title),
            h('div', { class: 'tldr' }, note.tldr),
            h('div', { class: 'meta' }, `${origin} · ${relativeDate(note.createdAt)}`)
        )
    );
}

// ---------- Nav bar ----------

function setNav({ title = '', left = null, right = null, hidden = false } = {}) {
    navbar.classList.toggle('hidden-bar', hidden);
    document.getElementById('nav-title').textContent = title;
    document.getElementById('nav-left').replaceChildren(...[left].flat().filter(Boolean));
    document.getElementById('nav-right').replaceChildren(...[right].flat().filter(Boolean));
    updateNavShadow();
}

function updateNavShadow() {
    navbar.classList.toggle('scrolled', window.scrollY > 28);
}

window.addEventListener('scroll', updateNavShadow, { passive: true });

function navButton(label, onclick, iconName) {
    return h('button', { type: 'button', class: `nav-button${label ? '' : ' icon-only'}`, onclick, 'aria-label': label || iconName },
        iconName ? icon(iconName, { size: 24, strokeWidth: 2 }) : null,
        label
    );
}

// ---------- Sheets ----------

function closeSheet() {
    document.getElementById('sheet-root').replaceChildren();
}

function openSheet(...content) {
    const root = document.getElementById('sheet-root');
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grabber' }), content);
    root.replaceChildren(h('div', { class: 'sheet-scrim', onclick: closeSheet }), sheet);
    let startY = null;
    sheet.addEventListener('touchstart', (event) => { startY = sheet.scrollTop <= 0 ? event.touches[0].clientY : null; }, { passive: true });
    sheet.addEventListener('touchend', (event) => {
        if (startY !== null && event.changedTouches[0].clientY - startY > 80) closeSheet();
        startY = null;
    });
    return sheet;
}

function actionRow(label, iconName, onclick, extraClass = '') {
    return h('button', { type: 'button', class: `group-row with-icon ${extraClass}`, onclick },
        h('span', { class: 'row-icon' }, icon(iconName, { size: 18, strokeWidth: 2 })),
        h('span', { class: 'row-label' }, label)
    );
}

// ---------- Capture ----------

function buildNote(result, title) {
    const a = result.analysis;
    return {
        id: newId(),
        createdAt: new Date().toISOString(),
        source: {
            sourceType: result.source.sourceType,
            url: result.source.url,
            sharedUrl: result.source.sharedUrl || '',
            title: result.source.title,
            author: result.source.author,
            siteName: result.source.siteName,
            thumbnail: result.source.thumbnail,
            partial: result.source.partial,
            transcriptSource: result.source.transcriptSource || ''
        },
        sourceText: result.source.text,
        title: title || a.title || result.source.title || 'Untitled',
        tldr: a.tldr,
        summary: a.summary,
        outline: a.outline,
        concepts: a.concepts,
        tags: a.tags,
        quotes: a.quotes,
        takeaways: a.takeaways,
        connections: a.connections,
        photos: result.photos || [],
        userNotes: '',
        model: result.model,
        depth: result.depth,
        autoDepth: Boolean(result.auto)
    };
}

async function runCapture({ input, title, photos = [] }) {
    let result;
    if (photos.length) {
        result = await capture({ text: input.trim(), title, photos }, notes);
        result.photos = photos.map((photo) => photo.thumb);
    } else {
        const { url, text } = splitInput(input);
        if (!url && !text) throw new Error('Paste a link or some text first.');
        result = await capture({ url, text, title }, notes);
    }
    const note = buildNote(result, title);
    await saveNote(note);
    notes = await allNotes();
    return note;
}

async function startCapture(input, title = '', photos = []) {
    if (pending) return;
    if (!getSettings().token) {
        toast('Add your access token in Settings first');
        location.hash = '#/settings';
        return;
    }
    draft = { input, title, photos };
    pending = runCapture({ input, title, photos });
    captureView();
    try {
        const note = await pending;
        draft = { input: '', title: '', photos: [] };
        pending = null;
        toast('Saved to your library');
        location.hash = `#/note/${encodeURIComponent(note.id)}`;
    } catch (error) {
        pending = null;
        if (error instanceof DuplicateError) {
            draft = { input: '', title: '', photos: [] };
            toast('Already in your library');
            location.hash = `#/note/${encodeURIComponent(error.note.id)}`;
            return;
        }
        draft.error = error.message;
        if (location.hash === '' || location.hash === '#/') captureView();
        else toast(error.message);
    }
}

function captureView() {
    setNav({ title: 'Add' });
    const input = h('textarea', { class: 'field', placeholder: 'Or paste text, a transcript, your notes…', 'aria-label': 'Link or text', rows: '3' });
    input.value = draft.input;
    input.addEventListener('input', () => {
        draft.input = input.value;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 320)}px`;
    });
    const titleInput = h('input', { class: 'field', type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Title' });
    titleInput.value = draft.title;
    titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
    const error = draft.error;
    delete draft.error;

    const pasteButton = h('button', {
        type: 'button',
        class: 'paste-button',
        onclick: async () => {
            try {
                const clip = (await navigator.clipboard.readText()).trim();
                if (!clip) {
                    toast('Your clipboard is empty');
                    return;
                }
                startCapture(clip, titleInput.value.trim());
            } catch {
                input.focus();
                toast('Paste into the box below instead');
            }
        }
    },
    h('span', { class: 'big-icon' }, icon('clipboard', { size: 26, strokeWidth: 2 })),
    h('div', {}, h('strong', {}, 'Paste link'), h('span', {}, 'Article, YouTube, TikTok or any web page'))
    );

    const photoInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    photoInput.addEventListener('change', async () => {
        const files = [...photoInput.files];
        photoInput.value = '';
        if (!files.length) return;
        const room = MAX_PHOTOS - draft.photos.length;
        if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos per note; added the first ${Math.max(room, 0)}.`);
        toast('Preparing photos…');
        try {
            for (const file of files.slice(0, Math.max(room, 0))) draft.photos.push(await preparePhoto(file));
        } catch (error) {
            toast(error.message);
        }
        draft.input = input.value;
        draft.title = titleInput.value;
        captureView();
    });
    const hasPhotos = draft.photos.length > 0;
    if (hasPhotos) input.placeholder = 'Add context (optional): what these photos are, what to focus on…';

    const photoButton = h('button', { type: 'button', class: 'photo-button', onclick: () => photoInput.click() },
        h('span', { class: 'big-icon' }, icon('camera', { size: 22, strokeWidth: 2 })),
        h('div', {}, h('strong', {}, 'Add photos'), h('span', {}, 'Screenshots, book pages, slides, notes, charts'))
    );

    const photoStrip = hasPhotos ? h('div', { class: 'photo-strip', style: { 'margin-bottom': '12px' } },
        draft.photos.map((photo, index) => h('div', { class: 'photo-thumb' },
            h('img', { src: photo.thumb, alt: `Photo ${index + 1}` }),
            h('button', {
                type: 'button',
                'aria-label': `Remove photo ${index + 1}`,
                onclick: () => {
                    draft.photos.splice(index, 1);
                    draft.input = input.value;
                    draft.title = titleInput.value;
                    captureView();
                }
            }, icon('close', { size: 14, strokeWidth: 2.4 }))
        )),
        draft.photos.length < MAX_PHOTOS ? h('button', { type: 'button', class: 'photo-add-more', 'aria-label': 'Add more photos', onclick: () => photoInput.click() }, icon('add', { size: 24 })) : null
    ) : null;

    const progress = pending
        ? h('div', { class: 'card progress-card' },
            h('div', { class: 'pulse' }, icon('sparkle', { size: 22 })),
            h('div', {}, h('strong', {}, 'Breaking it down…'), h('span', {}, draft.photos.length ? 'Reading your photos, summarizing and finding connections.' : 'Reading, summarizing and finding connections. Usually under a minute.')))
        : null;

    const tipDismissed = localStorage.getItem(TIP_KEY) === '1';
    const tip = !tipDismissed ? h('div', { class: 'tip' },
        icon('share', { size: 20, strokeWidth: 2 }),
        h('div', {}, 'Save from any app\'s Share button with the AidedMind Shortcut. ', h('a', { href: '#/settings' }, 'Set it up')),
        h('button', {
            type: 'button',
            class: 'dismiss',
            'aria-label': 'Dismiss',
            onclick: (event) => {
                localStorage.setItem(TIP_KEY, '1');
                event.currentTarget.closest('.tip').remove();
            }
        }, icon('close', { size: 18 }))
    ) : null;

    render(
        h('h1', { class: 'large-title' }, 'Add'),
        progress || [
            hasPhotos ? null : [pasteButton, photoButton, h('div', { class: 'or' }, 'or')],
            h('form', {
                class: 'card',
                onsubmit: (event) => {
                    event.preventDefault();
                    startCapture(input.value, titleInput.value.trim(), [...draft.photos]);
                }
            },
            photoStrip,
            input,
            titleInput,
            error ? h('p', { class: 'error small', style: { 'margin-top': '12px' } }, error) : null,
            h('button', { class: 'btn primary block', type: 'submit', style: { 'margin-top': '12px' } },
                hasPhotos ? `Break down ${draft.photos.length} photo${draft.photos.length === 1 ? '' : 's'}` : 'Break it down'),
            hasPhotos ? h('button', {
                type: 'button',
                class: 'btn block',
                style: { 'margin-top': '8px' },
                onclick: () => { draft.photos = []; captureView(); }
            }, 'Cancel photos') : null,
            h('p', { class: 'small muted', style: { margin: '10px 0 0', 'text-align': 'center' } }, `${depthLabel(getSettings().depth)} breakdown · `, h('a', { href: '#/settings' }, 'change')))
        ],
        photoInput,
        hasPhotos ? null : tip,
        notes.length ? [h('div', { class: 'section-label' }, 'Recent'), h('div', { class: 'group' }, notes.slice(0, 5).map(noteRow))] : null
    );
}

// ---------- Library ----------

function libraryView(params) {
    setNav({ title: 'Library', right: navButton('', () => drainInbox({ manual: true }), 'inbox') });
    let activeTag = params.get('tag') || '';
    let activeType = '';
    const search = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search library', enterkeyhint: 'search' });
    search.value = params.get('q') || '';
    const list = h('div');
    const chips = h('div', { class: 'chips' });

    const tagCounts = new Map();
    notes.forEach((note) => (note.tags || []).forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)));
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([tag]) => tag);
    if (activeTag && !topTags.includes(activeTag)) topTags.unshift(activeTag);
    const presentTypes = Object.keys(SOURCE_LABELS).filter((type) => notes.some((n) => (n.source?.sourceType || 'text') === type));

    const refresh = () => {
        const q = search.value.trim().toLowerCase();
        const matches = notes.filter((note) => {
            if (activeTag && !(note.tags || []).includes(activeTag)) return false;
            if (activeType && (note.source?.sourceType || 'text') !== activeType) return false;
            if (!q) return true;
            const haystack = [
                note.title, note.tldr, note.userNotes, note.source?.author,
                ...(note.concepts || []).map((c) => c.name),
                ...(note.tags || []),
                ...(note.summary || []).map((s) => s.body)
            ].join(' ').toLowerCase();
            return q.split(/\s+/).every((word) => haystack.includes(word));
        });

        chips.replaceChildren(
            h('button', { type: 'button', class: `chip${!activeType && !activeTag ? ' active' : ''}`, onclick: () => { activeType = ''; activeTag = ''; refresh(); } }, 'All'),
            ...presentTypes.map((type) => h('button', {
                type: 'button',
                class: `chip${type === activeType ? ' active' : ''}`,
                style: { '--dot': `var(--node-${type})` },
                onclick: () => { activeType = activeType === type ? '' : type; refresh(); }
            }, h('span', { class: 'dot' }), SOURCE_LABELS[type])),
            ...topTags.map((tag) => h('button', {
                type: 'button',
                class: `chip${tag === activeTag ? ' active' : ''}`,
                onclick: () => { activeTag = activeTag === tag ? '' : tag; refresh(); }
            }, `#${tag}`))
        );

        if (!notes.length) {
            list.replaceChildren(h('div', { class: 'empty' }, icon('library', { size: 44, strokeWidth: 1.4 }), h('strong', {}, 'Nothing saved yet'), 'Paste a link on the Add tab, or share one with the Shortcut. Tap the inbox button above to check for shared links.'));
            return;
        }
        if (!matches.length) {
            list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'No results'), 'Try a different word or filter.'));
            return;
        }
        const groups = new Map();
        matches.forEach((note) => {
            const bucket = dateBucket(note.createdAt);
            if (!groups.has(bucket)) groups.set(bucket, []);
            groups.get(bucket).push(note);
        });
        list.replaceChildren(...[...groups.entries()].flatMap(([label, items]) => [
            h('div', { class: 'section-label' }, label),
            h('div', { class: 'group' }, items.map(noteRow))
        ]));
    };
    search.addEventListener('input', refresh);
    refresh();

    render(
        h('h1', { class: 'large-title' }, 'Library'),
        h('label', { class: 'search' }, icon('search', { size: 18, strokeWidth: 2.2 }), search),
        notes.length ? chips : null,
        sharedItemsSection(),
        list
    );
}

// ---------- Note ----------

function noteView(id) {
    const note = notes.find((n) => n.id === id);
    const back = navButton('Library', () => {
        if (history.length > 1) history.back();
        else location.hash = '#/library';
    }, 'back');
    if (!note) {
        setNav({ title: '', left: back });
        render(h('div', { class: 'empty' }, h('strong', {}, 'Note not found'), 'It may have been deleted.'));
        return;
    }
    const byId = new Map(notes.map((n) => [n.id, n]));
    const href = safeHref(note.source?.url);
    const type = note.source?.sourceType || 'text';
    setNav({ title: note.title, left: back, right: navButton('', () => noteActions(note, byId), 'more') });

    const active = noteTab.get(note.id) || 'Summary';
    const panel = h('div', { class: 'tab-panel' });
    const segmented = h('div', { class: 'segmented', role: 'tablist' });
    const selectTab = (name) => {
        noteTab.set(note.id, name);
        [...segmented.children].forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === name);
            b.setAttribute('aria-selected', String(b.dataset.tab === name));
        });
        panel.replaceChildren();
        append(panel, [notePanel(name, note, byId)]);
    };
    NOTE_TABS.forEach((name) => segmented.append(h('button', { type: 'button', role: 'tab', 'data-tab': name, onclick: () => selectTab(name) }, name)));

    const origin = [note.source?.author || note.source?.siteName || hostOf(note.source?.url), relativeDate(note.createdAt)].filter(Boolean).join(' · ');
    render(
        h('div', { class: 'source-line' }, sourceTile(type, 14), h('span', {}, `${SOURCE_LABELS[type]}${origin ? ` · ${origin}` : ''}`)),
        h('h1', { class: 'note-title' }, note.title),
        note.photos?.length ? h('div', { class: 'photo-strip note-photos' },
            note.photos.map((src, index) => h('div', { class: 'photo-thumb' }, h('img', { src, alt: `Photo ${index + 1}` })))) : null,
        h('div', { class: 'tldr-card' }, h('span', { class: 'label' }, 'In short'), note.tldr),
        note.source?.partial ? h('p', { class: 'partial-note' }, PARTIAL_NOTES[note.source.transcriptSource] || PARTIAL_NOTES.caption) : null,
        note.tags?.length ? h('div', { class: 'chips wrap' }, note.tags.map((tag) => h('a', { class: 'chip', href: `#/library?tag=${encodeURIComponent(tag)}` }, `#${tag}`))) : null,
        href ? h('a', { class: 'btn small-btn', href, target: '_blank', rel: 'noopener noreferrer', style: { 'margin-top': '14px' } }, icon('external', { size: 16, strokeWidth: 2 }), 'Open original') : null,
        h('div', { class: 'sticky-tabs' }, segmented),
        panel
    );
    selectTab(active);
}

function notePanel(name, note, byId) {
    if (name === 'Summary') {
        const blocks = [];
        if (note.summary?.length) {
            blocks.push(h('div', { class: 'card prose' }, note.summary.map((s, i) => [
                h('h3', { style: i === 0 ? { 'margin-top': '0' } : null }, s.heading),
                h('p', {}, s.body)
            ])));
        }
        if (note.takeaways?.length) {
            blocks.push(h('div', { class: 'section-label' }, 'Takeaways'), h('div', { class: 'card prose' }, h('ul', { style: { margin: '0' } }, note.takeaways.map((t) => h('li', {}, t)))));
        }
        if (note.quotes?.length) {
            blocks.push(h('div', { class: 'section-label' }, 'Worth quoting'), h('div', { class: 'card' }, note.quotes.map((q) => h('blockquote', { class: 'quote' }, q))));
        }
        return blocks.length ? blocks : h('p', { class: 'muted' }, 'No summary available.');
    }

    if (name === 'Outline') {
        return note.outline?.length
            ? h('div', { class: 'group' }, h('ul', { class: 'outline' }, note.outline.map((item) => h('li', { class: `l${item.level}`, style: { '--level': String(item.level) } }, item.text))))
            : h('p', { class: 'muted' }, 'No outline available.');
    }

    if (name === 'Links') {
        const outgoing = (note.connections || []).filter((c) => byId.has(c.noteId));
        const backlinks = notes.flatMap((other) => (other.connections || [])
            .filter((c) => c.noteId === note.id && other.id !== note.id && !outgoing.some((o) => o.noteId === other.id))
            .map((c) => ({ ...c, noteId: other.id })));
        const linkCard = (c) => h('a', { class: 'link-card', href: `#/note/${encodeURIComponent(c.noteId)}` },
            h('div', { class: 'relation' }, c.relation.replace('-', ' ')),
            h('div', { class: 'title' }, byId.get(c.noteId).title),
            h('div', { class: 'reason' }, c.reason)
        );
        const canvas = h('canvas', { class: 'local-graph', 'aria-label': 'Map around this note' });
        const blocks = [
            outgoing.length || backlinks.length
                ? [
                    outgoing.length ? h('div', { class: 'group' }, outgoing.map(linkCard)) : null,
                    backlinks.length ? [h('div', { class: 'section-label' }, 'Linked from'), h('div', { class: 'group' }, backlinks.map(linkCard))] : null
                ]
                : h('div', { class: 'card muted' }, notes.length > 1 ? 'No strong links to your other notes yet.' : 'Connections appear as your library grows.'),
            h('div', { class: 'section-label' }, 'Map'),
            canvas,
            note.concepts?.length ? [
                h('div', { class: 'section-label' }, 'Concepts'),
                h('div', { class: 'concept-list' }, note.concepts.map((c) => h('a', { class: 'concept', href: `#/library?q=${encodeURIComponent(c.name)}` }, h('strong', {}, c.name), h('span', {}, c.description))))
            ] : null
        ];
        requestAnimationFrame(() => {
            const data = buildGraph(notes, { showConcepts: getSettings().showConcepts, focusId: note.id, depth: 2 });
            if (data.nodes.length > 1 && canvas.isConnected) {
                new GraphView(canvas, { focusId: note.id, onOpen: openNode }).setData(data);
            } else {
                canvas.previousElementSibling?.remove();
                canvas.remove();
            }
        });
        return blocks;
    }

    const userNotes = h('textarea', { class: 'field', placeholder: 'Your thoughts. Link other notes with [[Note title]].', 'aria-label': 'My notes', rows: '6' });
    userNotes.value = note.userNotes || '';
    let saveTimer;
    userNotes.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            note.userNotes = userNotes.value;
            await saveNote(note);
        }, 500);
    });
    return [
        userNotes,
        note.sourceText ? [h('div', { class: 'section-label' }, 'Captured source'), h('details', { class: 'card' }, h('summary', {}, 'Show full text'), h('div', { class: 'source-text' }, note.sourceText))] : null,
        note.source?.transcriptSource ? h('p', { class: 'group-footer' }, `Transcript from ${TRANSCRIPT_LABELS[note.source.transcriptSource] || note.source.transcriptSource}`) : null,
        note.model ? h('p', { class: 'group-footer' }, `${note.depth ? `${note.autoDepth ? 'Auto → ' : ''}${depthLabel(note.depth)} breakdown` : 'Breakdown'} by ${note.model}`) : null
    ];
}

function noteActions(note, byId) {
    const href = safeHref(note.source?.url);
    openSheet(
        h('h3', {}, note.title),
        h('div', { class: 'stack' },
            h('div', { class: 'group' },
                href ? actionRow('Share link', 'share', () => shareOrCopy({ title: note.title, url: href })) : null,
                actionRow('Export as Markdown', 'download', () => {
                    closeSheet();
                    shareFile(new File([toMarkdown(note, byId)], fileName(note), { type: 'text/markdown' }));
                }),
                actionRow(`Re-analyze (${depthLabel(getSettings().depth)})`, 'refresh', () => reanalyze(note)),
                note.depth !== 'thorough' ? actionRow('Re-analyze in depth (Thorough)', 'sparkle', () => reanalyze(note, 'thorough')) : null
            ),
            h('div', { class: 'group' },
                actionRow('Delete note', 'trash', async () => {
                    if (!confirm(`Delete "${note.title}"?`)) return;
                    closeSheet();
                    await deleteNote(note.id);
                    const touched = notes.filter((n) => n.id !== note.id && (n.connections || []).some((c) => c.noteId === note.id));
                    touched.forEach((n) => { n.connections = n.connections.filter((c) => c.noteId !== note.id); });
                    if (touched.length) await saveMany(touched);
                    notes = await allNotes();
                    toast('Deleted');
                    location.hash = '#/library';
                }, 'danger')
            ),
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
        )
    );
}

async function reanalyze(note, depth) {
    closeSheet();
    toast(`Re-analyzing (${depthLabel(depth || getSettings().depth)})…`);
    try {
        const result = await capture({ text: note.sourceText, title: note.source?.title || note.title, depth }, notes.filter((n) => n.id !== note.id));
        const fresh = buildNote(result, note.title);
        ['tldr', 'summary', 'outline', 'concepts', 'tags', 'quotes', 'takeaways', 'connections', 'model', 'depth', 'autoDepth'].forEach((key) => { note[key] = fresh[key]; });
        await saveNote(note);
        notes = await allNotes();
        toast('Updated');
        if (location.hash.includes(encodeURIComponent(note.id))) route();
    } catch (error) {
        toast(error.message);
    }
}

async function shareOrCopy({ title, url }) {
    closeSheet();
    if (navigator.share) {
        try {
            await navigator.share({ title, url });
        } catch {
            // user cancelled
        }
        return;
    }
    await navigator.clipboard.writeText(url);
    toast('Link copied');
}

async function shareFile(file) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: file.name });
            return;
        } catch (error) {
            if (error.name === 'AbortError') return;
        }
    }
    const url = URL.createObjectURL(file);
    const link = h('a', { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function openNode(node) {
    if (node.isNote) location.hash = `#/note/${encodeURIComponent(node.id)}`;
    else location.hash = `#/library?q=${encodeURIComponent(node.label)}`;
}

// ---------- Map ----------

function previewNode(node) {
    if (node.isNote) {
        const note = notes.find((n) => n.id === node.id);
        if (!note) return;
        const type = note.source?.sourceType || 'text';
        openSheet(
            h('div', { class: 'source-line' }, sourceTile(type, 14), h('span', {}, `${SOURCE_LABELS[type]} · ${relativeDate(note.createdAt)}`)),
            h('h3', { style: { 'margin-top': '8px' } }, note.title),
            h('p', { class: 'muted' }, note.tldr),
            h('div', { class: 'stack' }, h('a', { class: 'btn primary block', href: `#/note/${encodeURIComponent(note.id)}` }, 'Open note'))
        );
        return;
    }
    const related = notes.filter((n) => (n.concepts || []).some((c) => c.name.toLowerCase() === node.label.toLowerCase()));
    openSheet(
        h('div', { class: 'source-line' }, sourceTile('concept', 14), h('span', {}, `Concept · ${related.length} notes`)),
        h('h3', { style: { 'margin-top': '8px' } }, node.label),
        h('div', { class: 'stack' }, h('div', { class: 'group' }, related.map(noteRow)))
    );
}

function graphView() {
    setNav({ hidden: true });
    const settings = getSettings();
    if (!notes.length) {
        setNav({ title: 'Map' });
        render(
            h('h1', { class: 'large-title' }, 'Map'),
            h('div', { class: 'empty' }, icon('graph', { size: 44, strokeWidth: 1.4 }), h('strong', {}, 'Your map is empty'), 'Every note you save becomes a point here, linked to related ideas.')
        );
        return;
    }
    const canvas = h('canvas', { 'aria-label': 'Map of your notes' });
    const search = h('input', { type: 'search', placeholder: 'Find on map', 'aria-label': 'Find on map', enterkeyhint: 'search' });
    const conceptsButton = h('button', { type: 'button', class: `float-button glass${settings.showConcepts ? ' on' : ''}`, 'aria-label': 'Toggle shared concepts' }, icon('concept', { size: 20, strokeWidth: 2 }));
    const fitButton = h('button', { type: 'button', class: 'float-button glass', 'aria-label': 'Fit to screen' }, icon('fit', { size: 20, strokeWidth: 2 }));
    const types = [...new Set(notes.map((n) => n.source?.sourceType || 'text'))];

    closeSheet();
    view.classList.add('full');
    view.replaceChildren(h('div', { class: 'graph-page' },
        canvas,
        h('div', { class: 'graph-top' },
            h('label', { class: 'search glass' }, icon('search', { size: 18, strokeWidth: 2.2 }), search),
            conceptsButton,
            fitButton
        ),
        h('div', { class: 'graph-legend' },
            types.map((type) => h('span', { class: 'legend-item glass', style: { '--dot': `var(--node-${type})` } }, h('i'), SOURCE_LABELS[type])),
            settings.showConcepts ? h('span', { class: 'legend-item glass', style: { '--dot': 'var(--node-concept)' } }, h('i', { class: 'diamond' }), 'Shared idea') : null
        )
    ));

    const graph = new GraphView(canvas, { onOpen: previewNode });
    graph.setData(buildGraph(notes, { showConcepts: settings.showConcepts }));
    search.addEventListener('input', () => graph.setHighlight(search.value));
    fitButton.addEventListener('click', () => graph.fit());
    conceptsButton.addEventListener('click', () => {
        settings.showConcepts = !settings.showConcepts;
        saveSettings(settings);
        graphView();
    });
}

// ---------- Settings ----------

function copyField(value, label) {
    return h('div', { class: 'copy-field' },
        h('code', {}, value),
        h('button', {
            type: 'button',
            class: 'btn small-btn',
            'aria-label': `Copy ${label}`,
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(value);
                    toast(`${label} copied`);
                } catch {
                    toast('Copy failed; press and hold to select');
                }
            }
        }, icon('copy', { size: 16, strokeWidth: 2 }), 'Copy')
    );
}

function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function settingsView() {
    setNav({ title: 'Settings' });
    const settings = getSettings();
    const serverUrl = h('input', { class: 'field', type: 'url', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', placeholder: 'Server URL (blank = this site)', 'aria-label': 'Server URL' });
    serverUrl.value = settings.serverUrl;
    const token = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', placeholder: 'Access token', 'aria-label': 'Access token' });
    token.value = settings.token;
    const status = h('p', { class: 'small muted', style: { margin: '10px 0 0' } });
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const incoming = (Array.isArray(data) ? data : data.notes || []).filter((n) => n && n.id && n.title && n.createdAt);
            await saveMany(incoming);
            notes = await allNotes();
            toast(`Restored ${incoming.length} notes`);
        } catch (error) {
            toast(`Restore failed: ${error.message}`);
        }
        fileInput.value = '';
    });

    const inboxUrl = `${serverBase()}/api/inbox`;
    const usage = getLastUsage();
    const spendBox = h('div');
    const fillSpend = (u) => {
        spendBox.replaceChildren();
        if (!u) return;
        const lines = [`${u.captures} breakdown${u.captures === 1 ? '' : 's'} this month${u.limit === null ? '' : ` of ${u.limit}`}`];
        const spend = u.spend;
        if (spend) {
            const usd = spend.claudeUsd > 0 && spend.claudeUsd < 0.01 ? 'under $0.01' : `about $${spend.claudeUsd.toFixed(2)}`;
            lines.push(`Claude: ${usd}${spend.unpricedModels?.length ? ' (plus unpriced models)' : ''}`);
            if (spend.geminiVideos) lines.push(`Gemini: ${spend.geminiVideos} video${spend.geminiVideos === 1 ? '' : 's'} transcribed`);
            if (spend.supadataRequests) lines.push(`Supadata: ${spend.supadataRequests} transcript${spend.supadataRequests === 1 ? '' : 's'} (100 free credits a month)`);
        }
        append(spendBox, [
            h('div', { class: 'section-label' }, 'This month'),
            h('div', { class: 'group' }, lines.map((line) => h('div', { class: 'group-row' }, h('span', { class: 'row-label' }, line)))),
            h('p', { class: 'group-footer' }, 'Estimates. Exact Claude charges are in the Anthropic Console under Cost.')
        ]);
    };
    fillSpend(usage);
    if (settings.token) checkAuth().then((result) => fillSpend(result.usage)).catch(() => {});
    const accounts = h('div');

    render(
        h('h1', { class: 'large-title' }, 'Settings'),

        h('div', { class: 'section-label' }, 'Breakdown style'),
        (() => {
            const detail = h('p', { class: 'small muted', style: { margin: '10px 2px 0' } }, DEPTH_INFO[settings.depth]?.detail || DEPTH_INFO.auto.detail);
            const control = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Breakdown style' });
            const paint = () => [...control.children].forEach((b) => {
                const on = b.dataset.depth === settings.depth;
                b.classList.toggle('active', on);
                b.setAttribute('aria-checked', String(on));
            });
            Object.entries(DEPTH_INFO).forEach(([key, info]) => control.append(h('button', {
                type: 'button',
                role: 'radio',
                'data-depth': key,
                onclick: () => {
                    settings.depth = key;
                    saveSettings({ ...getSettings(), depth: key });
                    detail.textContent = info.detail;
                    paint();
                }
            }, info.label)));
            paint();
            return h('div', { class: 'card' }, control, detail, h('p', { class: 'small muted', style: { margin: '8px 2px 0' } }, 'Any note can be re-done in depth later from its ••• menu.'));
        })(),

        h('div', { class: 'section-label' }, 'Connection'),
        h('form', {
            class: 'card',
            onsubmit: async (event) => {
                event.preventDefault();
                Object.assign(settings, { serverUrl: serverUrl.value.trim(), token: token.value.trim() });
                saveSettings(settings);
                status.className = 'small muted';
                status.textContent = 'Checking…';
                try {
                    await checkAuth();
                    status.textContent = 'Connected. You\'re ready to save things.';
                    drainInbox();
                    settingsView();
                    toast('Connected');
                } catch (error) {
                    status.className = 'small error';
                    status.textContent = error.message;
                }
            }
        },
        serverUrl,
        token,
        h('button', { class: 'btn primary block', type: 'submit', style: { 'margin-top': '12px' } }, 'Save & Test'),
        status),
        spendBox,

        h('div', { class: 'section-label' }, 'Save from the Share button'),
        h('div', { class: 'card' },
            h('p', { class: 'small muted' }, 'iPhone doesn\'t let web apps appear in the Share menu, so a Shortcut sends links to your AidedMind inbox. They\'re broken down the next time you open the app.'),
            h('ol', { class: 'steps' },
                h('li', {}, 'Open ', h('b', {}, 'Shortcuts'), ', tap ', h('b', {}, '+'), ', and name it ', h('b', {}, 'Save to AidedMind'), '.'),
                h('li', {}, 'Tap the ', h('b', {}, 'ⓘ'), ' button, turn on ', h('b', {}, 'Show in Share Sheet'), ', and set it to receive ', h('b', {}, 'URLs'), ' and ', h('b', {}, 'Text'), '.'),
                h('li', {}, 'Add the action ', h('b', {}, 'Get Contents of URL'), ' and paste this URL:', copyField(inboxUrl, 'Inbox URL')),
                h('li', {}, 'Expand it: set Method to ', h('b', {}, 'POST'), '. Under Headers add ', h('b', {}, 'X-AidedMind-Token'), ' with your token:', settings.token ? copyField(settings.token, 'Token') : h('div', { class: 'small error' }, 'Save your token above first.')),
                h('li', {}, 'Set Request Body to ', h('b', {}, 'JSON'), ', add a Text field named ', h('b', {}, 'url'), ' and set its value to ', h('b', {}, 'Shortcut Input'), '.'),
                h('li', {}, 'Add ', h('b', {}, 'Show Notification'), ' and set its text to the ', h('b', {}, 'Contents of URL'), ' variable, so you see the server\'s real reply (including any error) instead of a fixed message.')
            ),
            h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'Now in TikTok, YouTube or Safari: Share → Save to AidedMind.')
        ),

        !isStandalone() ? [
            h('div', { class: 'section-label' }, 'Install'),
            h('div', { class: 'card small' }, 'In Safari, tap ', h('b', {}, 'Share'), ' → ', h('b', {}, 'Add to Home Screen'), '. AidedMind then opens full screen like an app. Your notes live in the installed app, so capture from there.')
        ] : null,

        h('div', { class: 'section-label' }, 'Your data'),
        h('div', { class: 'group' },
            actionRow('Export to Obsidian (.zip)', 'download', () => exportVault()),
            actionRow('Back up library', 'upload', () => shareFile(new File(
                [JSON.stringify({ version: 1, notes }, null, 2)],
                `aidedmind-backup-${new Date().toISOString().slice(0, 10)}.json`,
                { type: 'application/json' }
            ))),
            actionRow('Restore from backup', 'refresh', () => fileInput.click())
        ),
        h('p', { class: 'group-footer' }, `${notes.length} note${notes.length === 1 ? '' : 's'}, stored only on this device.`),
        accounts,
        fileInput
    );
    if (usage?.limit === null) renderAccounts(accounts);
}

// Owner-only: give other people their own access token and monthly quota.
async function renderAccounts(container) {
    let data;
    try {
        data = await adminListUsers();
    } catch {
        return;
    }
    const row = (user) => h('div', { class: 'group-row' },
        h('span', { class: 'row-label' }, user.label || user.id.slice(0, 8), h('div', { class: 'small muted' }, `${user.plan}${user.status === 'active' ? '' : ' · paused'}`)),
        h('span', { class: 'row-value' }, `${user.usage.captures}${user.limit === null ? '' : ` / ${user.limit}`}`)
    );
    container.replaceChildren();
    append(container, [
        h('div', { class: 'section-label' }, 'Accounts'),
        h('div', { class: 'group' },
            data.users.map(row),
            actionRow('Add an account', 'add', async () => {
                const label = prompt('Who is this account for?');
                if (label === null) return;
                try {
                    const created = await adminCreateUser({ label: label.trim(), plan: 'free' });
                    openSheet(
                        h('h3', {}, `Account for ${created.label || 'new user'}`),
                        h('p', { class: 'muted small' }, `Free plan, ${created.limit} breakdowns a month. Send them this token; it is shown only once.`),
                        copyField(created.token, 'Token'),
                        h('div', { class: 'stack' }, h('button', { type: 'button', class: 'btn block', onclick: () => { closeSheet(); renderAccounts(container); } }, 'Done'))
                    );
                } catch (error) {
                    toast(error.message);
                }
            })
        ),
        h('p', { class: 'group-footer' }, `Breakdowns used in ${data.month}. Paid plans can plug in here later.`)
    ]);
}

function exportVault() {
    if (!notes.length) {
        toast('Nothing to export yet');
        return;
    }
    const byId = new Map(notes.map((n) => [n.id, n]));
    const used = new Set();
    const files = notes.map((note) => {
        let name = fileName(note);
        for (let i = 2; used.has(name.toLowerCase()); i++) name = fileName(note).replace(/\.md$/, ` ${i}.md`);
        used.add(name.toLowerCase());
        return { name: `AidedMind/${name}`, content: toMarkdown(note, byId) };
    });
    const zip = createZip(files);
    shareFile(new File([zip], `AidedMind-${new Date().toISOString().slice(0, 10)}.zip`, { type: 'application/zip' }));
}

// ---------- Inbox (links shared via the iOS Shortcut) ----------

function setBanner(content) {
    const banner = document.getElementById('inbox-banner');
    if (!content) {
        banner.hidden = true;
        banner.replaceChildren();
        return;
    }
    banner.hidden = false;
    banner.className = 'inbox-banner glass';
    banner.replaceChildren();
    append(banner, [content]);
}

const FAILED_KEY = 'aidedmind.failedShares';
const inbox = { pending: [], errors: new Map(), checkError: '', checkedAt: null };

function failedShares() {
    try {
        return JSON.parse(localStorage.getItem(FAILED_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveFailedShares(list) {
    try {
        localStorage.setItem(FAILED_KEY, JSON.stringify(list.slice(-50)));
    } catch {
        // storage unavailable
    }
}

function removeFailedShare(id) {
    saveFailedShares(failedShares().filter((item) => item.id !== id));
}

function refreshInboxViews() {
    if (!pending && (location.hash.startsWith('#/library') || location.hash === '' || location.hash === '#/')) route();
}

// Pulls links saved by the iOS Shortcut and breaks each one down. A link the
// server can never read is kept locally with its reason (retry or remove it
// from the Library); a temporary failure stays in the inbox for next time.
async function drainInbox({ manual = false } = {}) {
    if (inboxRunning) return;
    if (!getSettings().token) {
        if (manual) toast('Add your access token in Settings first');
        return;
    }
    inboxRunning = true;
    let saved = 0;
    let failed = 0;
    let already = 0;
    try {
        inbox.checkError = '';
        const items = await fetchInbox();
        inbox.pending = items;
        inbox.checkedAt = Date.now();
        if (!items.length && manual) toast('No shared links waiting');
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            setBanner([h('div', { class: 'pulse' }, icon('inbox', { size: 16 })), h('span', {}, `Breaking down ${items.length > 1 ? `${i + 1} of ${items.length} shared links` : 'your shared link'}…`)]);
            try {
                await runCapture({ input: [item.url, item.text].filter(Boolean).join(' '), title: item.title });
                await removeInboxItem(item.id);
                inbox.errors.delete(item.id);
                inbox.pending = inbox.pending.filter((p) => p.id !== item.id);
                saved++;
            } catch (error) {
                if (error instanceof DuplicateError) {
                    await removeInboxItem(item.id).catch(() => {});
                    inbox.errors.delete(item.id);
                    inbox.pending = inbox.pending.filter((p) => p.id !== item.id);
                    already++;
                    continue;
                }
                failed++;
                const permanent = error.status && error.status < 500 && ![401, 402, 403, 429].includes(error.status);
                if (permanent) {
                    saveFailedShares([...failedShares().filter((f) => f.id !== item.id), {
                        id: item.id, url: item.url, text: item.text, title: item.title, error: error.message, at: new Date().toISOString()
                    }]);
                    await removeInboxItem(item.id).catch(() => {});
                    inbox.pending = inbox.pending.filter((p) => p.id !== item.id);
                } else {
                    inbox.errors.set(item.id, error.message);
                    if (error.status === 401 || error.status === 402) break;
                }
            }
        }
    } catch (error) {
        inbox.checkError = error.message;
        if (manual) toast(error.message);
    } finally {
        inboxRunning = false;
        setBanner(null);
        if (saved || already) {
            toast([
                saved ? `${saved} shared link${saved === 1 ? '' : 's'} added` : '',
                already ? `${already} already in your library` : ''
            ].filter(Boolean).join(' · '));
        }
        if (failed) {
            setBanner([
                icon('inbox', { size: 18, strokeWidth: 2 }),
                h('span', { style: { flex: '1' } }, `${failed} shared link${failed === 1 ? '' : 's'} couldn't be broken down.`),
                h('a', { href: '#/library', onclick: () => setBanner(null) }, 'View')
            ]);
        }
        refreshInboxViews();
    }
}

function sharedItemsSection() {
    const failed = failedShares();
    const waiting = inbox.pending;
    if (!failed.length && !waiting.length && !inbox.checkError) return null;
    const label = (item) => item.title || hostOf(item.url) || (item.url || item.text || '').slice(0, 60) || 'Shared item';
    const row = (item, status, actions) => h('div', { class: 'group-row' },
        h('span', { class: 'row-icon' }, icon('inbox', { size: 16, strokeWidth: 2 })),
        h('span', { class: 'row-label' },
            h('div', { style: { 'font-weight': '600', 'overflow-wrap': 'anywhere' } }, label(item)),
            h('div', { class: 'small', style: { color: status.error ? 'var(--danger)' : 'var(--text-2)' } }, status.text),
            h('div', { class: 'row', style: { display: 'flex', gap: '8px', 'margin-top': '8px' } }, actions)
        )
    );
    return [
        h('div', { class: 'section-label' }, 'Shared links'),
        h('div', { class: 'group' },
            inbox.checkError ? h('div', { class: 'group-body small error' }, `Couldn't check your inbox: ${inbox.checkError}`) : null,
            waiting.map((item) => row(item,
                inbox.errors.has(item.id) ? { text: `Will retry: ${inbox.errors.get(item.id)}`, error: true } : { text: 'Waiting to be broken down' },
                [h('button', { type: 'button', class: 'btn small-btn', onclick: () => drainInbox({ manual: true }) }, 'Try now')]
            )),
            failed.map((item) => row(item, { text: item.error, error: true }, [
                h('button', {
                    type: 'button',
                    class: 'btn small-btn',
                    onclick: () => {
                        removeFailedShare(item.id);
                        location.hash = '#/';
                        startCapture([item.url, item.text].filter(Boolean).join(' '), item.title || '');
                    }
                }, 'Try again'),
                h('button', { type: 'button', class: 'btn small-btn', onclick: () => { removeFailedShare(item.id); route(); } }, 'Remove')
            ]))
        ),
        failed.length ? h('p', { class: 'group-footer' }, 'If a site keeps refusing, open it, copy the text, and paste it on the Add tab.') : null
    ];
}

// ---------- Routing & startup ----------

function route() {
    const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
    const params = new URLSearchParams(query);
    const parts = path.split('/').filter(Boolean);
    const name = parts[0] || 'capture';
    document.querySelectorAll('.tabbar a').forEach((a) => {
        const on = a.dataset.route === name || (name === 'note' && a.dataset.route === 'library');
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    if (name === 'library') libraryView(params);
    else if (name === 'note') noteView(decodeURIComponent(parts[1] || ''));
    else if (name === 'graph') graphView();
    else if (name === 'settings') settingsView();
    else captureView();
}

function consumeShare() {
    // Android share target: GET /share?title=&text=&url=
    if (!location.pathname.endsWith('/share')) return null;
    const params = new URLSearchParams(location.search);
    const shared = [params.get('url'), params.get('text')].filter(Boolean).join(' ').trim();
    history.replaceState(null, '', `${location.pathname.replace(/share$/, '')}#/`);
    return shared;
}

async function start() {
    document.querySelectorAll('[data-icon]').forEach((slot) => slot.replaceWith(icon(slot.dataset.icon, { size: 26, strokeWidth: 1.8 })));
    const shared = consumeShare();
    notes = await allNotes();
    window.addEventListener('hashchange', route);
    route();
    if (shared) startCapture(shared);
    if (!getSettings().token && !location.hash.startsWith('#/settings')) {
        toast('Connect your server in Settings to start');
    }
    drainInbox();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') drainInbox();
    });
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch((error) => console.warn('SW registration failed', error));
    }
}

start();
