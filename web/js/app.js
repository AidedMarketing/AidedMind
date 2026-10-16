import { normalizeKnowledge, topicIdentity, mergeTopics, renameTopic, splitTopic, undoTopicChange, connectionReview, mergeConnections, linkBlocked, sourceVersion, retryDue, failedLinking, matchesNote, conceptKey } from './knowledge.js';
import { allNotes, saveNote, saveMany, updateMany, updateNote, deleteNote, newId } from './db.js';
import { capture, DuplicateError, checkAuth, getSettings, saveSettings, splitInput, fetchInbox, queueInboxItem, removeInboxItem, updateInboxItem, serverBase, fetchHealth, assignTopics, putPreferences, suggestConnections, getLastUsage, adminListUsers, adminCreateUser, connectionSetupIssue } from './api.js';
import { buildGraph, GraphView } from './graph.js';
import { buildThemes, THEME_DETAIL } from './themes.js';
import { knownTopics, conceptVocabulary, knownUrlHashes, findDuplicate, preserveUpdatedNote } from './library.js';
import { toMarkdown, fileName } from './markdown.js';
import { icon } from './icons.js';
import { createZip } from './zip.js';
import { preparePhoto, MAX_PHOTOS } from './photos.js';

const view = document.getElementById('view');
const navbar = document.getElementById('navbar');
const SOURCE_LABELS = { article: 'Article', youtube: 'YouTube', tiktok: 'TikTok', text: 'Text', photo: 'Photos' };
const SOURCE_ICONS = { article: 'article', youtube: 'youtube', tiktok: 'tiktok', text: 'text', concept: 'concept', photo: 'photo' };
const NOTE_TABS = ['Breakdown', 'Links', 'Notes'];
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
    thorough: { label: 'Thorough', detail: 'Deepest reasoning (Claude Opus). Slower and uses the most; for long or dense pieces.' },
    expanded: { label: 'More detail', detail: 'A fuller breakdown of this note, using the same source text.' }
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
const APP_VERSION = '35';

let notes = [];
let activeMap = null;
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

// Local display preferences do not change the knowledge data or server settings.
const DISPLAY_KEY = 'aidedmind.display';
function displayPreferences() {
    try { return JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}'); } catch { return {}; }
}
function applyDisplay() {
    const preferences = displayPreferences();
    const root = document.documentElement;
    root.dataset.appearance = ['light', 'dark'].includes(preferences.appearance) ? preferences.appearance : 'auto';
    root.dataset.largeText = String(Boolean(preferences.largeText));
    root.dataset.reducedMotion = String(Boolean(preferences.reducedMotion));
}
function updateDisplay(patch) {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify({ ...displayPreferences(), ...patch }));
    applyDisplay();
}
applyDisplay();

function publicationHeader(label, title, description) {
    return h('header', { class: 'publication-header' },
        h('p', { class: 'editorial-label' }, label),
        h('h1', { class: 'large-title' }, title),
        description ? h('p', { class: 'publication-deck' }, description) : null);
}
function fabricMark(size = 44) {
    return h('span', { class: 'fabric-mark', style: { width: `${size}px`, height: `${size}px` }, 'aria-hidden': 'true' });
}
function readingTime(note) {
    const words = note.source?.wordCount || (note.sourceText?.match(/\S+/g) || []).length;
    return words ? `${Math.max(1, Math.ceil(words / 220))} min read` : '';
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

function connectionCount(note) {
    const existing = new Set(notes.map((n) => n.id));
    const ids = new Set((note.connections || []).map((c) => c.noteId).filter((id) => id !== note.id && existing.has(id)));
    notes.forEach((other) => {
        if (other.id !== note.id && (other.connections || []).some((c) => c.noteId === note.id)) ids.add(other.id);
    });
    return ids.size;
}

function noteRow(note) {
    const type = note.source?.sourceType || 'text';
    const origin = note.source?.author || note.source?.siteName || hostOf(note.source?.url) || SOURCE_LABELS[type];
    const links = connectionCount(note);
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
                [origin, readingTime(note), note.source?.partial ? 'Needs your help' : 'Ready', relativeDate(note.createdAt)].filter(Boolean).join(' · '))
        ),
        links ? h('span', { class: 'connection-glyph', 'aria-label': `${links} connection${links === 1 ? '' : 's'}` },
            icon('graph', { size: 15, strokeWidth: 2 }), String(links)) : null
    );
}

// ---------- Nav bar ----------

function setNav({ title = '', left = null, right = null, hidden = false } = {}) {
    document.body.dataset.screen = title === 'Library' ? 'library' : title === 'More' ? 'settings' : title === 'Add' ? 'capture' : title === 'Explore' ? 'graph' : 'note';
    navbar.classList.toggle('hidden-bar', hidden);
    document.getElementById('nav-title').textContent = title;
    const imprint = !hidden && !left && ['Library', 'More', 'Add', 'Explore'].includes(title)
        ? h('div', { class: 'navbar-imprint', 'aria-label': 'AidedMind' }, fabricMark(24), h('span', {}, 'AidedMind')) : null;
    navbar.classList.toggle('has-imprint', Boolean(imprint));
    document.getElementById('nav-left').replaceChildren(...[left || imprint].flat().filter(Boolean));
    document.getElementById('nav-right').replaceChildren(...[right].flat().filter(Boolean));
    updateNavShadow();
}

function updateNavShadow() {
    navbar.classList.toggle('scrolled', window.scrollY > 28);
}

window.addEventListener('scroll', updateNavShadow, { passive: true });

function navButton(label, onclick, iconName) {
    if (iconName === 'add' && !label) label = 'Add';
    return h('button', { type: 'button', class: `nav-button${label ? '' : ' icon-only'}`, onclick, 'aria-label': label || iconName },
        iconName ? icon(iconName, { size: 24, strokeWidth: 2 }) : null,
        label
    );
}

// ---------- Sheets ----------

let sheetReturnFocus = null;
let sheetBackground = [];
function closeSheet() {
    const root = document.getElementById('sheet-root');
    if (!root.childElementCount) return;
    root.replaceChildren();
    sheetBackground.forEach(([element, inert]) => { element.inert = inert; });
    sheetBackground = [];
    document.body.classList.remove('sheet-open');
    if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus({ preventScroll: true });
    sheetReturnFocus = null;
}

function openSheet(...content) {
    const root = document.getElementById('sheet-root');
    if (!root.childElementCount) sheetReturnFocus = document.activeElement;
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
        h('div', { class: 'grabber', 'aria-hidden': 'true' }),
        h('button', { type: 'button', class: 'sheet-close', 'aria-label': 'Close dialog', onclick: closeSheet }, icon('close', { size: 20 })),
        content);
    const heading = sheet.querySelector('h1, h2, h3');
    if (heading) { heading.id = 'sheet-heading'; sheet.setAttribute('aria-labelledby', heading.id); }
    else sheet.setAttribute('aria-label', 'AidedMind dialog');
    root.replaceChildren(h('div', { class: 'sheet-scrim', onclick: closeSheet, 'aria-hidden': 'true' }), sheet);
    if (!sheetBackground.length) {
        sheetBackground = [...document.body.children].filter((el) => ![root, document.getElementById('toast')].includes(el)).map((el) => [el, el.inert]);
        sheetBackground.forEach(([el]) => { el.inert = true; });
    }
    document.body.classList.add('sheet-open');
    sheet.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
        if (event.key !== 'Tab') return;
        const focusable = [...sheet.querySelectorAll('button, a[href], input, textarea, select, summary, [tabindex="0"]')]
            .filter((el) => !el.disabled && el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (!first) { event.preventDefault(); sheet.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    // Focus before returning so early Escape/Tab cannot land on inert background.
    const initialFocus = sheet.querySelector('input:not([type="file"]), textarea:not([readonly])') || sheet.querySelector('button') || sheet;
    initialFocus.focus({ preventScroll: true });
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
    const id = newId();
    const createdAt = new Date().toISOString();
    return {
        id,
        createdAt,
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
            transcriptError: result.source.transcriptError || '',
            captureKind: result.source.captureKind || '',
            imageCount: result.source.imageCount || 0,
            wordCount: result.source.wordCount || (result.source.sourceType === 'article' ? (result.source.text.match(/\S+/g) || []).length : 0)
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
        connections: (a.connections || []).map((c) => ({
            ...c,
            noteId: String(c.noteId || ''),
            targetId: String(c.noteId || ''),
            sourceId: id,
            origin: c.origin === 'user' ? 'user' : 'aidedmind',
            confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 0.8,
            createdAt
        })).filter((c) => c.noteId),
        removedLinks: [],
        rejectedLinks: [],
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
async function runCapture({ input = '', url: explicitUrl, text: explicitText, title, photos = [], retry = null, replace = null, augment = null }) {
    let result;
    if (retry) {
        result = await capture({ url: retry.source?.sharedUrl || retry.source?.url, retry }, notes);
    } else if (replace) {
        if (!explicitText?.trim()) throw new Error('Paste the article text first.');
        result = await capture({ url: replace.source?.url, title: replace.source?.title || replace.title, text: explicitText.trim(), replace }, notes);
    } else if (photos.length) {
        result = await capture({ text: input.trim(), title, photos, augment }, notes);
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
    let note = normalizeKnowledge(buildNote(result, title), notes);
    const previous = result.replaces && notes.find((n) => n.id === result.replaces);
    if (previous) {
        note = preserveUpdatedNote(note, previous);
        note.connections = keepAllowedLinks(note, note.connections);
    }
    note.connections = (note.connections || []).map((connection) => ({
        ...connection,
        sourceId: note.id,
        targetId: connection.noteId,
        origin: connection.origin === 'user' ? 'user' : 'aidedmind',
        createdAt: connection.createdAt || new Date().toISOString()
    }));
    note = normalizeKnowledge(note, notes);
    note.linking = result.linking || { status: 'complete', attempts: 0 };
    const changed = [note];
    if (previous && sourceVersion(previous) !== note.sourceVersion) {
        notes.filter((other) => other.id !== note.id && (other.connections || []).some((link) => link.noteId === note.id && link.origin !== 'user')).forEach((other) => {
            changed.push({ ...other, connections: other.connections.filter((link) => link.noteId !== note.id || link.origin === 'user'), linking: { status: 'pending', attempts: 0 } });
        });
    }
    await saveMany(changed);
    notes = await allNotes();
    syncPreferences();
    scheduleLinkRetry();
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
        const addedLinks = (note.connections || []).length;
        toast(addedLinks ? `Saved · ${addedLinks} connection${addedLinks === 1 ? '' : 's'} added` : 'Saved to your Library');
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
                toast('Saved in Shared links. AidedMind will finish preparing it when the service is available.');
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
            h('div', { class: 'pulse' }, fabricMark(32)),
            h('div', {}, h('strong', {}, 'Preparing'), h('span', {}, draft.photos.length ? 'AidedMind is preparing your photos. You can keep reading.' : 'AidedMind is preparing it. You can keep reading.')))
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
        publicationHeader('A NEW ENTRY', 'Add', 'Keep something worth returning to.'),
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
            error ? h('div', { role: 'alert' }, h('p', { class: 'error small', style: { 'margin-top': '12px' } }, 'Needs your help. Check your connection or try again.'), h('details', { class: 'diagnostic-detail' }, h('summary', {}, 'Advanced diagnostics'), h('p', { class: 'small muted' }, error))) : null,
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

let refreshLibrary = null;
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
    setNav({ title: 'Library', right: [
        navButton('', () => drainInbox({ manual: true }), 'inbox'),
        navButton('', () => { location.hash = '#/capture'; }, 'add')
    ] });
    let activeTag = params.get('tag') || '';
    let activeType = '';
    let activeTheme = params.get('theme') || '';
    let { themes, byNote } = currentThemes();
    if (activeTheme && !themes.some((t) => t.id === activeTheme)) activeTheme = '';
    const search = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search library', enterkeyhint: 'search' });
    search.value = params.get('q') || '';
    const list = h('div');
    const chips = h('div', { class: 'chips' });
    const topicChips = h('div', { class: 'chips topic-row' });

    let presentTypes = Object.keys(SOURCE_LABELS).filter((type) => notes.some((n) => (n.source?.sourceType || 'text') === type));

    const refresh = () => {
        ({ themes, byNote } = currentThemes());
        if (activeTheme && !themes.some((theme) => theme.id === activeTheme)) activeTheme = '';
        presentTypes = Object.keys(SOURCE_LABELS).filter((type) => notes.some((n) => (n.source?.sourceType || 'text') === type));
        chips.hidden = !notes.length;
        topicChips.hidden = !notes.length || !(themes.length || activeTag);
        sortButton.hidden = !notes.length;
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
            list.replaceChildren(h('div', { class: 'empty' }, fabricMark(60), h('strong', {}, 'Your Library is ready for its first idea.'), 'Tap + to save a link, or share from another app with the AidedMind Shortcut.'));
            return;
        }
        if (!matches.length) {
            list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'No results'), 'Try a different word or filter.'));
            return;
        }
        sortButton.lastChild.textContent = LIBRARY_SORTS[sort].label;
        sortButton.setAttribute('aria-label', `Sort notes: ${LIBRARY_SORTS[sort].label}`);
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
        publicationHeader('COLLECTED EDITION', 'Library', 'Ideas worth keeping, with context intact and connections growing quietly.'),
        h('div', { class: 'search-row' },
            h('label', { class: 'search' }, icon('search', { size: 18, strokeWidth: 2.2 }), search),
            sortButton
        ),
        chips,
        topicChips,
        h('section', { id: 'library-shares', 'aria-label': 'Shared links' }, sharedItemsSection()),
        list
    );
    refreshLibrary = () => {
        const previousFocus = document.activeElement;
        const rowHref = previousFocus?.closest('.note-row')?.getAttribute('href');
        const chipLabel = previousFocus?.closest('.chips') ? previousFocus.getAttribute('aria-label') || previousFocus.textContent : null;
        refresh();
        const shares = document.getElementById('library-shares');
        if (shares) { shares.replaceChildren(); append(shares, [sharedItemsSection()]); }
        if (previousFocus && !previousFocus.isConnected) {
            const replacement = rowHref
                ? [...view.querySelectorAll('.note-row')].find((el) => el.getAttribute('href') === rowHref)
                : chipLabel ? [...view.querySelectorAll('.chips button')].find((el) => (el.getAttribute('aria-label') || el.textContent) === chipLabel) : null;
            replacement?.focus({ preventScroll: true });
        }
    };
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
    setNav({
        title: note.title,
        left: back,
        right: [
            navButton('', () => { location.hash = '#/capture'; }, 'add'),
            navButton('', () => noteActions(note, byId), 'more')
        ]
    });

    const rememberedTab = noteTab.get(note.id);
    const active = NOTE_TABS.includes(rememberedTab) ? rememberedTab : 'Breakdown';
    const panel = h('div', { class: 'tab-panel', role: 'tabpanel', id: 'piece-panel' });
    const segmented = h('div', { class: 'segmented', role: 'tablist' });
    const selectTab = (name, reveal = true) => {
        noteTab.set(note.id, name);
        [...segmented.children].forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === name);
            b.setAttribute('aria-selected', String(b.dataset.tab === name));
            b.tabIndex = b.dataset.tab === name ? 0 : -1;
        });
        document.body.dataset.panel = name.toLowerCase();
        panel.setAttribute('aria-labelledby', `piece-tab-${name.toLowerCase()}`);
        panel.replaceChildren();
        append(panel, [notePanel(name, note, byId)]);
        // A short panel must not inherit a deep scroll position from Breakdown.
        // Keep the tabs and the new panel heading visible without moving focus.
        if (reveal) {
            const panelTop = window.scrollY + panel.getBoundingClientRect().top;
            const chromeHeight = document.getElementById('navbar').offsetHeight + segmented.parentElement.offsetHeight;
            window.scrollTo({ top: Math.max(0, panelTop - chromeHeight - 16), behavior: 'instant' });
        }
    };
    NOTE_TABS.forEach((name) => segmented.append(h('button', {
        type: 'button', role: 'tab', id: `piece-tab-${name.toLowerCase()}`, 'aria-controls': 'piece-panel',
        'data-tab': name, onclick: () => selectTab(name),
        onkeydown: (event) => {
            const index = NOTE_TABS.indexOf(name);
            const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
            if (next === null) return;
            event.preventDefault(); selectTab(NOTE_TABS[next]); segmented.children[next].focus();
        }
    }, name)));

    const origin = [note.source?.author || note.source?.siteName || hostOf(note.source?.url), readingTime(note), note.source?.partial ? 'Needs your help' : 'Ready', relativeDate(note.createdAt)].filter(Boolean).join(' · ');
    render(
        h('div', { class: 'source-line' }, sourceTile(type, 14), h('span', {}, `${SOURCE_LABELS[type]}${origin ? ` · ${origin}` : ''}`)),
        h('h1', { class: 'note-title' }, note.title),
        note.photos?.length ? h('div', { class: 'photo-strip note-photos' },
            note.photos.map((src, index) => h('div', { class: 'photo-thumb' }, h('img', { src, alt: `Photo ${index + 1}` })))) : null,
        note.source?.partial ? h('p', { class: 'partial-note' },
            PARTIAL_NOTES[note.source.transcriptSource] || PARTIAL_NOTES.caption,
            note.source.transcriptError ? h('details', { class: 'diagnostic-detail' }, h('summary', {}, 'Advanced diagnostics'), h('p', {}, note.source.transcriptError)) : null,
            // Sharing the link again only helps when the service that failed might work next time.
            note.source.url && note.source.transcriptSource !== 'paywall' ? ' Share the link again to retry.' : null
        ) : null,
        note.source?.wordCount ? h('p', { class: 'small muted' }, `${note.source.wordCount.toLocaleString()} words captured${note.source.captureKind === 'safari' ? ' from Safari' : ''}.${note.source.imageCount ? ` This page has images AidedMind may not have read (${note.source.imageCount}).` : ''}`,
            note.source.imageCount ? h('button', { type: 'button', class: 'btn small-btn', onclick: () => addScreenshots(note) }, 'Add screenshots') : null) : null,
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
        connectionCount(note) ? h('a', {
            class: 'connection-summary',
            href: `#/graph?focus=${encodeURIComponent(note.id)}`,
            'aria-label': `${connectionCount(note)} connection${connectionCount(note) === 1 ? '' : 's'} · Explore in Map`
        }, icon('graph', { size: 18, strokeWidth: 2 }), h('span', {}, `${connectionCount(note)} connection${connectionCount(note) === 1 ? '' : 's'}`), h('span', { class: 'connection-summary-arrow', 'aria-hidden': 'true' }, '→')) : null,
        h('div', { class: 'sticky-tabs' }, segmented),
        panel
    );
    selectTab(active, false);
}

function notePanel(name, note, byId) {
    if (name === 'Breakdown') {
        const blocks = note.tldr ? [h('p', { class: 'summary-lead' }, note.tldr)] : [];
        if (note.summary?.length) {
            blocks.push(
                h('h2', { class: 'breakdown-heading' }, 'Summary'),
                h('div', { class: 'card prose' }, note.summary.map((section, i) => [
                    h('h3', { style: i === 0 ? { 'margin-top': '0' } : null }, section.heading),
                    h('p', {}, section.body)
                ]))
            );
        }
        if (note.takeaways?.length) {
            blocks.push(
                h('h2', { class: 'breakdown-heading' }, 'Takeaways'),
                h('div', { class: 'card prose' }, h('ul', { class: 'takeaway-list' }, note.takeaways.map((takeaway) => h('li', {}, takeaway))))
            );
        }
        // Quotes are published only when an exact source passage is available.
        const verifiedQuotes = (note.quotes || []).filter((quote) => typeof quote === 'string' && quote.trim() && note.sourceText?.includes(quote));
        if (verifiedQuotes.length) {
            blocks.push(
                h('h2', { class: 'breakdown-heading' }, 'Worth quoting'),
                h('div', { class: 'quote-collection' }, verifiedQuotes.map((quote) => h('figure', { class: 'quote-entry' },
                    h('blockquote', { class: 'quote' }, quote),
                    h('figcaption', {}, h('span', { class: 'quote-verified' }, 'Source verified'),
                        h('button', { type: 'button', class: 'text-button', onclick: () => {
                            const start = note.sourceText.indexOf(quote);
                            openSheet(h('h3', {}, 'Source passage'),
                                h('p', { class: 'source-passage' }, note.sourceText.slice(Math.max(0, start - 200), start),
                                    h('mark', {}, quote), note.sourceText.slice(start + quote.length, start + quote.length + 200)),
                                h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Done'));
                        } }, 'View source passage')))))
            );
        }
        if (note.outline?.length) {
            blocks.push(
                h('h2', { class: 'breakdown-heading' }, 'Outline'),
                h('details', { class: 'outline-card', open: true },
                    h('summary', {}, h('span', {}, 'Source structure'), h('span', { class: 'small muted' }, `${note.outline.length} points`)),
                    h('ul', { class: 'outline' }, note.outline.map((item) => h('li', { class: `l${item.level}`, style: { '--level': String(item.level) } }, item.text)))
                )
            );
        }
        return blocks.length ? h('div', { class: 'breakdown-flow' }, blocks) : h('p', { class: 'muted' }, 'No breakdown available.');
    }

    if (name === 'Links') {
        const outgoing = (note.connections || []).filter((c) => byId.has(c.noteId));
        const backlinks = notes.flatMap((other) => (other.connections || [])
            .filter((c) => c.noteId === note.id && other.id !== note.id && !outgoing.some((o) => o.noteId === other.id))
            .map((c) => ({ ...c, noteId: other.id })));
        const allLinks = [...outgoing, ...backlinks];
        const linkCard = (connection) => {
            const other = byId.get(connection.noteId);
            if (!other) return null;
            const automatic = connection.origin !== 'user';
            return h('div', { class: 'link-row' },
                h('a', { class: 'link-card', href: `#/note/${encodeURIComponent(connection.noteId)}` },
                    h('div', { class: 'link-topline' },
                        h('span', { class: `link-origin ${automatic ? 'automatic' : 'manual'}` }, automatic ? 'AidedMind' : 'You'),
                        h('span', { class: 'relation' }, String(connection.relation || 'related').replace('-', ' '))
                    ),
                    h('div', { class: 'title' }, other.title),
                    h('div', { class: 'reason' }, connection.reason || (automatic ? 'AidedMind connected these ideas.' : 'Linked by you.')),
                    connection.evidence ? h('div', { class: 'link-evidence small muted' }, `“${connection.evidence.source}” · “${connection.evidence.target}”`) : null
                ),
                h('button', {
                    type: 'button',
                    class: 'link-remove',
                    'aria-label': automatic ? `Mark link to ${other.title} as not related` : `Remove link to ${other.title}`,
                    onclick: () => confirmRemoveLink(note, other, connection)
                }, icon('close', { size: 16, strokeWidth: 2.2 }))
            );
        };
        return [
            h('p', { class: 'editorial-label' }, 'REFERENCES'),
            h('div', { class: 'connection-intro' },
                h('div', {},
                    h('h2', { class: 'panel-title' }, 'Connections'),
                    h('p', { class: 'small muted' }, `${allLinks.length} connection${allLinks.length === 1 ? '' : 's'}`),
                    h('p', { class: 'small muted' }, 'AidedMind links strong relationships automatically as your Library grows. You can add your own or remove anything that does not belong.')
                ),
                h('button', { type: 'button', class: 'btn small-btn', onclick: () => openManualLinkSheet(note) }, icon('add', { size: 16, strokeWidth: 2 }), 'Add a link')
            ),
            note.linking?.status === 'pending' ? h('div', { class: 'link-retry-status', role: 'status' },
                h('p', { class: 'small muted' }, 'This piece is saved. Its connections still need to be checked.'),
                h('button', { type: 'button', class: 'btn small-btn', disabled: linkRetryRunning, onclick: async (event) => {
                    event.currentTarget.disabled = true;
                    try {
                        await updateNote(note.id, (current) => ({ ...current, linking: { ...current.linking, status: 'pending', attempts: 0, nextAttemptAt: 0, paused: false } }));
                        notes = await allNotes();
                        await retryPendingLinks();
                        route();
                    } catch (error) { toast(error.message); event.currentTarget.disabled = false; }
                } }, 'Retry connections')) : null,
            allLinks.length
                ? h('div', { class: 'group connection-group' }, allLinks.map(linkCard).filter(Boolean))
                : h('div', { class: 'card muted' }, notes.length > 1 ? 'No strong connections yet. AidedMind will keep building the graph as you save more.' : 'Connections appear as your Library grows.'),
            h('a', { class: 'connection-map-payoff', href: `#/graph?focus=${encodeURIComponent(note.id)}` },
                h('div', { class: 'connection-map-glyph', 'aria-hidden': 'true' }, icon('graph', { size: 22, strokeWidth: 1.8 })),
                h('div', { class: 'connection-map-copy' },
                    h('strong', {}, 'Explore these ideas in Map'),
                    h('span', {}, 'See how this piece fits into your larger knowledge fabric.')
                ),
                h('span', { class: 'connection-map-arrow', 'aria-hidden': 'true' }, '→')
            ),
            note.concepts?.length ? [
                h('h2', { class: 'breakdown-heading' }, 'Concepts'),
                h('div', { class: 'concept-list' }, note.concepts.map((c) => h('a', { class: 'concept', href: `#/library?q=${encodeURIComponent(c.name)}` }, h('strong', {}, c.name), h('span', {}, c.description))))
            ] : null
        ];
    }

    const userNotes = h('textarea', { class: 'field', placeholder: 'What do you want to remember, challenge, apply or connect?', 'aria-label': 'My notes', rows: '8' });
    userNotes.value = note.userNotes || '';
    const saveState = h('span', { class: 'note-save-state', role: 'status', 'aria-live': 'polite' }, 'Saved');
    let saveTimer;
    userNotes.addEventListener('input', () => {
        saveState.textContent = 'Saving…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            const value = userNotes.value;
            note.userNotes = value;
            try {
                await updateNote(note.id, (current) => ({ ...current, userNotes: value }));
                if (value === userNotes.value) { saveState.textContent = 'Saved'; saveState.classList.remove('error'); }
            } catch {
                saveState.textContent = 'Error — your text is still here. Edit to retry.';
                saveState.classList.add('error');
            }
        }, 500);
    });
    return [
        h('p', { class: 'editorial-label' }, 'MARGINALIA'),
        h('div', { class: 'notes-heading' },
            h('div', {}, h('h2', { class: 'panel-title' }, 'Your Notes'), h('p', { class: 'small muted' }, 'Your thinking stays separate from AidedMind\'s breakdown.')),
            saveState
        ),
        userNotes,
        h('div', { class: 'notes-actions' },
            h('button', { type: 'button', class: 'btn small-btn', onclick: () => openManualLinkSheet(note) }, icon('graph', { size: 16, strokeWidth: 2 }), 'Link this note')
        ),
        h('button', { type: 'button', class: 'btn small-btn', onclick: () => pasteFullTextSheet(note) }, 'Import full text'),
        note.sourceText ? [h('h2', { class: 'breakdown-heading' }, 'Captured source'), h('details', { class: 'card' }, h('summary', {}, 'Show full text'), h('div', { class: 'source-text' }, note.sourceText))] : null,
        note.source?.transcriptSource && note.source.transcriptSource !== 'paywall' ? h('p', { class: 'group-footer' }, `Transcript from ${TRANSCRIPT_LABELS[note.source.transcriptSource] || note.source.transcriptSource}`) : null,
        note.model ? h('p', { class: 'group-footer' }, `${note.depth ? `${note.autoDepth ? 'Auto → ' : ''}${depthLabel(note.depth)} breakdown` : 'Breakdown'} by ${note.model}`) : null
    ];
}

// ---------- Corrections: links and topics ----------

// Links you removed stay removed, even after a re-analysis.

function keepAllowedLinks(note, connections) {
    return (connections || []).filter((c) => !linkBlocked(note, notes.find((n) => n.id === c.noteId)));
}

function confirmRemoveLink(note, other, connection = null) {
    const automatic = connection?.origin !== 'user';
    openSheet(
        h('h3', {}, automatic ? 'Not related?' : 'Remove this link?'),
        h('p', { class: 'muted' }, automatic
            ? `AidedMind will remove the link between “${note.title}” and “${other.title}” and remember not to recreate it automatically.`
            : `Remove the link you created between “${note.title}” and “${other.title}”?`),
        h('div', { class: 'stack' },
            h('button', { type: 'button', class: 'btn primary block', onclick: () => removeLink(note, other, { blockAutomatic: automatic }) }, automatic ? 'Not related' : 'Remove link'),
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
        )
    );
}

async function removeLink(note, other, { blockAutomatic = true } = {}) {
    closeSheet();
    [note, other].forEach((n) => {
        const partner = n === note ? other : note;
        n.connections = (n.connections || []).filter((c) => c.noteId !== partner.id);
    });
    if (blockAutomatic) {
        [note, other].forEach((item) => {
            const partner = item.id === note.id ? other : note;
            item.removedLinks = [...new Set([...(item.removedLinks || []), partner.id])];
            item.rejectedLinks = [...(item.rejectedLinks || []).filter((entry) => entry?.noteId !== partner.id), { noteId: partner.id, rejectedAt: new Date().toISOString() }];
        });
    }
    await saveMany([note, other]);
    notes = await allNotes();
    toast(blockAutomatic ? 'AidedMind will remember that' : 'Link removed');
    route();
}

function openManualLinkSheet(note) {
    const search = h('input', { class: 'field', type: 'search', placeholder: 'Search your Library…', 'aria-label': 'Search notes to link', enterkeyhint: 'search' });
    const results = h('div', { class: 'group manual-link-results' });
    const linkedIds = () => {
        const ids = new Set((note.connections || []).map((c) => c.noteId));
        notes.forEach((other) => {
            if ((other.connections || []).some((c) => c.noteId === note.id)) ids.add(other.id);
        });
        return ids;
    };
    const paint = () => {
        const query = search.value.trim().toLowerCase();
        const already = linkedIds();
        const matches = notes
            .filter((other) => other.id !== note.id && !already.has(other.id))
            .filter((other) => !query || [other.title, other.tldr, other.topic, ...(other.tags || [])].join(' ').toLowerCase().includes(query))
            .slice(0, 30);
        results.replaceChildren(...(matches.length ? matches.map((other) => h('button', {
            type: 'button',
            class: 'group-row manual-link-choice',
            onclick: async () => {
                const now = new Date().toISOString();
                [note, other].forEach((item, index) => {
                    const partner = index === 0 ? other : note;
                    item.removedLinks = (item.removedLinks || []).filter((id) => id !== partner.id);
                    item.rejectedLinks = (item.rejectedLinks || []).filter((entry) => entry?.noteId !== partner.id);
                });
                note.connections = [
                    ...(note.connections || []).filter((c) => c.noteId !== other.id),
                    {
                        noteId: other.id,
                        sourceId: note.id,
                        targetId: other.id,
                        relation: 'related',
                        reason: 'Linked by you.',
                        confidence: 1,
                        origin: 'user',
                        createdAt: now
                    }
                ];
                await saveMany([note, other]);
                notes = await allNotes();
                closeSheet();
                toast('Link added');
                route();
            }
        }, h('span', { class: 'row-label' }, other.title), h('span', { class: 'row-value muted' }, other.topic || SOURCE_LABELS[other.source?.sourceType || 'text']))) : [
            h('div', { class: 'group-body small muted' }, query ? 'No unlinked notes match that search.' : 'Everything in your Library is already connected to this piece.')
        ]));
    };
    search.addEventListener('input', paint);
    paint();
    openSheet(
        h('h3', {}, 'Link an idea'),
        h('p', { class: 'small muted' }, 'Choose something this piece genuinely connects to. Your link becomes part of the same Map as AidedMind\'s automatic connections.'),
        search,
        results,
        h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
    );
}

function topicSheet(note) {
    const others = knownTopics(notes.filter((n) => n.id !== note.id)).slice(0, 24);
    const field = h('input', { class: 'field', type: 'text', placeholder: 'Topic, e.g. Journaling', 'aria-label': 'Topic', autocapitalize: 'words', maxlength: '40' });
    field.value = note.topic || '';
    const save = async (value) => {
        const topic = value.trim().replace(/[.#]/g, '').slice(0, 40);
        if (!topic) return;
        note.topic = topic;
        delete note.topicId;
        note.topicAliases = [];
        Object.assign(note, normalizeKnowledge(note, notes));
        note.topicByUser = true;
        await saveNote(note);
        notes = await allNotes();
        syncPreferences();
        closeSheet();
        toast(`Topic set to ${note.topic}`);
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

function refreshConnectionReview() {
    document.querySelectorAll('[data-connection-review]').forEach((panel) => panel.refresh());
}
function connectionReviewPanel({ inSheet = false } = {}) {
    const heading = h('h4', { class: 'editorial-label', hidden: inSheet });
    const summary = h('p', { class: 'small', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
    const progress = h('progress', { 'aria-label': 'Connection review progress' });
    const help = h('p', { class: 'small muted' });
    const error = h('p', { class: 'small error', role: 'alert' });
    let changing = false;
    const act = async (button, transform) => {
        if (changing) return;
        const restoreFocus = document.activeElement === button;
        changing = true; button.disabled = true; error.textContent = '';
        try {
            await updateMany(transform);
            notes = await allNotes(); refreshConnectionReview(); scheduleLinkRetry();
        } catch (failure) { error.textContent = failure.message; }
        finally {
            changing = false; panel.refresh();
            if (restoreFocus && panel.isConnected) (button.hidden ? (pause.hidden ? summary : pause) : button).focus({ preventScroll: true });
        }
    };
    const pause = h('button', { type: 'button', class: 'btn block', onclick: (event) => {
        const review = connectionReview(notes, activeLinkId);
        const ids = new Set(review.members.map((note) => note.id));
        act(event.currentTarget, (current) => current.map((note) => ids.has(note.id) && note.linking?.status === 'pending'
            ? { ...note, linking: { ...note.linking, paused: !review.paused } } : note));
    } });
    const retry = h('button', { type: 'button', class: 'btn block', onclick: (event) => {
        const ids = new Set(connectionReview(notes).members.map((note) => note.id));
        act(event.currentTarget, (current) => current.map((note) => ids.has(note.id) && note.linking?.status === 'pending' && note.linking.attempts >= 3
            ? { ...note, linking: { ...note.linking, attempts: 0, nextAttemptAt: 0 } } : note));
    } }, 'Retry failed');
    const panel = h('div', { class: 'connection-review', 'data-connection-review': '' }, heading, summary, progress, help, error, pause, retry);
    panel.refresh = () => {
        const focused = document.activeElement;
        const review = connectionReview(notes, activeLinkId);
        panel.hidden = !review.total;
        heading.textContent = review.id ? 'Library connection review' : 'Pending connection checks';
        summary.textContent = `${review.complete} of ${review.total} complete · ${review.running} checking · ${review.queued} queued · ${review.failed} failed`;
        progress.max = Math.max(1, review.total); progress.value = review.complete;
        help.textContent = !review.pending ? 'Review complete. Your current connections are saved.'
            : review.paused ? 'Paused. A check already in progress may finish. Resume when you are ready.'
            : !getSettings().token ? 'Connect your server in Capture & Sharing to continue.'
            : navigator.onLine === false ? 'Waiting for a connection. Reviews resume when you are online.'
            : review.failed === review.pending ? 'Some checks could not finish after three attempts. Retry failed to try those pieces again.'
            : 'Keep AidedMind open. Checks wait while you capture or type; temporary failures retry automatically.';
        pause.hidden = !review.pending; pause.disabled = changing;
        pause.textContent = review.paused ? 'Resume review' : 'Pause review';
        retry.hidden = !review.failed; retry.disabled = changing;
        if ((focused === pause || focused === retry) && focused.hidden) summary.focus({ preventScroll: true });
    };
    panel.refresh(); return panel;
}
function reviewLibraryConnectionsSheet({ start = false } = {}) {
    const review = connectionReview(notes, activeLinkId);
    if (!start && review.total) {
        openSheet(h('h3', {}, 'Connection review'), connectionReviewPanel({ inSheet: true }),
            !review.pending ? h('button', { type: 'button', class: 'btn block', onclick: () => reviewLibraryConnectionsSheet({ start: true }) }, 'Review again') : null,
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Close'));
        return;
    }
    const count = notes.length;
    const status = h('p', { class: 'small error', role: 'alert' });
    const submit = h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
        submit.disabled = true;
        try {
            const reviewId = newId(), reviewStartedAt = new Date().toISOString();
            await updateMany((current) => current.map((note) => ({ ...note, linking: { status: 'pending', attempts: 0, reviewId, reviewStartedAt } })));
            notes = await allNotes(); refreshConnectionReview(); scheduleLinkRetry(); reviewLibraryConnectionsSheet(); toast('Connection review queued');
        } catch (error) { status.textContent = error.message; submit.disabled = false; }
    } }, 'Review connections');
    openSheet(h('h3', {}, 'Review library connections?'), h('p', { class: 'small muted' },
        `Check ${count} saved pieces against your current library, using up to ${count} initial connection requests. Temporary failures may retry, up to three attempts per piece. This uses model tokens, without repeating the breakdowns. Keep AidedMind open while it works. Your own links and rejections stay.`), status,
        h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel'), submit);
}

let lastTopicChange = null;
async function saveTopicChange(transform, label) {
    const change = await updateMany(transform);
    if (!change.after.length) throw new Error('No pieces changed. Reopen Manage topics and try again.');
    lastTopicChange = { ...change, label };
    notes = await allNotes(); syncPreferences(); route(); manageTopicsSheet(); toast(`Topic ${label} saved`);
}
function topicEditSheet(from, split = false) {
    const members = notes.filter((note) => topicIdentity(note) === from.id);
    const selected = new Set();
    const field = h('input', { id: 'topic-name', class: 'field', type: 'text', maxlength: '40', autocapitalize: 'words', 'aria-describedby': 'topic-edit-error' });
    field.value = split ? '' : from.name;
    const error = h('p', { id: 'topic-edit-error', class: 'small error', role: 'alert' });
    field.addEventListener('input', () => { error.textContent = ''; field.removeAttribute('aria-invalid'); });
    const count = h('p', { class: 'small muted', role: 'status' }, '0 pieces selected');
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, split ? 'Move selected pieces' : 'Rename topic');
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (event) => {
        event.preventDefault(); submit.disabled = true; error.textContent = ''; field.removeAttribute('aria-invalid');
        try {
            await saveTopicChange((current) => split ? splitTopic(current, from.id, [...selected], field.value) : renameTopic(current, from.id, field.value), split ? 'split' : 'rename');
        } catch (failure) {
            error.textContent = failure.message; submit.disabled = false;
            if (!split || !selected.size || selected.size === members.length) {
                if (!split) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
            } else { field.setAttribute('aria-invalid', 'true'); field.focus(); }
        }
    } }, h('label', { for: 'topic-name', class: 'small' }, split ? 'New topic name' : 'Topic name'), field,
        split ? h('fieldset', { class: 'topic-piece-selector' }, h('legend', { class: 'small' }, 'Pieces to move'),
            h('div', { class: 'group topic-manager-list' }, members.map((note) => h('label', { class: 'topic-piece-choice' },
                h('input', { type: 'checkbox', value: note.id, onchange: (event) => {
                    if (event.currentTarget.checked) selected.add(note.id); else selected.delete(note.id);
                    error.textContent = ''; field.removeAttribute('aria-invalid');
                    count.textContent = `${selected.size} of ${members.length} pieces selected`;
                } }), h('span', {}, note.title)))), count) : null,
        error, submit, h('button', { type: 'button', class: 'btn block', onclick: manageTopicsSheet }, 'Cancel'));
    openSheet(h('h3', {}, split ? `Split ${from.name}` : `Rename ${from.name}`), h('p', { class: 'small muted' }, split
        ? 'Choose pieces for a new topic. Leave at least one in the original topic. Future captures using the original name still go there.'
        : `Rename all ${from.count} pieces. The old name stays as an alias for search and future captures. The topic keeps its place on the map.`), form);
}
function manageTopicsSheet() {
    const topics = new Map();
    notes.forEach((note) => {
        const id = topicIdentity(note);
        if (!id) return;
        const entry = topics.get(id) || { id, name: note.topic, count: 0 };
        entry.count++; topics.set(id, entry);
    });
    const entries = [...topics.values()].sort((a, b) => a.name.localeCompare(b.name));
    const merge = (from) => {
        openSheet(h('h3', {}, `Merge ${from.name}`), h('p', { class: 'small muted' }, `Choose the topic to keep. All ${from.count} pieces will move there.`),
            h('div', { class: 'group topic-manager-list' }, entries.filter((to) => to.id !== from.id).map((to) => h('button', { type: 'button', class: 'group-row', onclick: () => {
                const error = h('p', { class: 'small error', role: 'alert' });
                const submit = h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
                    submit.disabled = true;
                    try { await saveTopicChange((current) => mergeTopics(current, from.id, to.id), 'merge'); }
                    catch (failure) { error.textContent = failure.message; submit.disabled = false; }
                } }, 'Merge topics');
                openSheet(h('h3', {}, `Merge into ${to.name}?`), h('p', { class: 'small muted' }, `${from.name} will become an alias of ${to.name}. You can undo changes to these pieces from Manage topics during this session.`), error,
                    h('button', { type: 'button', class: 'btn block', onclick: manageTopicsSheet }, 'Cancel'), submit);
            } }, h('span', { class: 'row-label' }, to.name), h('span', { class: 'row-value muted' }, String(to.count))))),
            h('button', { type: 'button', class: 'btn block', onclick: manageTopicsSheet }, 'Back'));
    };
    const undoError = h('p', { class: 'small error', role: 'alert' });
    openSheet(h('h3', {}, 'Manage topics'), h('p', { class: 'small muted' }, 'Rename a topic, split a broad one, or merge duplicates. Choose a topic to see its options.'),
        h('div', { class: 'group topic-manager-list' }, entries.length ? entries.map((from) => h('button', { type: 'button', class: 'group-row', onclick: () => {
            openSheet(h('h3', {}, from.name), h('p', { class: 'small muted' }, `${from.count} saved piece${from.count === 1 ? '' : 's'}`),
                h('button', { type: 'button', class: 'btn block', onclick: () => topicEditSheet(from) }, 'Rename topic'),
                h('button', { type: 'button', class: 'btn block', disabled: from.count < 2, onclick: () => topicEditSheet(from, true) }, 'Split topic'),
                h('button', { type: 'button', class: 'btn block', disabled: entries.length < 2, onclick: () => merge(from) }, 'Merge with another topic'),
                h('button', { type: 'button', class: 'btn block', onclick: manageTopicsSheet }, 'Back'));
        } }, h('span', { class: 'row-label' }, from.name), h('span', { class: 'row-value muted' }, `${from.count} pieces`))) : h('p', { class: 'group-body small muted' }, 'Save a piece with a topic to begin.')),
        lastTopicChange ? h('p', { class: 'small muted' }, 'Undo restores your last topic action and its names for future captures. Newer content and separate topic edits stay.') : null,
        undoError,
        lastTopicChange ? h('button', { type: 'button', class: 'btn block', onclick: async (event) => {
            event.currentTarget.disabled = true;
            try {
                await updateMany((current) => undoTopicChange(current, lastTopicChange));
                const label = lastTopicChange.label; lastTopicChange = null;
                notes = await allNotes(); syncPreferences(); route(); manageTopicsSheet(); toast(`Topic ${label} undone`);
            } catch (error) { undoError.textContent = error.message; event.currentTarget.disabled = false; }
        } }, `Undo last ${lastTopicChange.label}`) : null,
        h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Close'));
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
            const changed = batch.filter((n) => assignments[n.id]).map((n) => normalizeKnowledge({ ...n, topic: assignments[n.id], topicId: undefined }, notes));
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
    const type = note.source?.sourceType || 'text';
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
                actionRow('Import full text', 'clipboard', () => pasteFullTextSheet(note)),
                actionRow(`Re-analyze (${depthLabel(getSettings().depth)})`, 'refresh', () => reanalyze(note)),
                !note.source?.partial ? actionRow('Give me more detail', 'sparkle', () => reanalyze(note, 'expanded')) : null,
                type === 'article' ? actionRow('Add screenshots', 'camera', () => addScreenshots(note)) : null
            ),
            h('div', { class: 'group' },
                actionRow('Delete note', 'trash', () => deleteNoteSheet(note), 'danger')
            ),
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel')
        )
    );
}

function deleteNoteSheet(note) {
    const status = h('p', { class: 'small error', role: 'alert' });
    const submit = h('button', { type: 'button', class: 'btn danger block', onclick: async () => {
        submit.disabled = true;
        try {
            const current = await allNotes();
            await deleteNote(note.id);
            const touched = current.filter((item) => item.id !== note.id && (item.connections || []).some((link) => link.noteId === note.id));
            if (touched.length) await saveMany(touched.map((item) => ({ ...item, connections: item.connections.filter((link) => link.noteId !== note.id) })));
            notes = await allNotes(); closeSheet(); toast('Deleted'); location.hash = '#/library';
        } catch (error) { status.textContent = error.message; submit.disabled = false; }
    } }, 'Delete note');
    openSheet(h('h3', {}, `Delete “${note.title}”?`), h('p', { class: 'small muted' }, 'This removes the saved piece and its connections from this device.'), status,
        h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Cancel'), submit);
}

function addScreenshots(note) {
    closeSheet();
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    document.body.append(input);
    input.addEventListener('change', async () => {
        const files = [...input.files].slice(0, MAX_PHOTOS);
        input.remove();
        if (!files.length || pending) return;
        try {
            toast('Preparing screenshots…');
            const photos = await Promise.all(files.map(preparePhoto));
            pending = runCapture({ augment: note, title: note.title, photos });
            await pending;
            toast('Note updated with screenshots');
        } catch (error) { toast(error.message); }
        finally {
            pending = null;
            if (location.hash.includes(encodeURIComponent(note.id))) route();
        }
    }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    input.click();
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

// Keep an unfinished import in memory when the sheet closes or a request fails.
const fullTextDrafts = new Map();
function pasteFullTextSheet(note) {
    const field = h('textarea', { id: 'full-text-input', class: 'field', rows: '6', placeholder: 'Paste the entire article or transcript here',
        'aria-describedby': 'full-text-help full-text-error', oninput: () => {
            fullTextDrafts.set(note.id, field.value);
            field.removeAttribute('aria-invalid');
            error.textContent = '';
        } });
    field.value = fullTextDrafts.get(note.id) || '';
    const error = h('p', { id: 'full-text-error', class: 'small error', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, 'Update breakdown');
    const form = h('form', {
        class: 'stack', novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            if (pending) { error.textContent = 'Another breakdown is running. Try again when it finishes.'; return; }
            if (!field.value.trim()) {
                error.textContent = 'Paste the full text first.';
                field.setAttribute('aria-invalid', 'true');
                field.focus();
                return;
            }
            fullTextDrafts.set(note.id, field.value);
            submit.disabled = true;
            field.disabled = true;
            form.setAttribute('aria-busy', 'true');
            error.textContent = 'Updating the breakdown…';
            pending = runCapture({ replace: note, text: field.value });
            try {
                await pending;
                fullTextDrafts.delete(note.id);
                if (form.isConnected) closeSheet();
                toast('Updated with the full text');
                if (location.hash.includes(encodeURIComponent(note.id))) route();
            } catch (failure) {
                error.textContent = `${failure.message} Your pasted text is still here. Try again.`;
            } finally {
                pending = null;
                submit.disabled = false;
                field.disabled = false;
                form.removeAttribute('aria-busy');
                if (form.isConnected) field.focus({ preventScroll: true });
            }
        }
    }, h('label', { for: 'full-text-input' }, 'Full text'), field, error, submit,
    h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Close'));
    openSheet(
        h('h3', {}, 'Import full text'),
        h('p', { id: 'full-text-help', class: 'small muted' }, 'Paste the complete text to replace the captured source and rebuild this breakdown. Your notes, links and place in the Library stay. This uses one breakdown.'),
        form
    );
}

async function reanalyze(note, depth) {
    closeSheet();
    toast(`Re-analyzing (${depthLabel(depth || getSettings().depth)})…`);
    try {
        const result = await capture({ text: note.sourceText, title: note.source?.title || note.title, depth }, notes.filter((n) => n.id !== note.id));
        await finishNote({ ...result, source: { ...note.source, text: note.sourceText }, replaces: note.id }, note.title);
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

function previewNode(node, focusId = null) {
    if (node.isNote) {
        const note = notes.find((n) => n.id === node.id);
        if (!note) return;
        const type = note.source?.sourceType || 'text';
        const focus = notes.find((piece) => piece.id === focusId);
        const connection = focus && ((focus.connections || []).find((link) => link.noteId === note.id) || (note.connections || []).find((link) => link.noteId === focusId));
        openSheet(
            h('div', { class: 'source-line' }, sourceTile(type, 14), h('span', {}, `${SOURCE_LABELS[type]} · ${relativeDate(note.createdAt)}`)),
            h('h3', { style: { 'margin-top': '8px' } }, note.title),
            h('p', { class: 'muted' }, note.tldr),
            connection ? h('p', { class: 'small muted' }, connection.reason) : null,
            h('div', { class: 'stack' }, h('a', { class: 'btn primary block', href: `#/note/${encodeURIComponent(note.id)}` }, 'Open note'), h('a', { class: 'btn block', href: `#/graph?focus=${encodeURIComponent(note.id)}` }, 'Explore connections'))
        );
        return;
    }
    const related = notes.filter((n) => (n.concepts || []).some((c) => conceptKey(c) === conceptKey(node.label)));
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

function graphView(params = new URLSearchParams()) {
    setNav({ title: 'Explore', right: navButton('', () => { location.hash = '#/capture'; }, 'add') });
    document.body.dataset.screen = 'graph';
    if (!notes.length) {
        render(publicationHeader('VISUAL INDEX', 'Explore', 'Choose a topic, then follow an idea.'),
            h('div', { class: 'empty' }, fabricMark(72), h('strong', {}, 'Your map will take shape as your Library grows.')));
        return;
    }
    const settings = getSettings();
    const themes = currentThemes();
    const focusId = notes.some((note) => note.id === params.get('focus')) ? params.get('focus') : null;
    let activeTheme = themes.themes.some((theme) => theme.id === params.get('theme')) ? params.get('theme') : null;
    let depth = Math.min(3, Math.max(1, Number(params.get('depth')) || 1));
    let showPieces = params.get('view') === 'pieces';
    let graphData;
    let graph;
    let layout;
    try { layout = JSON.parse(localStorage.getItem('aidedmind.map-layout.v2') || 'null'); } catch { /* disposable display state */ }
    if (!layout || typeof layout !== 'object' || !layout.anchors || !layout.positions) layout = { anchors: {}, positions: {} };
    for (const entries of [layout.anchors, layout.positions]) {
        for (const [id, point] of Object.entries(entries)) if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) delete entries[id];
    }
    const saveLayout = (value) => {
        try { localStorage.setItem('aidedmind.map-layout.v2', JSON.stringify(value)); } catch { /* knowledge still saves in IndexedDB */ }
    };
    const canvas = h('canvas', { 'aria-label': 'Knowledge map. Use Show Map as a list for the same pieces.' });
    const search = h('input', { type: 'search', placeholder: 'Find a topic or idea', 'aria-label': 'Find in your Map', enterkeyhint: 'search' });
    search.value = params.get('q') || '';
    const colorButton = h('button', { type: 'button', class: `float-button glass${settings.mapColor === 'theme' ? ' on' : ''}`, 'aria-label': settings.mapColor === 'theme' ? 'Color by source' : 'Color by theme', 'aria-pressed': String(settings.mapColor === 'theme') }, icon('themes', { size: 20 }));
    const conceptsButton = h('button', { type: 'button', class: `float-button glass${settings.showConcepts ? ' on' : ''}`, 'aria-label': 'Toggle shared ideas', 'aria-pressed': String(settings.showConcepts) }, icon('concept', { size: 20 }));
    const listButton = h('button', { type: 'button', class: 'float-button glass', 'aria-label': 'Show Map as a list', 'aria-pressed': 'false' }, icon('library', { size: 20 }));
    const fitButton = h('button', { type: 'button', class: 'float-button glass fit-all', 'aria-label': 'Fit All' }, icon('fit', { size: 20 }), h('span', {}, 'Fit All'));
    const modeButton = h('button', { type: 'button', class: 'map-context-button' });
    const status = h('span', { class: 'small muted map-count', role: 'status', 'aria-live': 'polite' });
    const overview = h('section', { class: 'map-overview', 'aria-label': 'Topic overview' });
    const legend = h('div', { class: 'graph-legend' });
    const accessibleList = h('section', { class: 'graph-access-list glass', hidden: true, 'aria-label': 'Map items' });
    const inOverview = () => !showPieces && !focusId && !activeTheme && !search.value.trim();
    const syncUrl = () => {
        const next = new URLSearchParams();
        if (focusId) next.set('focus', focusId);
        if (activeTheme) next.set('theme', activeTheme);
        if (focusId && depth > 1) next.set('depth', depth);
        if (showPieces) next.set('view', 'pieces');
        if (search.value.trim()) next.set('q', search.value.trim());
        history.replaceState(null, '', `${location.pathname}${location.search}#/graph${next.size ? '?' + next : ''}`);
    };
    const paintList = () => {
        const ids = new Set(graphData.nodes.filter((node) => node.isNote).map((node) => node.id));
        const matches = notes.filter((note) => ids.has(note.id)).sort((a, b) => a.title.localeCompare(b.title));
        accessibleList.replaceChildren(...[
            h('div', { class: 'graph-access-head' }, h('div', {}, h('strong', {}, activeTheme ? 'Topic pieces' : focusId ? 'Connected pieces' : 'Map pieces'), h('span', { class: 'small muted' }, `${matches.length} shown`)),
                h('button', { type: 'button', class: 'graph-list-close', 'aria-label': 'Close Map list', onclick: () => { accessibleList.hidden = true; listButton.setAttribute('aria-pressed', 'false'); listButton.focus(); } }, icon('close', { size: 18 }))),
            matches.length ? h('div', { class: 'graph-access-items' }, matches.map((note) => h('a', { class: 'graph-access-item', href: `#/note/${encodeURIComponent(note.id)}` },
                h('span', { class: 'graph-access-title' }, note.title), h('span', { class: 'graph-access-meta' }, `${note.topic || 'Unsorted'} · ${connectionCount(note)} connections`))))
                : h('p', { class: 'group-body small muted' }, 'No pieces match. Try another topic or idea.')].filter(Boolean));
    };
    const selectTheme = (id) => {
        if (activeTheme === id) { themeSheet(themes.themes.find((theme) => theme.id === id)); return; }
        activeTheme = id; search.value = ''; refresh(); graph.fitTheme(id);
    };
    const paintOverview = () => {
        const entries = [...themes.themes];
        const unsorted = notes.filter((note) => !themes.byNote.has(note.id));
        overview.replaceChildren();
        append(overview, [h('div', { class: 'map-overview-intro' }, h('h2', {}, 'Where would you like to explore?'), h('p', { class: 'small muted' }, 'Start with a topic. Open a piece to follow its connections.')),
            h('div', { class: 'map-topic-grid' }, entries.map((theme) => h('button', { type: 'button', class: 'map-topic', onclick: () => selectTheme(theme.id) },
                h('span', { class: 'map-topic-label' }, topicMark(theme.label, theme.color)), h('span', { class: 'small muted' }, `${theme.noteIds.length} saved ${theme.noteIds.length === 1 ? 'piece' : 'pieces'}`),
                h('span', { class: 'map-topic-preview' }, theme.noteIds.slice(0, 2).map((id) => notes.find((note) => note.id === id)?.title).join(' · ')))),
                unsorted.length ? h('button', { type: 'button', class: 'map-topic', onclick: () => { showPieces = true; refresh(); } }, h('span', { class: 'map-topic-label' }, 'Still finding a home'), h('span', { class: 'small muted' }, `${unsorted.length} saved pieces`)) : null)]);
    };
    const paintLegend = () => {
        legend.replaceChildren();
        if (focusId) {
            const focus = notes.find((note) => note.id === focusId);
            legend.append(h('a', { class: 'legend-item glass focus-pill', href: '#/graph' }, `Focused · ${focus.title}`, h('span', { class: 'count' }, 'All Map')));
        } else if (activeTheme) legend.append(h('button', { type: 'button', class: 'legend-item glass', onclick: () => { activeTheme = null; showPieces = false; search.value = ''; refresh(); } }, 'All topics'));
        const visibleThemes = focusId ? themes.themes.filter((theme) => graphData.nodes.some((node) => node.theme === theme.id)) : themes.themes;
        visibleThemes.forEach((theme) => legend.append(h('button', { type: 'button', class: `legend-item glass${activeTheme === theme.id ? ' active' : ''}`, 'aria-pressed': String(activeTheme === theme.id), onclick: () => selectTheme(theme.id) }, topicMark(theme.label, theme.color), h('span', { class: 'count' }, String(theme.noteIds.length)))));
    };
    const refresh = () => {
        graphData = buildGraph(notes, { themes, showConcepts: settings.showConcepts, focusId, depth, themeId: activeTheme, query: search.value, maxNotes: focusId ? depth === 1 ? 16 : depth === 2 ? 48 : 80 : 80 });
        const summary = inOverview();
        overview.hidden = !summary;
        canvas.style.visibility = summary ? 'hidden' : 'visible';
        canvas.setAttribute('aria-hidden', String(summary));
        graph.saveLayout();
        graph.setData(summary ? { nodes: [], links: [] } : graphData);
        paintLegend(); paintList();
        modeButton.textContent = focusId ? depth < 3 ? 'Expand connections' : 'Direct connections' : activeTheme ? 'Open topic in Library' : summary ? 'Show all pieces' : 'Topic overview';
        status.textContent = summary ? `${themes.themes.length} topics · ${notes.length} pieces` : `${graphData.shownNotes} pieces shown${graphData.totalNotes > graphData.shownNotes ? ` · ${graphData.totalNotes - graphData.shownNotes} more available` : ''}`;
        syncUrl();
    };
    modeButton.addEventListener('click', () => {
        if (activeTheme && !focusId) { location.hash = `#/library?theme=${encodeURIComponent(activeTheme)}`; return; }
        if (focusId) depth = depth < 3 ? depth + 1 : 1;
        else { showPieces = inOverview(); activeTheme = null; search.value = ''; }
        refresh(); graph.fit();
    });
    search.addEventListener('input', () => { activeTheme = null; refresh(); graph.fit(); });
    listButton.addEventListener('click', () => {
        accessibleList.hidden = !accessibleList.hidden;
        listButton.setAttribute('aria-pressed', String(!accessibleList.hidden));
        if (!accessibleList.hidden) { paintList(); accessibleList.querySelector('button')?.focus(); }
    });
    fitButton.addEventListener('click', () => {
        if (focusId) { location.hash = '#/graph'; return; }
        activeTheme = null; search.value = ''; showPieces = false; refresh(); graph.fit();
    });
    colorButton.addEventListener('click', () => {
        settings.mapColor = settings.mapColor === 'theme' ? 'source' : 'theme';
        saveSettings({ ...getSettings(), mapColor: settings.mapColor }); graph.colorBy = settings.mapColor; graph.draw();
        colorButton.setAttribute('aria-label', settings.mapColor === 'theme' ? 'Color by source' : 'Color by theme');
        colorButton.setAttribute('aria-pressed', String(settings.mapColor === 'theme'));
        colorButton.classList.toggle('on', settings.mapColor === 'theme');
    });
    conceptsButton.addEventListener('click', () => {
        settings.showConcepts = !settings.showConcepts; saveSettings({ ...getSettings(), showConcepts: settings.showConcepts });
        conceptsButton.setAttribute('aria-pressed', String(settings.showConcepts)); conceptsButton.classList.toggle('on', settings.showConcepts); refresh();
    });
    view.classList.add('full');
    view.replaceChildren(h('div', { class: 'graph-page' },
        h('div', { class: 'graph-toolbar' }, publicationHeader('VISUAL INDEX', 'Explore', 'Choose a topic, then follow an idea.'),
            h('div', { class: 'graph-top', role: 'group', 'aria-label': 'Map controls' }, h('div', { class: 'search' }, icon('search', { size: 18 }), search),
                h('div', { class: 'graph-actions' }, listButton, colorButton, conceptsButton, fitButton)), h('div', { class: 'graph-context' }, modeButton, status)),
        h('div', { class: 'graph-canvas' }, canvas, overview, accessibleList), legend));
    graph = activeMap = new GraphView(canvas, { focusId, onOpen: (node) => previewNode(node, focusId), colorBy: settings.mapColor, themes: themes.themes, layout, onLayout: saveLayout });
    paintOverview(); refresh();
}

// ---------- Settings ----------

// Run JavaScript on Web Page: reads the article from the page in your own
// Safari (where you're logged in) and hands it back to the Shortcut.
const PAGE_SCRIPT = 'var a=Array.from(document.querySelectorAll("article"));var e=a.sort(function(x,y){return(y.innerText||"").length-(x.innerText||"").length})[0]||document.querySelector("main")||document.body;var t=(e.innerText||"").trim();var w=(t.match(/\\S+/g)||[]).length;var review=t.length>=200&&(w<200||/subscribe to (continue|read)|free article limit|reached your (free )?(article|reading)? ?limit|sign in to (continue|read)/i.test(t.slice(-1500)));completion(JSON.stringify({url:location.href,title:document.title,text:t.length>=200?t.slice(0,400000):"",capture:{kind:"safari",words:w,images:e.querySelectorAll("img").length,review:review}}));';

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
    setNav({ title: 'More', right: navButton('', () => { location.hash = '#/capture'; }, 'add') });
    const settings = getSettings();
    const serverUrl = h('input', { class: 'field', type: 'url', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', placeholder: 'Server URL (blank = this site)', 'aria-label': 'Server URL' });
    serverUrl.value = settings.serverUrl;
    const token = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', placeholder: 'Access token', 'aria-label': 'Access token' });
    token.value = settings.token;
    const status = h('p', { class: 'small muted', role: 'status', 'aria-live': 'polite', style: { margin: '10px 0 0' } });
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const incoming = (Array.isArray(data) ? data : data.notes || []).filter((n) => n && n.id && n.title && n.createdAt);
            await saveMany(incoming.map((note) => normalizeKnowledge(note, [...notes, ...incoming])));
            notes = await allNotes();
            toast(`Restored ${incoming.length} notes`);
        } catch (error) {
            toast(`Restore failed: ${error.message}`);
        }
        fileInput.value = '';
    });

    const inboxUrl = `${serverBase()}/api/inbox?shortcut=1`;
    const setupIssue = connectionSetupIssue(settings);
    const usage = getLastUsage();
    const spendBox = h('div', { class: 'usage-container' });
    const fillSpend = (u) => {
        spendBox.replaceChildren();
        if (!u) return;
        const lines = [`${u.captures} breakdown${u.captures === 1 ? '' : 's'} this month${u.limit === null ? '' : ` of ${u.limit}`}`];
        const spend = u.spend;
        if (spend) {
            const usd = spend.claudeUsd > 0 && spend.claudeUsd < 0.01 ? 'under $0.01' : `about $${spend.claudeUsd.toFixed(2)}`;
            lines.push(`Claude: ${usd}${spend.unpricedModels?.length ? ' (plus unpriced models)' : ''}`);
            if (spend.geminiVideos) lines.push(`Gemini: ${spend.geminiVideos} video${spend.geminiVideos === 1 ? '' : 's'} transcribed`);
            if (spend.geminiBreakdowns) lines.push(`Gemini backup: ${spend.geminiBreakdowns} breakdown${spend.geminiBreakdowns === 1 ? '' : 's'}`);
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
    const accounts = h('div', { class: 'accounts-container' });

    render(
        publicationHeader('BACK MATTER', 'More', 'Care for your collection, and make yourself at home.'),

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
                detailText.textContent = `${count
                    ? `Your library has ${count} topic${count === 1 ? '' : 's'}${notes.length - current.byNote.size ? `; ${notes.length - current.byNote.size} note${notes.length - current.byNote.size === 1 ? '' : 's'} awaiting a topic` : ''}.`
                    : 'Save a piece to begin organizing your topics.'}`;
            };
            paintDetail();
            return h('div', { class: 'card' },
                h('div', { class: 'small muted', style: { margin: '0 2px 6px' } }, 'Color notes by'),
                segmentedControl('Color notes by', [['theme', 'Theme'], ['source', 'Source']], settings.mapColor, (value) => saveSettings({ ...getSettings(), mapColor: value })),
                h('button', { type: 'button', class: 'btn block', onclick: manageTopicsSheet }, 'Manage topics'),
                notes.length > 1 ? h('button', { type: 'button', class: 'btn block', onclick: () => reviewLibraryConnectionsSheet() }, 'Review library connections') : null,
                connectionReviewPanel(),
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
                h('p', { class: 'small muted', style: { margin: '8px 2px 0' } }, `Each topic has a stable home. Shared ideas show specific concepts discussed by several pieces; overly common concepts stay out of the map.${themes.themes.length ? ' Tap a theme under the map to zoom into its neighborhood; tap it again to see its notes.' : ''}`)
            );
        })(),

        h('div', { class: 'section-label' }, 'Connection'),
        h('form', {
            class: 'card',
            novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                const nextSettings = { ...getSettings(), serverUrl: serverUrl.value.trim(), token: token.value.trim() };
                const issue = connectionSetupIssue(nextSettings);
                if (issue) { status.className = 'small error'; status.textContent = issue; return; }
                Object.assign(settings, nextSettings);
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
                h('li', {}, setupIssue
                    ? h('p', { class: 'small error' }, setupIssue, ' Connection setup is at the beginning of Capture & Sharing.')
                    : ['For both Get Contents of URL actions use this inbox URL:', copyField(inboxUrl, 'Inbox URL'), ' Add the header ', h('b', {}, 'X-AidedMind-Token'), ' with your token:', copyField(settings.token, 'Token')]),
                h('li', {}, 'After each POST, use Show Content with the Content of URL. It now says only “Saved to AidedMind” when the server has stored the share. If the request fails, the Shortcut shows an error instead of a false success.'),
                h('li', {}, 'Test once from Safari and once from Substack. In Library → Shared links, check that the title appears. A short Safari capture asks you to review its text before a breakdown uses it.')
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
    organizeSettings();
    if (usage?.limit === null) renderAccounts(accounts);
}

// Retain existing settings controls and handlers, presented as a reference index.
function organizeSettings() {
    const children = [...view.children];
    const groups = new Map();
    let name = '';
    children.forEach((element) => {
        if (element.classList.contains('publication-header') || element.matches('input[type="file"]')) return;
        if (element.classList.contains('accounts-container')) { groups.set('Accounts', [element]); return; }
        if (element.classList.contains('usage-container')) { groups.set('This month', [element]); return; }
        if (element.classList.contains('section-label')) name = element.textContent;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(element);
    });
    const section = (title, keys, expanded = false) => {
        const element = h('details', { class: 'settings-section', open: expanded },
            h('summary', {}, h('h2', {}, title), h('span', { 'aria-hidden': 'true' }, '+')),
            h('div', { class: 'settings-content' }, keys.flatMap((key) => groups.get(key) || [])));
        return element;
    };
    const preferences = displayPreferences();
    const appearance = section('Appearance', ['Breakdown style', 'Map']);
    appearance.querySelector('.settings-content').prepend(
        h('p', { class: 'small muted' }, 'The same publication, in daylight or at night.'),
        segmentedControl('Appearance', [['auto', 'System'], ['light', 'Light'], ['dark', 'Dark']], preferences.appearance || 'auto', (appearance) => updateDisplay({ appearance })));
    const access = section('Accessibility', []);
    access.querySelector('.settings-content').append(
        h('label', { class: 'preference-row' }, h('span', {}, 'Larger reading text'),
            h('input', { type: 'checkbox', checked: Boolean(preferences.largeText), onchange: (event) => updateDisplay({ largeText: event.target.checked }) })),
        h('label', { class: 'preference-row' }, h('span', {}, 'Reduce motion'),
            h('input', { type: 'checkbox', checked: Boolean(preferences.reducedMotion), onchange: (event) => updateDisplay({ reducedMotion: event.target.checked }) })),
        h('p', { class: 'small muted' }, 'Your device’s reduced motion setting is always respected. Explore also has a synchronized text list.'));
    const header = children.find((el) => el.classList.contains('publication-header'));
    const fileInput = children.find((el) => el.matches('input[type="file"]'));
    // Keep the account container in diagnostics before its async content arrives.
    view.replaceChildren(...[
        header, section('Capture & Sharing', ['Connection', 'Save from the Share button', 'Install']),
        section('Data & Backup', ['Your data']), access, appearance,
        section('Advanced Diagnostics', ['This month', 'Server status', 'Accounts']),
        ...(groups.get('About') || []), fileInput
    ].filter(Boolean));
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
                const label = h('input', { class: 'field', type: 'text', 'aria-label': 'Account name', placeholder: 'Name', autocomplete: 'off' });
                const status = h('p', { class: 'small', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
                const submit = h('button', { type: 'submit', class: 'btn primary block' }, 'Create account');
                let saving = false;
                openSheet(h('h3', {}, 'Add an account'), h('form', { class: 'stack', onsubmit: async (event) => {
                event.preventDefault();
                if (saving) return;
                saving = true;
                submit.disabled = true;
                status.className = 'small muted';
                status.textContent = 'Creating account…';
                status.tabIndex = 0;
                status.focus({ preventScroll: true });
                try {
                    const created = await adminCreateUser({ label: label.value.trim(), plan: 'free' });
                    openSheet(
                        h('h3', {}, `Account for ${created.label || 'new user'}`),
                        h('p', { class: 'muted small' }, `Free plan, ${created.limit} breakdowns a month. Send them this token; it is shown only once.`),
                        copyField(created.token, 'Token'),
                        h('div', { class: 'stack' }, h('button', { type: 'button', class: 'btn block', onclick: () => { closeSheet(); renderAccounts(container); } }, 'Done'))
                    );
                } catch (error) {
                    status.className = 'small error';
                    status.textContent = error.message;
                    saving = false;
                    submit.disabled = false;
                    status.tabIndex = -1;
                    label.focus({ preventScroll: true });
                }
                } }, h('label', {}, 'Who is this account for?', label), status, submit));
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
    if (document.getElementById('library-shares') && refreshLibrary) { refreshLibrary(); return; }
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
        if (item.errorKind === 'needs_review') return 'needs_review';
        if (item.errorKind === 'needs_text') return 'needs_text';
        return item.errorKind === 'retry_in_app' ? 'attention' : 'report';
    }
    if (!item.queued) return 'foreground'; // shared before the server worked in the background
    return 'wait';
}

function addTextToShare(item) {
    const field = h('textarea', { class: 'field', rows: '8', placeholder: 'Paste the article text you can read', 'aria-label': 'Article text' });
    field.value = item.text || '';
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
    let linking = { status: 'complete', attempts: 0 };
    if (others.length) {
        try {
            connections = await suggestConnections(analysis, source, others);
        } catch {
            connections = [];
            linking = failedLinking(); // capture succeeds; linking retries independently
        }
    }
    await finishNote({ source, analysis: { ...analysis, connections }, model, depth, auto, linking, replaces: previous?.id || null });
    return 'saved';
}

let linkRetryTimer;
let linkRetryRunning = false;
let activeLinkId = null;
function scheduleLinkRetry() {
    clearTimeout(linkRetryTimer);
    const pendingNotes = notes.filter((note) => note.linking?.status === 'pending' && !note.linking.paused && (note.linking.attempts || 0) < 3);
    if (!pendingNotes.length || !getSettings().token) return;
    const due = Math.min(...pendingNotes.map((note) => note.linking.nextAttemptAt || 0));
    linkRetryTimer = setTimeout(() => retryPendingLinks(), Math.max(1000, due - Date.now()));
}
async function retryPendingLinks() {
    if (linkRetryRunning) return;
    // Only one tab may issue connection requests at a time. The queue itself
    // remains in IndexedDB, so a closed tab does not lose pending work.
    if (navigator.locks?.request) {
        return navigator.locks.request('aidedmind.connection-review', { ifAvailable: true }, async (lock) => {
            if (lock) await runPendingLinks();
            else { notes = await allNotes(); refreshConnectionReview(); scheduleLinkRetry(); }
        });
    }
    return runPendingLinks();
}
async function runPendingLinks() {
    if (pending || inboxRunning || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || !getSettings().token || navigator.onLine === false) {
        if (notes.some((note) => note.linking?.status === 'pending' && !note.linking.paused)) {
            clearTimeout(linkRetryTimer); linkRetryTimer = setTimeout(() => retryPendingLinks(), pending || inboxRunning ? 1000 : 30000);
        }
        refreshConnectionReview(); return;
    }
    linkRetryRunning = true;
    try {
        notes = await allNotes();
        const ids = notes.filter((note) => retryDue(note)).slice(0, 3).map((note) => note.id);
        for (const id of ids) {
            notes = await allNotes();
            const note = notes.find((current) => current.id === id);
            if (!note || !retryDue(note) || pending || inboxRunning || navigator.onLine === false) continue;
            const version = sourceVersion(note), reviewId = note.linking?.reviewId;
            const stillCurrent = (latest) => sourceVersion(latest) === version && latest.linking?.status === 'pending' && latest.linking.reviewId === reviewId;
            activeLinkId = note.id; refreshConnectionReview();
            let links;
            try {
                links = await suggestConnections(note, { text: note.sourceText || '' }, notes.filter((n) => n.id !== note.id));
            } catch {
                await updateNote(note.id, (latest) => stillCurrent(latest) ? { ...latest, linking: failedLinking(latest.linking) } : null);
                activeLinkId = null; notes = await allNotes(); refreshConnectionReview(); continue;
            }
            const currentNotes = await allNotes();
            await updateNote(note.id, (latest) => {
                if (!stillCurrent(latest)) return null;
                const allowed = links.filter((link) => !linkBlocked(latest, currentNotes.find((n) => n.id === link.noteId)));
                return { ...latest, connections: mergeConnections(allowed, latest.connections),
                    linking: { ...latest.linking, status: 'complete', attempts: 0, nextAttemptAt: 0 } };
            });
            activeLinkId = null; notes = await allNotes(); refreshConnectionReview();
        }
        if (location.hash.startsWith('#/note/') && noteTab.get(decodeURIComponent(location.hash.slice(7))) === 'Links' && !document.getElementById('sheet-root').childElementCount) route();
    } catch (error) {
        console.warn('Could not save refreshed connections', error);
        document.querySelectorAll('[data-connection-review] .error').forEach((element) => { element.textContent = 'Could not save review progress. Reload AidedMind to resume the saved queue.'; });
    } finally {
        linkRetryRunning = false; activeLinkId = null;
        refreshConnectionReview(); scheduleLinkRetry();
    }
}

function scheduleInboxPoll() {
    clearTimeout(inboxPollTimer);
    // Only links still being worked on; ones that failed here wait for you.
    if (!inbox.pending.some((item) => inboxAction(item) === 'wait' && !inbox.errors.has(item.id))) return;
    inboxPollTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') { drainInbox(); scheduleLinkRetry(); }
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
        inbox.pending = items.filter((item) => ['wait', 'needs_text', 'needs_review', 'attention'].includes(inboxAction(item)));
        inbox.checkedAt = Date.now();
        const work = items.filter((item) => !['wait', 'needs_text', 'needs_review', 'attention'].includes(inboxAction(item)));
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
    const reviewItem = (item) => h('button', { type: 'button', class: 'btn small-btn', onclick: () => {
        const preview = h('textarea', { class: 'field', rows: '9', readonly: true, 'aria-label': 'Captured article text' });
        preview.value = item.text || '';
        openSheet(h('h3', {}, 'Check captured text'),
            h('p', { class: 'small muted' }, `Safari captured ${(item.capture?.words || 0).toLocaleString()} words. Make sure this is the article you meant to save.`),
            preview,
            h('button', { type: 'button', class: 'btn primary block', onclick: async () => {
                try { await updateInboxItem(item.id, { confirm: true }); closeSheet(); toast('Breakdown queued'); await drainInbox(); }
                catch (error) { toast(error.message); }
            } }, 'Use this text'),
            h('button', { type: 'button', class: 'btn block', onclick: () => { closeSheet(); addTextToShare(item); } }, 'Add more text'),
            h('button', { type: 'button', class: 'btn block', onclick: closeSheet }, 'Later'));
    } }, 'Check text');
    const removeItem = (item) => h('button', { type: 'button', class: 'btn small-btn', onclick: async () => {
        try { await removeInboxItem(item.id); await drainInbox(); }
        catch (error) { toast(error.message); }
    } }, 'Remove');
    const row = (item, status, actions) => h('div', { class: 'group-row' },
        h('span', { class: 'row-icon' }, icon('inbox', { size: 16, strokeWidth: 2 })),
        h('span', { class: 'row-label' },
            h('div', { style: { 'font-weight': '600', 'overflow-wrap': 'anywhere' } }, label(item)),
            h('div', { class: 'small', role: status.error ? 'alert' : 'status', style: { color: status.error ? 'var(--danger)' : 'var(--text-2)' } }, status.text),
            item.error || item.nextRetryAt ? h('details', { class: 'diagnostic-detail' }, h('summary', {}, 'Advanced diagnostics'),
                item.error ? h('p', { class: 'small muted' }, item.error) : null,
                inboxAction(item) === 'wait' ? h('p', { class: 'small muted' }, retryTime(item)) : null) : null,
            h('div', { class: 'row', style: { display: 'flex', gap: '8px', 'margin-top': '8px', 'flex-wrap': 'wrap' } }, actions)
        )
    );
    return [
        h('div', { class: 'section-label' }, 'Shared links'),
        h('div', { class: 'group' },
            inbox.checkError ? h('div', { class: 'group-body small error' }, `Couldn't check your inbox: ${inbox.checkError}`) : null,
            waiting.map((item) => {
                const action = inboxAction(item);
                const status = action === 'needs_review'
                    ? { text: `${item.capture?.words || 'A short amount of'} words captured. Check the text before AidedMind breaks it down.` }
                    : action === 'needs_text'
                    ? { text: 'Needs your help. Open the article in Safari while logged in and share it again, or add the article text here.', error: true }
                    : action === 'attention'
                        ? { text: 'Needs your help. This link is saved. Open it in Safari and share the readable page, or add text here.', error: true }
                        : item.status === 'processing'
                            ? { text: 'Preparing. You can keep reading.' }
                            : { text: `${item.url ? 'Link received' : 'Text received'}. AidedMind is preparing it. You can keep reading.` };
                const actions = action === 'needs_review'
                    ? [openArticle(item), reviewItem(item), removeItem(item)]
                    : action === 'attention'
                    ? [openArticle(item), addText(item), retryItem(item), removeItem(item)]
                    : action === 'needs_text'
                        ? [openArticle(item), addText(item), removeItem(item)]
                        : [openArticle(item), item.status === 'pending' ? addText(item) : null];
                return row(item, status, actions);
            }),
            failed.map((item) => row(item, { text: 'Needs your help. This piece is saved. Open it in Safari or add text to continue.', error: true }, [
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
    activeMap?.destroy(); activeMap = null;
    const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
    const params = new URLSearchParams(query);
    const parts = path.split('/').filter(Boolean);
    const name = parts[0] || 'library';
    delete document.body.dataset.panel;
    document.querySelectorAll('.tabbar a').forEach((a) => {
        const on = a.dataset.route === name || (name === 'note' && a.dataset.route === 'library');
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    if (name === 'library') libraryView(params);
    else if (name === 'note') noteView(decodeURIComponent(parts[1] || ''));
    else if (name === 'graph') graphView(params);
    else if (name === 'settings') settingsView();
    else if (name === 'capture') captureView();
    else libraryView(params);
}

function consumeShare() {
    // Android share target: GET /share?title=&text=&url=
    if (!location.pathname.endsWith('/share')) return null;
    const params = new URLSearchParams(location.search);
    const shared = [params.get('url'), params.get('text')].filter(Boolean).join(' ').trim();
    history.replaceState(null, '', `${location.pathname.replace(/share$/, '')}#/capture`);
    return shared;
}

async function start() {
    document.querySelectorAll('[data-icon]').forEach((slot) => slot.replaceWith(icon(slot.dataset.icon, { size: 26, strokeWidth: 1.8 })));
    const shared = consumeShare();
    notes = await allNotes();
    const normalized = notes.map((note) => normalizeKnowledge(note, notes));
    const changed = normalized.filter((note, index) => JSON.stringify(note) !== JSON.stringify(notes[index]));
    if (changed.length) {
        try { await saveMany(changed); notes = await allNotes(); }
        catch { notes = normalized; toast('Map organization could not be saved. Your existing pieces are still available.'); }
    }
    window.addEventListener('hashchange', route);
    route();
    if (shared) startCapture(shared);
    if (!getSettings().token && !location.hash.startsWith('#/settings')) {
        toast('Connect your server in Settings to start');
    }
    syncPreferences();
    scheduleLinkRetry();
    window.addEventListener('online', () => { refreshConnectionReview(); scheduleLinkRetry(); });
    window.addEventListener('offline', refreshConnectionReview);
    drainInbox().then(() => {
        if (getLastUsage()?.limit === null) backfillTopics();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            allNotes().then((current) => { notes = current; refreshConnectionReview(); scheduleLinkRetry(); });
            drainInbox();
        }
    });
    if ('serviceWorker' in navigator) {
        watchForUpdates();
    }
}

start();
