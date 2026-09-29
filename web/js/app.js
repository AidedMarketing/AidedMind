import { allNotes, saveNote, saveMany, deleteNote, newId } from './db.js';
import { capture, DuplicateError, checkAuth, getSettings, saveSettings, splitInput, fetchInbox, queueInboxItem, removeInboxItem, updateInboxItem, serverBase, fetchHealth, assignTopics, putPreferences, suggestConnections, getLastUsage, adminListUsers, adminCreateUser } from './api.js';
import { buildGraph, GraphView } from './graph.js';
import { buildThemes, THEME_DETAIL } from './themes.js';
import { knownTopics, conceptVocabulary, knownUrlHashes, findDuplicate } from './library.js';
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
    gemini: 'This video was very long, so its transcript was cut short. Paste the rest as text for the full picture.',
    paywall: 'Only the free opening was available, so this is a partial breakdown. Open the note\'s ••• menu to paste the full text, or share the article again from Safari while logged in.'
};
const TRANSCRIPT_LABELS = {
    captions: 'video captions',
    gemini: 'Gemini (watched the video)',
    supadata: 'Supadata',
    description: 'video description only',
    caption: 'caption only',
    paywall: 'the free part of a paywalled article'
};
const DEPTH_INFO = {
    auto: { label: 'Auto', detail: 'Picks for each link: Quick for TikToks and short posts, Balanced for most articles, videos and photos, Thorough for very long pieces or 6+ photos.' },
    quick: { label: 'Quick', detail: 'Fastest and cheapest (Claude Haiku). Short summary; great for TikToks and short posts.' },
    balanced: { label: 'Balanced', detail: 'Fast, with a tight summary and strong quotes and takeaways (Claude Sonnet 5.5). Best for most things.' },
    thorough: { label: 'Thorough', detail: 'Deepest reasoning (Claude Opus). Slower and uses the most; for long or dense pieces.' }
};

// Themes are recomputed only when the library or the detail setting changes.
let themeCache = { notes: null, detail: null, value: null };
function currentThemes() {
    const detail = getSettings().themeDetail;
    if (themeCache.notes !== notes || themeCache.detail !== detail) {
        themeCache = { notes, detail, value: buildThemes(notes, { detail }) };
    }
    return themeCache.value;
}

function themeOf(noteId) {
    const themes = currentThemes();
    const id = themes.byNote.get(noteId);
    return id ? themes.themes.find((t) => t.id === id) : null;
}

function depthLabel(depth) {
    return DEPTH_INFO[depth]?.label || DEPTH_INFO.auto.label;
}
const TIP_KEY = 'aidedmind.tipDismissed';
// Matches the service worker cache version, so Settings shows which build is running.
const APP_VERSION = '20';

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

// Topics are marked with a colored "#" everywhere; sources keep their
// colored dot or icon tile, so the two never look alike.
function topicMark(label, colorIndex = null) {
    return [
        h('span', { class: 'hash', style: { '--hash': colorIndex === null ? 'var(--theme-none)' : `var(--theme-${colorIndex})` }, 'aria-hidden': 'true' }, '#'),
        label
    ];
}

function noteRow(note) {
    const type = note.source?.sourceType || 'text';
    const origin = note.source?.author || note.source?.siteName || hostOf(note.source?.url) || SOURCE_LABELS[type];
    return h('a', { class: 'note-row', href: `#/note/${encodeURIComponent(note.id)}` },
        sourceTile(type),
        h('div', { class: 'body' },
            h('div', { class: 'title' }, note.title),
            h('div', { class: 'tldr' }, note.tldr),
            h('div', { class: 'meta' },
                (() => {
                    // The note's theme color and topic lead the line when it has one.
                    const theme = themeOf(note.id);
                    const topic = note.topic || theme?.label;
                    return topic ? [h('span', { class: 'meta-topic' }, topicMark(topic, theme ? theme.color : null)), ' · '] : null;
                })(),
                `${origin} · ${relativeDate(note.createdAt)}`)
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
            transcriptSource: result.source.transcriptSource || '',
            transcriptError: result.source.transcriptError || ''
        },
        sourceText: result.source.text,
        title: title || a.title || result.source.title || 'Untitled',
        topic: a.topic || '',
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

// Any of: `input` (what you typed or pasted), an explicit `url` and/or `text`,
// photos, `retry` (fetch a partial note's link again) or `replace` (redo a
// partial note with text you pasted).
async function runCapture({ input = '', url: explicitUrl, text: explicitText, title, photos = [], retry = null, replace = null }) {
    let result;
    if (retry) {
        result = await capture({ url: retry.source?.sharedUrl || retry.source?.url, retry }, notes);
    } else if (replace) {
        if (!explicitText?.trim()) throw new Error('Paste the article text first.');
        result = await capture({ url: replace.source?.url, text: explicitText.trim(), replace }, notes);
    } else if (photos.length) {
        result = await capture({ text: input.trim(), title, photos }, notes);
        result.photos = photos.map((photo) => photo.thumb);
    } else if (explicitUrl !== undefined || explicitText !== undefined) {
        if (!explicitUrl && !explicitText) throw new Error('Nothing to save.');
        result = await capture({ url: explicitUrl, text: explicitText, title }, notes);
    } else {
        const { url, text } = splitInput(input);
        if (!url && !text) throw new Error('Paste a link or some text first.');
        result = await capture({ url, text, title }, notes);
    }
    return finishNote(result, title);
}

// Builds the note from a finished breakdown, saves it, and lets a redone
// partial note keep its place and everything you added to it.
async function finishNote(result, title) {
    let note = buildNote(result, title);
    const previous = result.replaces && notes.find((n) => n.id === result.replaces);
    if (previous) {
        note = {
            ...note,
            id: previous.id,
            createdAt: previous.createdAt,
            userNotes: previous.userNotes || '',
            removedLinks: previous.removedLinks || [],
            ...(previous.topicByUser ? { topic: previous.topic, topicByUser: true } : {})
        };
        note.connections = keepAllowedLinks(note, note.connections);
    }
    await saveNote(note);
    notes = await allNotes();
    syncPreferences();
    return note;
}

// The server breaks shared links down while the app is closed, and needs to
// know your breakdown style, the topic and concept names in use (so its notes
// match the rest of your library) and fingerprints of the links you've
// already saved (so a repeat isn't paid for twice). No notes and no readable
// links are sent.
let prefsTimer;
function syncPreferences() {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(async () => {
        const settings = getSettings();
        if (!settings.token) return;
        try {
            await putPreferences({ depth: settings.depth, topics: knownTopics(notes), concepts: conceptVocabulary(notes), urls: await knownUrlHashes(notes) });
        } catch {
            // Best effort: the next change syncs again.
        }
    }, 1500);
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
        if (error.code === 'provider_unavailable' && !photos.length) {
            const { url, text } = splitInput(input);
            try {
                await queueInboxItem({ url, text, title });
                draft = { input: '', title: '', photos: [] };
                toast('Saved in Shared links. AidedMind will finish it when Claude is available.');
                location.hash = '#/library';
                drainInbox();
                return;
            } catch (queueError) {
                error = queueError;
            }
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

const LIBRARY_SORTS = {
    newest: { label: 'Newest first' },
    oldest: { label: 'Oldest first' },
    title: { label: 'Title A–Z' },
    theme: { label: 'By theme' },
    source: { label: 'By source' }
};

// Splits notes into [heading, notes] groups for the chosen sort.
function groupNotes(list, sort, { themes, byNote }) {
    const byDate = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
    const grouped = (keyOf, order) => {
        const groups = new Map(order.map((label) => [label, []]));
        list.forEach((note) => {
            const key = keyOf(note);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(note);
        });
        return [...groups.entries()].filter(([, items]) => items.length).map(([label, items]) => [label, items.sort(byDate)]);
    };
    if (sort === 'oldest') {
        return grouped((n) => dateBucket(n.createdAt), []).reverse().map(([label, items]) => [label, items.reverse()]);
    }
    if (sort === 'title') {
        const sorted = [...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        const groups = new Map();
        sorted.forEach((note) => {
            const letter = /^[a-z]/i.test(note.title) ? note.title[0].toUpperCase() : '#';
            if (!groups.has(letter)) groups.set(letter, []);
            groups.get(letter).push(note);
        });
        return [...groups.entries()];
    }
    if (sort === 'theme') {
        const labels = new Map(themes.map((t) => [t.id, t.label]));
        return grouped((n) => labels.get(byNote.get(n.id)) || 'Unsorted', [...themes.map((t) => t.label), 'Unsorted']);
    }
    if (sort === 'source') {
        return grouped((n) => SOURCE_LABELS[n.source?.sourceType || 'text'] || 'Text', Object.values(SOURCE_LABELS));
    }
    return grouped((n) => dateBucket(n.createdAt), []);
}

function libraryView(params) {
    setNav({ title: 'Library', right: navButton('', () => drainInbox({ manual: true }), 'inbox') });
    let activeTag = params.get('tag') || '';
    let activeType = '';
    let activeTheme = params.get('theme') || '';
    const { themes, byNote } = currentThemes();
    if (activeTheme && !themes.some((t) => t.id === activeTheme)) activeTheme = '';
    const search = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search library', enterkeyhint: 'search' });
    search.value = params.get('q') || '';
    const list = h('div');
    const chips = h('div', { class: 'chips' });
    const topicChips = h('div', { class: 'chips topic-row' });

    const presentTypes = Object.keys(SOURCE_LABELS).filter((type) => notes.some((n) => (n.source?.sourceType || 'text') === type));

    const refresh = () => {
        const q = search.value.trim().toLowerCase();
        const matches = notes.filter((note) => {
            if (activeTag && !(note.tags || []).includes(activeTag)) return false;
            if (activeType && (note.source?.sourceType || 'text') !== activeType) return false;
            if (activeTheme && byNote.get(note.id) !== activeTheme) return false;
            if (!q) return true;
            const haystack = [
                note.title, note.topic, note.tldr, note.userNotes, note.source?.author,
                ...(note.concepts || []).map((c) => c.name),
                ...(note.tags || []),
                ...(note.summary || []).map((s) => s.body)
            ].join(' ').toLowerCase();
            return q.split(/\s+/).every((word) => haystack.includes(word));
        });

        chips.replaceChildren(
            h('button', { type: 'button', class: `chip${!activeType && !activeTag && !activeTheme ? ' active' : ''}`, onclick: () => { activeType = ''; activeTag = ''; activeTheme = ''; refresh(); } }, 'All'),
            // Sources: colored dot. Topics: colored #. A tag (opened from a
            // note) shows as a plain chip while it's the active filter.
            ...presentTypes.map((type) => h('button', {
                type: 'button',
                class: `chip${type === activeType ? ' active' : ''}`,
                style: { '--dot': `var(--node-${type})` },
                onclick: () => { activeType = activeType === type ? '' : type; refresh(); }
            }, h('span', { class: 'dot' }), SOURCE_LABELS[type])),
        );
        // Second row: topics (colored #), plus a tag filter opened from a note.
        topicChips.replaceChildren(...[
            ...themes.map((theme) => h('button', {
                type: 'button',
                class: `chip topic-chip${theme.id === activeTheme ? ' active' : ''}`,
                'aria-label': `Topic: ${theme.label}`,
                onclick: () => { activeTheme = activeTheme === theme.id ? '' : theme.id; refresh(); }
            }, topicMark(theme.label, theme.color))),
            activeTag ? h('button', {
                type: 'button',
                class: 'chip tag-chip active',
                'aria-label': `Tag ${activeTag}, tap to clear`,
                onclick: () => { activeTag = ''; refresh(); }
            }, `${activeTag}`, icon('close', { size: 14, strokeWidth: 2.4 })) : null
        ].filter(Boolean));

        if (!notes.length) {
            list.replaceChildren(h('div', { class: 'empty' }, icon('library', { size: 44, strokeWidth: 1.4 }), h('strong', {}, 'Nothing saved yet'), 'Paste a link on the Add tab, or share one with the Shortcut. Tap the inbox button above to check for shared links.'));
            return;
        }
        if (!matches.length) {
            list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'No results'), 'Try a different word or filter.'));
            return;
        }
        sortButton.lastChild.textContent = LIBRARY_SORTS[sort].label;
        list.replaceChildren(...groupNotes(matches, sort, { themes, byNote }).flatMap(([label, items]) => [
            h('div', { class: 'section-label' }, label),
            h('div', { class: 'group' }, items.map(noteRow))
        ]));
    };
    let sort = LIBRARY_SORTS[getSettings().librarySort] ? getSettings().librarySort : 'newest';
    const sortButton = h('button', {
        type: 'button',
        class: 'sort-button',
        'aria-label': 'Sort notes',
        onclick: () => openSheet(
            h('h3', {}, 'Sort notes'),
            h('div', { class: 'stack' },
                h('div', { class: 'group' }, Object.entries(LIBRARY_SORTS).map(([key, info]) => h('button', {
                    type: 'button',
                    class: 'group-row',
                    onclick: () => {
                        sort = key;
                        saveSettings({ ...getSettings(), librarySort: key });
                        closeSheet();
                        refresh();
                    }
                }, h('span', { class: 'row-label' }, info.label), key === sort ? icon('check', { size: 20, strokeWidth: 2.4 }) : null))),
                h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
            )
        )
    }, icon('sort', { size: 18, strokeWidth: 2.2 }), h('span'));
    search.addEventListener('input', refresh);
    refresh();

    render(
        h('h1', { class: 'large-title' }, 'Library'),
        h('div', { class: 'search-row' },
            h('label', { class: 'search' }, icon('search', { size: 18, strokeWidth: 2.2 }), search),
            notes.length ? sortButton : null
        ),
        notes.length ? chips : null,
        notes.length && (themes.length || activeTag) ? topicChips : null,
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
        note.source?.partial ? h('p', { class: 'partial-note' },
            PARTIAL_NOTES[note.source.transcriptSource] || PARTIAL_NOTES.caption,
            note.source.transcriptError ? h('span', { class: 'partial-reason' }, ` Why: ${note.source.transcriptError}`) : null,
            // Sharing the link again only helps when the service that failed might work next time.
            note.source.url && note.source.transcriptSource !== 'paywall' ? ' Share the link again to retry.' : null
        ) : null,
        (() => {
            const theme = themeOf(note.id);
            const chips = [
                theme ? h('a', { class: 'chip topic-chip', href: `#/library?theme=${encodeURIComponent(theme.id)}`, 'aria-label': `Topic: ${theme.label}` }, topicMark(theme.label, theme.color)) : null,
                ...(note.tags || [])
                    // A tag that just repeats the theme or topic adds nothing.
                    .filter((tag) => ![theme?.label, note.topic].some((name) => name && name.toLowerCase().replace(/\s+/g, '-') === tag.toLowerCase()))
                    .map((tag) => h('a', { class: 'chip tag-chip', href: `#/library?tag=${encodeURIComponent(tag)}` }, tag))
            ].filter(Boolean);
            return chips.length ? h('div', { class: 'chips wrap' }, chips) : null;
        })(),
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
        const linkCard = (c) => h('div', { class: 'link-row' },
            h('a', { class: 'link-card', href: `#/note/${encodeURIComponent(c.noteId)}` },
                h('div', { class: 'relation' }, c.relation.replace('-', ' ')),
                h('div', { class: 'title' }, byId.get(c.noteId).title),
                h('div', { class: 'reason' }, c.reason)
            ),
            h('button', {
                type: 'button',
                class: 'link-remove',
                'aria-label': `Remove link to ${byId.get(c.noteId).title}`,
                onclick: () => confirmRemoveLink(note, byId.get(c.noteId))
            }, icon('close', { size: 16, strokeWidth: 2.2 }))
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
            const settings = getSettings();
            const themes = currentThemes();
            const data = buildGraph(notes, { showConcepts: settings.showConcepts, focusId: note.id, depth: 2, themes });
            if (data.nodes.length > 1 && canvas.isConnected) {
                // The small map keeps theme colors but skips areas and names.
                new GraphView(canvas, { focusId: note.id, onOpen: openNode, colorBy: settings.mapColor, themes: themes.themes, areas: false }).setData(data);
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
        note.source?.transcriptSource && note.source.transcriptSource !== 'paywall' ? h('p', { class: 'group-footer' }, `Transcript from ${TRANSCRIPT_LABELS[note.source.transcriptSource] || note.source.transcriptSource}`) : null,
        note.model ? h('p', { class: 'group-footer' }, `${note.depth ? `${note.autoDepth ? 'Auto → ' : ''}${depthLabel(note.depth)} breakdown` : 'Breakdown'} by ${note.model}`) : null
    ];
}

// ---------- Corrections: links and topics ----------

// Links you removed stay removed, even after a re-analysis.
function linkBlocked(a, b) {
    return (a?.removedLinks || []).includes(b?.id) || (b?.removedLinks || []).includes(a?.id);
}

function keepAllowedLinks(note, connections) {
    return (connections || []).filter((c) => !linkBlocked(note, notes.find((n) => n.id === c.noteId)));
}

function confirmRemoveLink(note, other) {
    openSheet(
        h('h3', {}, 'Remove this link?'),
        h('p', { class: 'muted' }, `“${note.title}” and “${other.title}” won't be linked any more, and a re-analysis won't bring the link back.`),
        h('div', { class: 'stack' },
            h('button', { type: 'button', class: 'btn primary block', onclick: () => removeLink(note, other) }, 'Remove link'),
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
        )
    );
}

async function removeLink(note, other) {
    closeSheet();
    [note, other].forEach((n) => {
        const partner = n === note ? other : note;
        n.connections = (n.connections || []).filter((c) => c.noteId !== partner.id);
    });
    note.removedLinks = [...new Set([...(note.removedLinks || []), other.id])];
    await saveMany([note, other]);
    notes = await allNotes();
    toast('Link removed');
    route();
}

function topicSheet(note) {
    const others = knownTopics(notes.filter((n) => n.id !== note.id)).slice(0, 24);
    const field = h('input', { class: 'field', type: 'text', placeholder: 'Topic, e.g. Journaling', 'aria-label': 'Topic', autocapitalize: 'words', maxlength: '40' });
    field.value = note.topic || '';
    const save = async (value) => {
        const topic = value.trim().replace(/[.#]/g, '').slice(0, 40);
        if (!topic) return;
        note.topic = topic;
        note.topicByUser = true;
        await saveNote(note);
        notes = await allNotes();
        syncPreferences();
        closeSheet();
        toast(`Topic set to ${topic}`);
        route();
    };
    openSheet(
        h('h3', {}, 'What is this note about?'),
        h('p', { class: 'small muted' }, 'The main subject, not things it mentions in passing. Notes with the same topic are grouped together on the map.'),
        others.length ? h('div', { class: 'chips wrap', style: { margin: '10px 0 4px' } },
            others.map((t) => h('button', { type: 'button', class: `chip${t.toLowerCase() === (note.topic || '').toLowerCase() ? ' active' : ''}`, onclick: () => save(t) }, t))) : null,
        h('form', { class: 'stack', onsubmit: (event) => { event.preventDefault(); save(field.value); } },
            field,
            h('button', { type: 'submit', class: 'btn primary block' }, 'Save topic'),
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
        )
    );
}

// Fills in topics for notes saved before topics existed (or whose breakdown
// didn't return one). One cheap call per 150 notes. Automatic for unlimited
// plans; others start it from Settings.
let topicsRunning = false;
function notesWithoutTopic() {
    return notes.filter((n) => !String(n.topic || '').trim());
}

async function backfillTopics({ manual = false } = {}) {
    const missing = notesWithoutTopic();
    if (topicsRunning || !missing.length || !getSettings().token) return 0;
    topicsRunning = true;
    let updated = 0;
    try {
        for (let i = 0; i < missing.length; i += 150) {
            const batch = missing.slice(i, i + 150);
            const assignments = await assignTopics(batch, knownTopics(notes));
            const changed = batch.filter((n) => assignments[n.id]).map((n) => ({ ...n, topic: assignments[n.id] }));
            if (changed.length) await saveMany(changed);
            updated += changed.length;
            notes = await allNotes();
        }
        if (manual) toast(updated ? `Sorted ${updated} note${updated === 1 ? '' : 's'} by topic` : 'Nothing to sort');
    } catch (error) {
        if (manual) toast(error.message);
    } finally {
        topicsRunning = false;
    }
    if (updated && !pending) route();
    return updated;
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
                    shareFile(new File([toMarkdown(note, byId, { theme: themeOf(note.id)?.label })], fileName(note), { type: 'text/markdown' }));
                }),
                actionRow(note.topic ? `Topic: ${note.topic}` : 'Set topic', 'themes', () => topicSheet(note)),
                note.source?.partial && href && note.source.transcriptSource !== 'paywall' ? actionRow('Get the full transcript', 'refresh', () => retryTranscript(note)) : null,
                note.source?.partial ? actionRow(note.source.transcriptSource === 'paywall' ? 'Paste the full article' : 'Paste the full text', 'clipboard', () => pasteFullTextSheet(note)) : null,
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

// Fetches a caption-only note's link again (the transcript services may have
// been off or failing) and replaces the note in place.
async function retryTranscript(note) {
    closeSheet();
    if (pending) return;
    toast('Getting the full transcript…');
    pending = runCapture({ retry: note });
    try {
        const fresh = await pending;
        toast(fresh.source?.partial ? 'Still caption-only. See the note for why.' : 'Updated with the full transcript');
    } catch (error) {
        toast(error.message);
    } finally {
        pending = null;
        if (location.hash.includes(encodeURIComponent(note.id))) route();
    }
}

// A partial note (paywalled article, caption only) redone with text you paste:
// open the page where you're logged in, copy the text, paste it here.
function pasteFullTextSheet(note) {
    const field = h('textarea', { class: 'field', rows: '8', placeholder: 'Paste the full text here', 'aria-label': 'Full text' });
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, 'Break it down');
    openSheet(
        h('h3', {}, 'Paste the full text'),
        h('p', { class: 'small muted' }, note.source?.transcriptSource === 'paywall'
            ? 'Open the article in Safari while you\'re logged in, choose Select All, Copy, then paste it here. The note keeps its place and anything you wrote.'
            : 'Paste the full transcript or text. The note keeps its place and anything you wrote.'),
        h('form', {
            class: 'stack',
            onsubmit: async (event) => {
                event.preventDefault();
                if (!field.value.trim() || pending) return;
                closeSheet();
                toast('Breaking it down…');
                pending = runCapture({ replace: note, text: field.value });
                try {
                    await pending;
                    toast('Updated with the full text');
                } catch (error) {
                    toast(error.message);
                } finally {
                    pending = null;
                    if (location.hash.includes(encodeURIComponent(note.id))) route();
                }
            }
        }, field, submit, h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel'))
    );
}

async function reanalyze(note, depth) {
    closeSheet();
    toast(`Re-analyzing (${depthLabel(depth || getSettings().depth)})…`);
    try {
        const result = await capture({ text: note.sourceText, title: note.source?.title || note.title, depth }, notes.filter((n) => n.id !== note.id));
        const fresh = buildNote(result, note.title);
        ['tldr', 'summary', 'outline', 'concepts', 'tags', 'quotes', 'takeaways', 'connections', 'model', 'depth', 'autoDepth'].forEach((key) => { note[key] = fresh[key]; });
        if (!note.topicByUser) note.topic = fresh.topic;
        note.connections = keepAllowedLinks(note, note.connections);
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

function themeSheet(theme) {
    const members = theme.noteIds.map((id) => notes.find((n) => n.id === id)).filter(Boolean);
    openSheet(
        h('div', { class: 'source-line' }, h('span', {}, `Topic · ${members.length} notes`)),
        h('h3', { class: 'topic-title', style: { 'margin-top': '4px' } }, topicMark(theme.label, theme.color)),
        theme.tags.length ? h('p', { class: 'small muted' }, `Common tags: ${theme.tags.join(', ')}`) : null,
        h('div', { class: 'stack' },
            h('div', { class: 'group' }, members.slice(0, 12).map(noteRow)),
            h('a', { class: 'btn primary block', href: `#/library?theme=${encodeURIComponent(theme.id)}` }, members.length > 12 ? `See all ${members.length} in Library` : 'Open in Library')
        )
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
    const themes = currentThemes();
    const byTheme = settings.mapColor === 'theme';
    const canvas = h('canvas', { 'aria-label': 'Map of your notes' });
    const search = h('input', { type: 'search', placeholder: 'Find on map', 'aria-label': 'Find on map', enterkeyhint: 'search' });
    const colorButton = h('button', {
        type: 'button',
        class: `float-button glass${byTheme ? ' on' : ''}`,
        'aria-label': byTheme ? 'Color by source' : 'Color by theme',
        'aria-pressed': String(byTheme)
    }, icon('themes', { size: 20, strokeWidth: 2 }));
    const conceptsButton = h('button', { type: 'button', class: `float-button glass${settings.showConcepts ? ' on' : ''}`, 'aria-label': 'Toggle shared ideas', 'aria-pressed': String(settings.showConcepts) }, icon('concept', { size: 20, strokeWidth: 2 }));
    const fitButton = h('button', { type: 'button', class: 'float-button glass', 'aria-label': 'Fit to screen' }, icon('fit', { size: 20, strokeWidth: 2 }));
    const types = [...new Set(notes.map((n) => n.source?.sourceType || 'text'))];
    const unsorted = notes.length - themes.byNote.size;

    let graph = null;
    let activeTheme = null;
    const legend = h('div', { class: 'graph-legend' });
    const paintLegend = () => {
        legend.replaceChildren();
        if (byTheme && themes.themes.length) {
            // Tap a theme to light it up on the map; tap it again for its notes.
            themes.themes.forEach((theme) => legend.append(h('button', {
                type: 'button',
                class: `legend-item glass${activeTheme === theme.id ? ' active' : ''}`,
                style: { '--dot': `var(--theme-${theme.color})` },
                onclick: () => {
                    if (activeTheme === theme.id) {
                        themeSheet(theme);
                        return;
                    }
                    activeTheme = theme.id;
                    search.value = '';
                    graph.highlightTheme(theme.id);
                    paintLegend();
                }
            }, topicMark(theme.label, theme.color), h('span', { class: 'count' }, String(theme.noteIds.length)))));
            if (unsorted) legend.append(h('span', { class: 'legend-item glass', style: { '--dot': 'var(--theme-none)' } }, h('i'), 'Unsorted', h('span', { class: 'count' }, String(unsorted))));
        } else {
            types.forEach((type) => legend.append(h('span', { class: 'legend-item glass', style: { '--dot': `var(--node-${type})` } }, h('i'), SOURCE_LABELS[type])));
            if (byTheme && notes.length >= 3) {
                legend.append(h('span', { class: 'legend-item glass' }, 'Themes appear as your notes start to connect'));
            }
        }
        if (settings.showConcepts) legend.append(h('span', { class: 'legend-item glass', style: { '--dot': byTheme && themes.themes.length ? 'var(--theme-none)' : 'var(--node-concept)' } }, h('i', { class: 'diamond' }), 'Shared idea'));
    };

    closeSheet();
    view.classList.add('full');
    view.replaceChildren(h('div', { class: 'graph-page' },
        canvas,
        h('div', { class: 'graph-top' },
            h('label', { class: 'search glass' }, icon('search', { size: 18, strokeWidth: 2.2 }), search),
            colorButton,
            conceptsButton,
            fitButton
        ),
        legend
    ));

    graph = new GraphView(canvas, { onOpen: previewNode, colorBy: settings.mapColor, themes: themes.themes });
    graph.setData(buildGraph(notes, { showConcepts: settings.showConcepts, themes }));
    paintLegend();
    search.addEventListener('input', () => {
        if (activeTheme) {
            activeTheme = null;
            paintLegend();
        }
        graph.setHighlight(search.value);
    });
    canvas.addEventListener('click', (event) => {
        // Tapping empty map space (not a dot, not a drag) clears a theme highlight.
        const rect = canvas.getBoundingClientRect();
        if (activeTheme && !graph.nodeAt(event.clientX - rect.left, event.clientY - rect.top)) {
            activeTheme = null;
            graph.highlightTheme(null);
            paintLegend();
        }
    });
    fitButton.addEventListener('click', () => graph.fit());
    colorButton.addEventListener('click', () => {
        saveSettings({ ...getSettings(), mapColor: byTheme ? 'source' : 'theme' });
        graphView();
    });
    conceptsButton.addEventListener('click', () => {
        saveSettings({ ...getSettings(), showConcepts: !settings.showConcepts });
        graphView();
    });
}

// ---------- Settings ----------

// Run JavaScript on Web Page: reads the article from the page in your own
// Safari (where you're logged in) and hands it back to the Shortcut.
const PAGE_SCRIPT = 'var e=document.querySelector("article")||document.querySelector("main")||document.body;var t=(e.innerText||"").trim();completion(JSON.stringify({url:location.href,title:document.title,text:t.length>=200?t.slice(0,400000):""}));';

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

// iOS-style segmented control. options: [[value, label], ...]
function segmentedControl(label, options, value, onChange) {
    const control = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
    const paint = (current) => [...control.children].forEach((b) => {
        const on = b.dataset.value === current;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
    options.forEach(([key, text]) => control.append(h('button', {
        type: 'button',
        role: 'radio',
        'data-value': key,
        onclick: () => {
            paint(key);
            onChange(key);
        }
    }, text)));
    paint(value);
    return control;
}

const SERVICE_PROBLEMS = {
    api_key_rejected: 'key rejected',
    out_of_credits: 'out of credits',
    model_not_available: 'model not available',
    unreachable: 'not reachable'
};

// Server status: what's switched on, and (on request) whether each key works.
function serverStatusSection() {
    const box = h('div', { class: 'group' }, h('div', { class: 'group-row' }, h('span', { class: 'row-label muted' }, 'Checking…')));
    const footer = h('p', { class: 'group-footer' });
    const row = (label, state, ok) => h('div', { class: 'group-row' },
        h('span', { class: 'row-label' }, label),
        h('span', { class: `row-value ${ok ? 'ok' : 'muted'}` }, state));
    const paint = (health, deep) => {
        const problems = { ...(health.problems || {}), ...(health.serviceProblems || {}) };
        const serviceState = (name, on) => {
            if (!on) return ['Off', false];
            if (problems[name]) return [`On, ${SERVICE_PROBLEMS[problems[name]] || problems[name]}`, false];
            return [deep ? 'On, key works' : 'On', true];
        };
        const claude = health.checks?.anthropicKey
            ? (deep ? (health.checks.model ? ['Working', true] : [`Problem: ${problems.model || 'check failed'}`, false]) : ['Connected', true])
            : ['No API key on the server', false];
        const gemini = serviceState('gemini', health.services?.gemini);
        const supadata = serviceState('supadata', health.services?.supadata);
        box.replaceChildren(
            row('Claude breakdowns', ...claude),
            row('YouTube without captions (Gemini)', ...gemini),
            row('TikTok speech (Supadata)', ...supadata),
            actionRow('Run a full check', 'refresh', () => load(true))
        );
        const off = !health.services?.gemini || !health.services?.supadata;
        footer.textContent = [
            deep
                ? `Full check done: storage ${health.checks?.storage ? 'OK' : 'failing'}, server version ${health.version}.`
                : 'A full check also tests storage and each API key. It\'s free.',
            off ? 'To turn a service on, add its key as a Secret in Cloudflare (see Setup guide below).' : ''
        ].filter(Boolean).join(' ');
    };
    const load = (deep) => {
        if (deep) box.firstChild?.replaceChildren(h('span', { class: 'row-label muted' }, 'Running full check…'));
        fetchHealth({ deep }).then((health) => paint(health, deep)).catch((error) => {
            box.replaceChildren(h('div', { class: 'group-row' }, h('span', { class: 'row-label error' }, error.message)));
        });
    };
    load(false);
    return [h('div', { class: 'section-label' }, 'Server status'), box, footer];
}

async function checkForUpdates() {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (!registration) {
        toast('Updates aren\'t available in this browser view');
        return;
    }
    toast('Checking for updates…');
    try {
        await registration.update();
        const incoming = registration.installing || registration.waiting;
        // A found update installs and reloads the app on its own.
        if (!incoming) toast(`You're on the latest version (${APP_VERSION})`);
    } catch {
        toast('Couldn\'t check for updates. Try again when you\'re online.');
    }
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
            const control = segmentedControl('Breakdown style', Object.entries(DEPTH_INFO).map(([key, info]) => [key, info.label]), settings.depth, (key) => {
                saveSettings({ ...getSettings(), depth: key });
                detail.textContent = DEPTH_INFO[key].detail;
                syncPreferences();
            });
            return h('div', { class: 'card' }, control, detail, h('p', { class: 'small muted', style: { margin: '8px 2px 0' } }, 'Any note can be re-done in depth later from its ••• menu.'));
        })(),

        h('div', { class: 'section-label' }, 'Map'),
        (() => {
            const themes = currentThemes();
            const detailText = h('p', { class: 'small muted', style: { margin: '10px 2px 0' } });
            const paintDetail = () => {
                const current = currentThemes();
                const count = current.themes.length;
                detailText.textContent = `${THEME_DETAIL[getSettings().themeDetail]?.detail || ''} ${count
                    ? `Your library has ${count} theme${count === 1 ? '' : 's'}${notes.length - current.byNote.size ? `; ${notes.length - current.byNote.size} note${notes.length - current.byNote.size === 1 ? '' : 's'} not in a theme yet` : ''}.`
                    : 'Themes appear once a few notes share tags, ideas or links.'}`;
            };
            paintDetail();
            return h('div', { class: 'card' },
                h('div', { class: 'small muted', style: { margin: '0 2px 6px' } }, 'Color notes by'),
                segmentedControl('Color notes by', [['theme', 'Theme'], ['source', 'Source']], settings.mapColor, (value) => saveSettings({ ...getSettings(), mapColor: value })),
                h('div', { class: 'small muted', style: { margin: '14px 2px 6px' } }, 'Theme detail'),
                segmentedControl('Theme detail', Object.entries(THEME_DETAIL).map(([key, info]) => [key, info.label]), settings.themeDetail, (value) => {
                    saveSettings({ ...getSettings(), themeDetail: value });
                    paintDetail();
                }),
                detailText,
                (() => {
                    // Notes saved before topics existed can be sorted in one go.
                    const missing = notesWithoutTopic().length;
                    if (!missing || !settings.token) return null;
                    return h('button', {
                        type: 'button',
                        class: 'btn block',
                        style: { 'margin-top': '12px' },
                        onclick: async (event) => {
                            event.currentTarget.disabled = true;
                            event.currentTarget.textContent = 'Sorting…';
                            await backfillTopics({ manual: true });
                            if (location.hash.startsWith('#/settings')) settingsView();
                        }
                    }, `Sort ${missing} note${missing === 1 ? '' : 's'} by topic`);
                })(),
                h('div', { class: 'small muted', style: { margin: '14px 2px 6px' } }, 'Shared ideas'),
                segmentedControl('Shared ideas', [['show', 'Show'], ['hide', 'Hide']], settings.showConcepts ? 'show' : 'hide', (value) => saveSettings({ ...getSettings(), showConcepts: value === 'show' })),
                h('p', { class: 'small muted', style: { margin: '8px 2px 0' } }, `Shared ideas are the diamonds linking notes that mention the same concept.${themes.themes.length ? ' Tap a theme under the map to light it up; tap it again to see its notes.' : ''}`)
            );
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
        settings.token ? serverStatusSection() : null,

        h('div', { class: 'section-label' }, 'Save from the Share button'),
        h('div', { class: 'card' },
            h('p', { class: 'small muted' }, 'One Shortcut works from Substack, other apps and Safari. It saves the link first, even when Claude is busy. In Safari it can also send the article text you can see while logged in.'),
            h('ol', { class: 'steps' },
                h('li', {}, 'Open ', h('b', {}, 'Shortcuts'), ', tap ', h('b', {}, '+'), ', and name it ', h('b', {}, 'Save to AidedMind'), '.'),
                h('li', {}, 'Tap ', h('b', {}, 'ⓘ'), ', turn on ', h('b', {}, 'Show in Share Sheet'), ', and receive ', h('b', {}, 'Safari web pages'), ', ', h('b', {}, 'URLs'), ' and ', h('b', {}, 'Text'), '.'),
                h('li', {}, 'Add ', h('b', {}, 'Get Type of Shortcut Input'), ' and an ', h('b', {}, 'If'), ' action: if it is a Safari web page, run the Safari steps below; otherwise run the app steps. Keep Shortcut Input as the input to the JavaScript action.'),
                h('li', {}, h('b', {}, 'Safari branch: '), 'Add ', h('b', {}, 'Run JavaScript on Web Page'), ' with this script:', copyField(PAGE_SCRIPT, 'Script'), ' Then add Get Contents of URL, Method POST, Request Body File = JavaScript Result.'),
                h('li', {}, h('b', {}, 'App branch: '), 'Add Get URLs from Shortcut Input. Add Get Contents of URL, Method POST, Request Body JSON with a Text field named ', h('b', {}, 'url'), ' set to the first URL. For a plain text share with no URL, send it as a Text field named ', h('b', {}, 'text'), '.'),
                h('li', {}, 'For both Get Contents of URL actions use this inbox URL:', copyField(inboxUrl, 'Inbox URL'), ' Add the header ', h('b', {}, 'X-AidedMind-Token'), ' with your token:', settings.token ? copyField(settings.token, 'Token') : h('div', { class: 'small error' }, 'Save your token above first.')),
                h('li', {}, 'After each POST, show a notification with its Contents of URL so you see whether the link was saved.')
            ),
            h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'From a paid article inside Substack, the app may share only a link. AidedMind keeps it in Library → Shared links as Needs article text when the server cannot read it. Tap Add text there to finish the same item.')
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
        h('p', { class: 'group-footer' }, `${notes.length} note${notes.length === 1 ? '' : 's'}, stored only on this device. Back up now and then: deleting the app deletes its notes.`),
        accounts,

        h('div', { class: 'section-label' }, 'About'),
        h('div', { class: 'group' },
            h('div', { class: 'group-row' }, h('span', { class: 'row-label' }, 'App version'), h('span', { class: 'row-value muted' }, APP_VERSION)),
            actionRow('Check for updates', 'refresh', () => checkForUpdates()),
            actionRow('Setup guide and help', 'external', () => window.open('https://github.com/AidedMarketing/AidedMind#readme', '_blank', 'noopener'))
        ),
        h('p', { class: 'group-footer' }, 'Updates install on their own when you open the app.'),
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
        return { name: `AidedMind/${name}`, content: toMarkdown(note, byId, { theme: themeOf(note.id)?.label }) };
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

// notesChanged: an open note may have been replaced, so redraw it too.
function refreshInboxViews(notesChanged = false) {
    if (pending) return;
    const onNote = location.hash.startsWith('#/note/');
    if ((onNote && notesChanged) || location.hash.startsWith('#/library') || location.hash === '' || location.hash === '#/') route();
}

// Shared links are broken down on the server as soon as they arrive. When the
// app opens it collects the finished notes; anything the server couldn't
// finish is done here, as before. A link the server can never read is kept
// locally with its reason (retry or remove it from the Library); a temporary
// failure stays in the inbox for next time.
let inboxPollTimer;

// Queued work belongs to the server. The app collects results but does not
// race an alarm or spend quota again when Claude is temporarily unavailable.
function inboxAction(item) {
    if (item.status === 'done' && item.result) return 'import';
    if (item.status === 'failed') {
        if (item.errorKind === 'needs_text') return 'needs_text';
        return item.errorKind === 'retry_in_app' ? 'attention' : 'report';
    }
    if (!item.queued) return 'foreground'; // shared before the server worked in the background
    return 'wait';
}

function addTextToShare(item) {
    const field = h('textarea', { class: 'field', rows: '8', placeholder: 'Paste the article text you can read', 'aria-label': 'Article text' });
    openSheet(
        h('h3', {}, 'Add article text'),
        h('p', { class: 'small muted' }, 'This link is saved. If the article opens in your app, copy its text here. AidedMind will finish the same shared item.'),
        h('form', { class: 'stack', onsubmit: async (event) => {
            event.preventDefault();
            if (!field.value.trim()) return;
            try {
                await updateInboxItem(item.id, { text: field.value });
                closeSheet();
                toast('Text added. Breakdown queued.');
                await drainInbox();
            } catch (error) { toast(error.message); }
        } }, field, h('button', { type: 'submit', class: 'btn primary block' }, 'Add text'),
        h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel'))
    );
}

function recordFailedShare(item, message) {
    saveFailedShares([...failedShares().filter((f) => f.id !== item.id), {
        id: item.id, url: item.url, text: item.text, title: item.title, error: message, at: new Date().toISOString()
    }]);
}

// Adds a note the server finished. The server doesn't have your library, so
// links to your other notes are worked out now (one small call).
async function importFinished(item) {
    const { source, analysis, model, depth, auto } = item.result;
    const previous = findDuplicate(notes, source.url, item.url, source.sharedUrl);
    if (previous && !previous.source?.partial) return 'duplicate';
    const others = notes.filter((n) => n.id !== previous?.id);
    let connections = [];
    if (others.length) {
        try {
            connections = await suggestConnections(analysis, source, others);
        } catch {
            connections = []; // the note is still worth adding without links
        }
    }
    await finishNote({ source, analysis: { ...analysis, connections }, model, depth, auto, replaces: previous?.id || null });
    return 'saved';
}

function scheduleInboxPoll() {
    clearTimeout(inboxPollTimer);
    // Only links still being worked on; ones that failed here wait for you.
    if (!inbox.pending.some((item) => inboxAction(item) === 'wait' && !inbox.errors.has(item.id))) return;
    inboxPollTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') drainInbox();
        else scheduleInboxPoll();
    }, 20000);
}

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
        inbox.pending = items.filter((item) => ['wait', 'needs_text', 'attention'].includes(inboxAction(item)));
        inbox.checkedAt = Date.now();
        const work = items.filter((item) => !['wait', 'needs_text', 'attention'].includes(inboxAction(item)));
        if (!items.length && manual) toast('No shared links waiting');
        for (let i = 0; i < work.length; i++) {
            const item = work[i];
            const action = inboxAction(item);
            setBanner([h('div', { class: 'pulse' }, icon('inbox', { size: 16 })), h('span', {}, `Adding ${work.length > 1 ? `${i + 1} of ${work.length} shared links` : 'your shared link'}…`)]);
            if (action === 'report') {
                // The server tried and won't get anywhere; say why instead of retrying forever.
                recordFailedShare(item, item.error || 'This link couldn\'t be broken down.');
                await removeInboxItem(item.id).catch(() => {});
                failed++;
                continue;
            }
            try {
                if (action === 'import') {
                    if (item.result.duplicate || await importFinished(item) === 'duplicate') already++;
                    else saved++;
                } else {
                    // A page you captured yourself (or a link shared before): skip what's already saved.
                    const saved_ = item.url && findDuplicate(notes, item.url);
                    if (saved_ && !saved_.source?.partial) throw new DuplicateError(saved_);
                    await runCapture(item.text ? { url: item.url, text: item.text, title: item.title } : { input: item.url, title: item.title });
                    saved++;
                }
                await removeInboxItem(item.id);
                inbox.errors.delete(item.id);
            } catch (error) {
                if (error instanceof DuplicateError) {
                    await removeInboxItem(item.id).catch(() => {});
                    inbox.errors.delete(item.id);
                    already++;
                    continue;
                }
                failed++;
                const permanent = error.status && error.status < 500 && ![401, 402, 403, 429].includes(error.status);
                if (permanent) {
                    recordFailedShare(item, error.message);
                    await removeInboxItem(item.id).catch(() => {});
                } else {
                    inbox.errors.set(item.id, error.message);
                    inbox.pending.push(item);
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
        scheduleInboxPoll();
        if (saved || already) {
            toast([
                saved ? `${saved} shared link${saved === 1 ? '' : 's'} added` : '',
                already ? `${already} already in your library` : ''
            ].filter(Boolean).join(' · '));
        }
        if (updateReady && !failed) showUpdateBanner();
        if (failed) {
            setBanner([
                icon('inbox', { size: 18, strokeWidth: 2 }),
                h('span', { style: { flex: '1' } }, `${failed} shared link${failed === 1 ? '' : 's'} couldn't be broken down.`),
                h('a', { href: '#/library', onclick: () => setBanner(null) }, 'View')
            ]);
        }
        refreshInboxViews(saved > 0);
    }
}

function sharedItemsSection() {
    const failed = failedShares();
    const waiting = inbox.pending;
    if (!failed.length && !waiting.length && !inbox.checkError) return null;
    const label = (item) => item.title || hostOf(item.url) || (item.url || item.text || '').slice(0, 60) || 'Shared item';
    const openArticle = (item) => {
        const href = safeHref(item.url);
        return href ? h('a', { class: 'btn small-btn', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open article') : null;
    };
    const retryTime = (item) => {
        const when = Date.parse(item.nextRetryAt || '');
        if (!Number.isFinite(when)) return 'AidedMind will retry automatically.';
        if (when <= Date.now()) return 'AidedMind will retry soon.';
        return `AidedMind will retry around ${new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    };
    const retryItem = (item) => h('button', { type: 'button', class: 'btn small-btn', onclick: async () => {
        try {
            await updateInboxItem(item.id, {});
            toast('Retry queued.');
            await drainInbox();
        } catch (error) { toast(error.message); }
    } }, 'Try again');
    const addText = (item) => h('button', { type: 'button', class: 'btn small-btn', onclick: () => addTextToShare(item) }, 'Add text');
    const removeItem = (item) => h('button', { type: 'button', class: 'btn small-btn', onclick: async () => {
        try { await removeInboxItem(item.id); await drainInbox(); }
        catch (error) { toast(error.message); }
    } }, 'Remove');
    const row = (item, status, actions) => h('div', { class: 'group-row' },
        h('span', { class: 'row-icon' }, icon('inbox', { size: 16, strokeWidth: 2 })),
        h('span', { class: 'row-label' },
            h('div', { style: { 'font-weight': '600', 'overflow-wrap': 'anywhere' } }, label(item)),
            h('div', { class: 'small', style: { color: status.error ? 'var(--danger)' : 'var(--text-2)' } }, status.text),
            h('div', { class: 'row', style: { display: 'flex', gap: '8px', 'margin-top': '8px', 'flex-wrap': 'wrap' } }, actions)
        )
    );
    return [
        h('div', { class: 'section-label' }, 'Shared links'),
        h('div', { class: 'group' },
            inbox.checkError ? h('div', { class: 'group-body small error' }, `Couldn't check your inbox: ${inbox.checkError}`) : null,
            waiting.map((item) => {
                const action = inboxAction(item);
                const status = action === 'needs_text'
                    ? { text: `Needs article text. ${item.error || 'AidedMind could not read this link.'}`, error: true }
                    : action === 'attention'
                        ? { text: `Automatic attempts stopped. ${item.error || 'AidedMind could not read the article.'} Add text or try again later.`, error: true }
                        : item.status === 'processing'
                            ? { text: 'Reading this article now…' }
                            : { text: `${item.error ? `${item.error} ` : 'Saved. Waiting for breakdown. '}${retryTime(item)}` };
                const actions = action === 'attention'
                    ? [openArticle(item), addText(item), retryItem(item), removeItem(item)]
                    : action === 'needs_text'
                        ? [openArticle(item), addText(item), removeItem(item)]
                        : [openArticle(item), item.status === 'pending' ? addText(item) : null];
                return row(item, status, actions);
            }),
            failed.map((item) => row(item, { text: item.error, error: true }, [
                openArticle(item),
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
        failed.length ? h('p', { class: 'group-footer' }, 'For a login-only article, share it from logged-in Safari with Save to AidedMind, or paste text into the Add tab.') : null
    ];
}

// ---------- Routing & startup ----------

// ---------- App updates ----------

// A new version installs in the background (checked on every open); once it
// takes over, reload straight away when nothing is in progress, otherwise
// offer a reload so nothing typed or running is lost.
function watchForUpdates() {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let registration = null;
    navigator.serviceWorker.register('service-worker.js')
        .then((reg) => { registration = reg; })
        .catch((error) => console.warn('SW registration failed', error));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration?.update().catch(() => {});
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return; // first install, not an update
        const typing = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
        const busy = pending || inboxRunning || typing || draft.input.trim() || draft.photos.length;
        if (!busy) {
            reloading = true;
            location.reload();
            return;
        }
        updateReady = true;
        showUpdateBanner();
    });
}

let updateReady = false;

function showUpdateBanner() {
    setBanner([
        icon('refresh', { size: 18, strokeWidth: 2 }),
        h('span', { style: { flex: '1' } }, 'AidedMind has been updated.'),
        h('a', { href: '#', onclick: (event) => { event.preventDefault(); location.reload(); } }, 'Reload')
    ]);
}

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
    syncPreferences();
    drainInbox().then(() => {
        if (getLastUsage()?.limit === null) backfillTopics();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') drainInbox();
    });
    if ('serviceWorker' in navigator) {
        watchForUpdates();
    }
}

start();
