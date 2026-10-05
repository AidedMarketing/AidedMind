// Real browser regressions for the editorial shell. API calls use deterministic fixtures;
// existing worker tests cover publisher fetching, retries and persistence independently.
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('web');
const output = resolve('qa-results');
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let nextDeploymentDocument = false;
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        // Match Cloudflare's canonical HTML redirect, absent from the original fixture.
        if (pathname === '/index.html') { response.writeHead(307, { Location: '/' }).end(); return; }
        const file = resolve(root, pathname === '/api/recover' ? 'recovery.html' : pathname === '/api/recovery.js' ? 'recovery.js' : pathname === '/' ? 'index.html' : '.' + pathname);
        if (!file.startsWith(root + sep)) throw Error('Invalid path');
        response.setHeader('Content-Type', mime[extname(file)] || 'text/plain');
        if (file.endsWith('service-worker.js')) response.setHeader('Cache-Control', 'no-cache');
        response.end(nextDeploymentDocument && file.endsWith('index.html')
            ? '<!doctype html><h1>Next deployment markup</h1>' : await readFile(file));
    } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(4173, '127.0.0.1', done));
const url = 'http://127.0.0.1:4173';
const fixture = [
    { id: 'a', title: 'Sleep and memory', topic: 'Learning', tags: ['learning'], tldr: 'Sleep gives learning time to settle.', source: { sourceType: 'article', url: 'https://example.com/sleep', siteName: 'Research Journal', wordCount: 800 }, sourceText: 'Rest helps ideas settle. Spacing makes practice memorable. '.repeat(40), summary: [{ heading: 'Time to remember', body: 'Rest and repeated practice help us remember what we read.' }], takeaways: ['Give important ideas time to settle.', 'Return to notes across several days.'], quotes: ['Rest helps ideas settle.', 'Fabricated sentence must never be published.'], outline: [{ level: 1, text: 'Memory' }, { level: 2, text: 'Practice' }], concepts: [{ name: 'Memory', description: 'Keeping ideas across time.' }], connections: [{ noteId: 'b', origin: 'aidedmind', relation: 'supports', reason: 'Both pieces explore spaced practice.', confidence: .9 }], userNotes: '', createdAt: '2026-09-30T12:00:00Z' },
    { id: 'b', title: 'Practice over time', topic: 'Learning', tags: ['learning'], tldr: 'A little practice, often.', source: { sourceType: 'youtube', url: 'https://youtube.com/watch?v=fixture' }, concepts: [{ name: 'Memory' }], connections: [], createdAt: '2026-09-29T12:00:00Z' },
    { id: 'c', title: 'A thoughtful campaign', topic: 'Marketing', tags: ['marketing'], tldr: 'Make your message clear.', source: { sourceType: 'text' }, connections: [], createdAt: '2026-09-28T12:00:00Z' },
    { id: 'd', title: 'A market worth understanding', topic: 'Marketing', tags: ['marketing'], tldr: 'Observe before deciding.', source: { sourceType: 'article', partial: true, transcriptSource: 'paywall', transcriptError: 'Technical capture fixture', url: 'https://example.com/partial' }, connections: [], createdAt: '2026-09-27T12:00:00Z' }
];
const configurations = [
    { engine: 'chromium', width: 320, height: 740, colorScheme: 'light' },
    { engine: 'chromium', width: 390, height: 844, colorScheme: 'dark', reducedMotion: 'reduce' },
    { engine: 'chromium', width: 768, height: 1024, colorScheme: 'dark' },
    { engine: 'chromium', width: 959, height: 900, colorScheme: 'light' },
    { engine: 'chromium', width: 960, height: 900, colorScheme: 'dark' },
    { engine: 'chromium', width: 1280, height: 900, colorScheme: 'light', largeText: true },
    { engine: 'webkit', width: 390, height: 844, colorScheme: 'light' },
    { engine: 'webkit', width: 1280, height: 900, colorScheme: 'dark' }
];
let passed = 0;
let failed = 0;
let currentCheck = '';
const report = [];
async function check(name, operation) {
    currentCheck = name;
    await operation(); passed++; report.push({ name, status: 'passed' }); console.log('PASS ' + name);
}
try {
    for (const config of configurations) {
        const label = config.engine + '-' + config.width + '-' + config.colorScheme;
        const browser = await ({ chromium, webkit }[config.engine]).launch();
        const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, colorScheme: config.colorScheme, reducedMotion: config.reducedMotion || 'no-preference', serviceWorkers: 'block', acceptDownloads: true });
        const page = await context.newPage();
        const errors = [];
        try {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(({ largeText }) => {
            localStorage.setItem('aidedmind.settings', JSON.stringify({ token: 'fixture-token' }));
            localStorage.setItem('aidedmind.display', JSON.stringify({ largeText }));
            Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
        }, { largeText: Boolean(config.largeText) });
        let inbox = [];
        let inboxDelay = 0;
        let owner = false;
        let accountFailure = false;
        let analyzeFailure = false;
        let analyzeDelay = 0;
        let analyzedSource = null;
        let analyzeCount = 0;
        await page.route('**/api/**', async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith('/admin/users')) {
                await route.fulfill({ status: accountFailure && route.request().method() === 'POST' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(route.request().method() === 'POST' ? (accountFailure ? { error: 'Please try again later.' } : { label: 'Reader', token: 'new-fixture-token', limit: 25 }) : { users: [], month: '2026-10' }) });
                return;
            }
            if (path.endsWith('/analyze')) {
                analyzedSource = route.request().postDataJSON().source;
                analyzeCount++;
                if (analyzeDelay) await new Promise((done) => setTimeout(done, analyzeDelay));
                if (analyzeFailure) {
                    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Analysis is unavailable.' }) });
                    return;
                }
            }
            const data = path.endsWith('/inbox') ? { items: inbox } : path.endsWith('/auth-check') ? { usage: { captures: 0, limit: owner ? null : 25 } } : path.endsWith('/health') ? { services: {}, checks: {}, version: 'fixture' } : path.endsWith('/source') ? { sourceType: 'article', url: 'https://example.com/new', title: 'A new entry', text: 'A readable source passage. '.repeat(60) } : path.endsWith('/analyze') ? { analysis: { title: 'A new entry', tldr: 'An idea for later.', summary: [{ heading: 'The idea', body: 'Keep reading.' }], takeaways: [], quotes: [], outline: [], concepts: [], connections: [], tags: [] }, model: 'fixture', depth: 'balanced' } : {};
            if (path.endsWith('/inbox') && inboxDelay) await new Promise((done) => setTimeout(done, inboxDelay));
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
        });
        let visit = 0;
        const goto = async (hash) => { await page.goto(url + '/?qa=' + (++visit) + '#/' + hash); await page.locator('main h1').waitFor(); await page.evaluate(() => document.fonts.ready); };
        const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ': horizontal overflow');
        const axe = async (screen) => {
            const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
            const serious = result.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
            assert.deepEqual(serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), [], label + ' ' + screen + ' accessibility');
        };
        const visibleControls = async (selector) => {
            const problems = await page.locator(selector).evaluateAll((controls) => controls.flatMap((control) => {
                const box = control.getBoundingClientRect();
                if (!box.width || !box.height) return [control.textContent + ': hidden'];
                if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1)
                    return [control.textContent + ': outside viewport'];
                if (box.width < 44 || box.height < 44) return [control.textContent + ': small target'];
                const points = [[.5,.5], [.1,.1], [.9,.9]];
                return points.flatMap(([x,y]) => {
                    const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y);
                    return hit && (hit === control || control.contains(hit)) ? [] : [control.textContent + ': covered'];
                });
            }));
            assert.deepEqual(problems, [], label + ' ' + selector);
        };
        const shellGeometry = async () => {
            assert.equal(await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link').count(), 3);
            assert.equal(await page.getByRole('link', { name: 'AidedMind Library', exact: true }).count(), 0);
            await visibleControls('.tabbar a');
            await visibleControls('#navbar button');
            const overlaps = await page.locator('#navbar').evaluate((navbar) => {
                const children = [...navbar.children].filter((node) => getComputedStyle(node).display !== 'none');
                return children.flatMap((node, i) => {
                    const a = node.getBoundingClientRect();
                    return children.slice(i + 1).flatMap((other) => {
                        const b = other.getBoundingClientRect();
                        return Math.min(a.right,b.right) - Math.max(a.left,b.left) > 1 ? ['header columns overlap'] : [];
                    });
                });
            });
            assert.deepEqual(overlaps, [], label + ' header');
        };
        const mapGeometry = async () => {
            await shellGeometry();
            await visibleControls('.graph-top input, .graph-actions button');
            const geometry = await page.evaluate(() => {
                const toolbar = document.querySelector('.graph-toolbar').getBoundingClientRect();
                const canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
                const legend = document.querySelector('.graph-legend').getBoundingClientRect();
                const search = document.querySelector('.graph-top .search').getBoundingClientRect();
                const controls = document.querySelector('.graph-top').getBoundingClientRect();
                return { toolbarBottom:toolbar.bottom, canvasTop:canvas.top, canvasBottom:canvas.bottom,
                    canvasHeight:canvas.height, legendTop:legend.top, searchLeft:search.left, controlsLeft:controls.left,
                    searchWidth:search.width, controlsWidth:controls.width, width:innerWidth };
            });
            assert.ok(geometry.toolbarBottom <= geometry.canvasTop + 1, label + ': controls cover canvas');
            assert.ok(geometry.canvasBottom <= geometry.legendTop + 1, label + ': themes cover canvas');
            assert.ok(geometry.canvasHeight > 120, label + ': map has no usable space');
            assert.ok(Math.abs(geometry.searchLeft - geometry.controlsLeft) < 1, label + ': search drifts right');
            if (geometry.width < 600) assert.ok(Math.abs(geometry.searchWidth - geometry.controlsWidth) < 1, label + ': mobile search is not full width');
        };
        const screenshot = async (screen, modal = false) => {
            if (modal) {
                assert.equal(await page.getByRole('dialog').evaluate((dialog) => dialog.contains(document.activeElement)), true);
                assert.equal(await page.locator('.tabbar').evaluate((nav) => Boolean(nav.closest('[inert]'))), true);
                await visibleControls('.sheet input, .sheet button');
            } else await shellGeometry();
            await page.screenshot({ path: resolve(output, label + '-' + screen + '.png'), fullPage: true });
            // Fixed bars need a viewport capture too: full-page images can disguise clipping.
            await page.screenshot({ path: resolve(output, label + '-' + screen + '-viewport.png') });
        };
        await check(label + ' empty Library', async () => {
            await goto('library');
            await page.getByText('Your Library is ready for its first idea.', { exact: true }).waitFor();
            await noOverflow(); await axe('empty'); await screenshot('empty');
        });
        await page.evaluate(async (data) => { const db = await import('/js/db.js'); await db.saveMany(data); }, fixture);
        await check(label + ' Library, search and filters', async () => {
            await goto('library');
            assert.equal(await page.locator('.note-row').count(), 4);
            assert.equal(await page.locator('.connection-glyph').first().getAttribute('aria-label'), '1 connection');
            await page.getByRole('searchbox', { name: 'Search library' }).fill('sleep');
            assert.equal(await page.locator('.note-row').count(), 1);
            await page.getByRole('searchbox', { name: 'Search library' }).fill('');
            await page.getByRole('button', { name: 'YouTube', exact: true }).click();
            assert.equal(await page.locator('.note-row').count(), 1);
            await page.getByRole('button', { name: 'All', exact: true }).click();
            await noOverflow(); await axe('library'); await screenshot('library');
        });
        await check(label + ' Breakdown and source-verified quote', async () => {
            await goto('note/a');
            assert.equal(await page.getByRole('tab').count(), 3);
            assert.equal(await page.locator('.quote').count(), 1);
            assert.equal(await page.getByText('Fabricated sentence must never be published.', { exact: true }).count(), 0);
            await noOverflow(); await axe('breakdown'); await screenshot('breakdown');
            await page.getByRole('button', { name: 'View source passage' }).click();
            assert.equal(await page.locator('[role="dialog"] mark').textContent(), 'Rest helps ideas settle.');
            assert.ok(await page.locator('main').evaluate((el) => el.inert));
            assert.ok(await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))));
            await page.keyboard.press('Escape');
            await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
            assert.equal(await page.evaluate(() => document.activeElement.textContent), 'View source passage');
        });
        await check(label + ' tab keyboard behavior', async () => {
            await page.getByRole('tab', { name: 'Breakdown' }).focus();
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.getByRole('tab', { name: 'Links' }).getAttribute('aria-selected'), 'true');
            const heading = await page.getByRole('heading', { name: 'Connections', exact: true }).boundingBox();
            assert.ok(heading.y >= 56 && heading.y + heading.height < config.height - 64, 'Connections heading is hidden after a deep reading scroll');
            await page.keyboard.press('End');
            assert.equal(await page.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected'), 'true');
            const notesHeading = await page.getByRole('heading', { name: 'Your Notes', exact: true }).boundingBox();
            assert.ok(notesHeading.y >= 56 && notesHeading.y + notesHeading.height < config.height - 64, 'Notes heading is hidden after switching tabs');
        });
        await check(label + ' Notes autosave and ownership', async () => {
            const field = page.getByRole('textbox', { name: 'My notes' });
            await field.fill('My own thought about memory.');
            await page.getByText('Saving…', { exact: true }).waitFor();
            await page.getByText('Saved', { exact: true }).waitFor();
            assert.equal(await page.evaluate(async () => (await (await import('/js/db.js')).allNotes()).find((n) => n.id === 'a').userNotes), 'My own thought about memory.');
            await noOverflow(); await axe('notes'); await screenshot('notes');
        });
        await check(label + ' Notes save failure is announced', async () => {
            await page.evaluate(() => {
                window.qaTransaction = IDBDatabase.prototype.transaction;
                IDBDatabase.prototype.transaction = function(...args) { if (args[1] === 'readwrite') throw Error('Fixture storage failure'); return window.qaTransaction.apply(this, args); };
            });
            await page.getByRole('textbox', { name: 'My notes' }).fill('This text must stay here.');
            await page.getByText('Error — your text is still here. Edit to retry.', { exact: true }).waitFor();
            assert.equal(await page.getByRole('textbox', { name: 'My notes' }).inputValue(), 'This text must stay here.');
            await page.evaluate(() => { IDBDatabase.prototype.transaction = window.qaTransaction; });
            await page.getByRole('textbox', { name: 'My notes' }).fill('Recovered thought.');
            await page.getByText('Saved', { exact: true }).waitFor();
        });
        await check(label + ' Links, manual creation and sheet focus', async () => {
            await page.getByRole('tab', { name: 'Links' }).click();
            await axe('links'); await screenshot('links');
            await page.getByRole('button', { name: 'Add a link', exact: true }).click();
            await page.getByRole('searchbox', { name: 'Search notes to link' }).fill('thoughtful');
            await page.keyboard.press('Shift+Tab'); // focus wraps to the close button or preceding control inside sheet
            assert.ok(await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))));
            const dialog = page.getByRole('dialog');
            await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close dialog');
            await dialog.getByRole('button', { name: /A thoughtful campaign/ }).click();
            await dialog.waitFor({ state: 'detached' });
            assert.equal(await page.locator('.link-row').count(), 2);
            const data = await page.evaluate(async () => (await (await import('/js/db.js')).allNotes()).find((n) => n.id === 'a'));
            assert.equal(data.connections.find((c) => c.noteId === 'c').origin, 'user');
        });
        await check(label + ' Not related remembers rejected edge', async () => {
            await page.getByRole('button', { name: 'Mark link to Practice over time as not related', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Not related', exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('.link-row').length === 1);
            assert.equal(await page.locator('.link-row').count(), 1);
            const data = await page.evaluate(async () => (await (await import('/js/db.js')).allNotes()).find((n) => n.id === 'a'));
            assert.ok(data.rejectedLinks.some((c) => c.noteId === 'b'));
        });
        await check(label + ' full Map, theme zoom, Fit All and text equivalent', async () => {
            await goto('graph');
            await mapGeometry();
            await page.getByRole('button', { name: 'Show Map as a list' }).click();
            assert.equal(await page.locator('.graph-access-item').count(), 4);
            await page.getByRole('button', { name: 'Close Map list' }).click();
            const theme = page.locator('.graph-legend button').first();
            await theme.click();
            await page.getByRole('button', { name: 'Show Map as a list' }).click();
            assert.ok(await page.locator('.graph-access-item').count() < 4);
            await page.getByRole('button', { name: 'Close Map list' }).click();
            await page.getByRole('button', { name: 'Fit All' }).click();
            await page.getByRole('button', { name: 'Show Map as a list' }).click();
            assert.equal(await page.locator('.graph-access-item').count(), 4);
            await noOverflow(); await axe('map-list'); await screenshot('map-list');
            await page.getByRole('button', { name: 'Close Map list' }).click();
            await screenshot('map');
            await page.setViewportSize({ width: 320, height: 568 });
            await mapGeometry();
            await page.setViewportSize({ width: config.width, height: config.height });
            await page.getByRole('button', { name: 'Color by source' }).click();
            await page.getByRole('button', { name: 'Toggle shared ideas' }).click();
        });
        await check(label + ' focused Map and Fit All', async () => {
            await goto('graph?focus=a');
            await page.locator('.focus-pill').waitFor();
            await page.getByRole('button', { name: 'Fit All' }).click();
            await page.waitForURL((address) => address.hash === '#/graph');
            await page.locator('.focus-pill').waitFor({ state: 'detached' });
            assert.equal(await page.locator('.focus-pill').count(), 0);
        });
        await check(label + ' More, backup, ZIP and appearance', async () => {
            await goto('settings');
            assert.equal(await page.locator('.settings-section').count(), 5);
            assert.equal(await page.getByText('Access token', { exact: true }).count(), 0);
            await page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Data & Backup', exact: true }) }).locator('summary').click();
            let downloaded = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Back up library', exact: true }).click();
            const backup = await downloaded;
            assert.match(backup.suggestedFilename(), /\.json$/);
            const data = JSON.parse(await readFile(await backup.path(), 'utf8'));
            assert.equal(data.notes.length, 4);
            await page.locator('input[type="file"]').setInputFiles({ name: 'restore.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
            await page.getByText('Restored 4 notes', { exact: true }).waitFor();
            const feedback = await page.locator('#toast').boundingBox();
            const header = await page.locator('#navbar').boundingBox();
            assert.ok(feedback.y >= header.y + header.height, 'Feedback covers the header');
            downloaded = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Export to Obsidian (.zip)' }).click();
            const zip = await downloaded;
            assert.match(zip.suggestedFilename(), /\.zip$/);
            const bytes = await readFile(await zip.path());
            assert.equal(bytes.readUInt32LE(0), 0x04034b50);
            await page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Appearance', exact: true }) }).locator('summary').click();
            await page.getByRole('radio', { name: 'Dark', exact: true }).click();
            assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
            await page.getByRole('radio', { name: 'Light', exact: true }).click();
            assert.equal(await page.locator('html').getAttribute('data-appearance'), 'light');
            await page.getByRole('radio', { name: 'System', exact: true }).click();
            await page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Accessibility', exact: true }) }).locator('summary').click();
            await page.getByRole('checkbox', { name: 'Reduce motion' }).check();
            assert.equal(await page.locator('html').getAttribute('data-reduced-motion'), 'true');
            await noOverflow(); await axe('more');
            await page.evaluate(() => window.scrollTo(0, 0));
            await screenshot('more');
        });
        await check(label + ' capture connection setup', async () => {
            await goto('settings');
            const captureSection = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Capture & Sharing', exact: true }) });
            await captureSection.locator('summary').click();
            assert.equal(await captureSection.getByText('This month', { exact: true }).count(), 0);
            await page.getByRole('textbox', { name: 'Server URL', exact: true }).fill('https://aidedmarketing.github.io');
            await page.getByRole('button', { name: 'Save & Test', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'GitHub Pages hosts the app' }).waitFor();
            await screenshot('connection-error');
            await page.getByRole('textbox', { name: 'Server URL', exact: true }).fill('https://capture.example');
            const connected = page.waitForResponse('**/api/auth-check');
            await page.getByRole('button', { name: 'Save & Test', exact: true }).click();
            await connected;
            await page.getByText('Connected', { exact: true }).waitFor();
            await captureSection.locator('summary').click();
            await page.getByRole('button', { name: 'Copy Inbox URL', exact: true }).waitFor();
            await page.getByText('https://capture.example/api/inbox?shortcut=1', { exact: true }).waitFor();
            await page.getByLabel('Access token', { exact: true }).fill('');
            await page.getByRole('button', { name: 'Save & Test', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Add your access token' }).waitFor();
            await page.evaluate(() => localStorage.setItem('aidedmind.settings', JSON.stringify({ token: '', serverUrl: 'https://capture.example' })));
            await page.getByRole('link', { name: 'Library', exact: true }).click();
            await page.getByRole('link', { name: 'More', exact: true }).click();
            await captureSection.locator('summary').click();
            assert.equal(await page.getByRole('button', { name: 'Copy Inbox URL', exact: true }).count(), 0);
            assert.equal(await page.getByRole('button', { name: 'Copy Token', exact: true }).count(), 0);
            await noOverflow(); await axe('connection setup');
        });
        await check(label + ' account sheet recovery and focus', async () => {
            owner = true;
            await goto('settings');
            await page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Capture & Sharing', exact: true }) }).locator('summary').click();
            const connected = page.waitForResponse('**/api/auth-check');
            await page.getByRole('button', { name: 'Save & Test', exact: true }).click();
            await connected;
            await page.getByText('Connected', { exact: true }).waitFor();
            await page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Advanced Diagnostics', exact: true }) }).locator('summary').click();
            await page.getByRole('button', { name: 'Add an account', exact: true }).click();
            const name = page.getByRole('textbox', { name: 'Account name', exact: true });
            await name.fill('Reader');
            accountFailure = true;
            await page.getByRole('button', { name: 'Create account', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Please try again later.' }).waitFor();
            assert.equal(await name.inputValue(), 'Reader');
            await screenshot('account-error', true);
            await axe('account sheet');
            accountFailure = false;
            await page.getByRole('button', { name: 'Create account', exact: true }).click();
            await page.getByRole('heading', { name: 'Account for Reader', exact: true }).waitFor();
            await page.keyboard.press('Escape');
            assert.equal(await page.getByRole('dialog').count(), 0);
            assert.equal(await page.getByRole('button', { name: 'Add an account', exact: true }).evaluate((button) => button === document.activeElement), true);
            owner = false;
        });
        await check(label + ' partial capture diagnostics', async () => {
            await goto('note/d');
            const details = page.locator('.diagnostic-detail');
            assert.equal(await details.getAttribute('open'), null);
            assert.equal(await page.getByText('Technical capture fixture', { exact: true }).isVisible(), false);
            await noOverflow();
        });
        await check(label + ' Add and capture', async () => {
            await goto('capture');
            await noOverflow(); await axe('capture'); await screenshot('capture');
            await page.getByRole('textbox', { name: 'Link or text', exact: true }).fill('https://example.com/new');
            await page.getByRole('button', { name: 'Break it down', exact: true }).click();
            await page.getByRole('heading', { name: 'A new entry', exact: true }).waitFor();
            assert.equal(await page.getByRole('tab').count(), 3);
        });
        await check(label + ' recovery, search error and resize', async () => {
            inbox = [{ id: 'waiting', title: 'Waiting article', url: 'https://example.com/waiting', status: 'failed', queued: true, errorKind: 'retry_in_app', error: 'too many requests', attempts: 4 }];
            await goto('library');
            await page.getByRole('button', { name: 'inbox', exact: true }).click();
            await page.getByText('Waiting article', { exact: true }).waitFor();
            await page.getByText('Needs your help. This link is saved. Open it in Safari and share the readable page, or add text here.', { exact: true }).waitFor();
            inbox = [{ ...inbox[0], title: 'Updated waiting article' }];
            inboxDelay = 200;
            await page.getByRole('button', { name: 'inbox', exact: true }).click();
            await page.getByRole('searchbox', { name: 'Search library' }).fill('no-match-fixture');
            await page.getByText('Updated waiting article', { exact: true }).waitFor();
            assert.equal(await page.getByRole('searchbox', { name: 'Search library' }).inputValue(), 'no-match-fixture');
            await page.getByText('No results', { exact: true }).waitFor();
            await page.setViewportSize({ width: 320, height: 740 }); await noOverflow(); await shellGeometry();
            for (const destination of ['Explore', 'More', 'Library']) {
                await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: destination, exact: true }).click();
                await page.getByRole('heading', { name: destination, exact: true }).waitFor();
                await shellGeometry();
            }
            assert.deepEqual(errors, [], label + ' browser errors');
        });
        await check(label + ' import full text on a complete note', async () => {
            await page.evaluate(async (note) => (await import('/js/db.js')).saveNote(note), { ...fixture[0], userNotes: 'Keep my thoughts' });
            await goto('note/a');
            await page.getByRole('tab', { name: 'Notes', exact: true }).click();
            await page.getByRole('button', { name: 'Import full text', exact: true }).click();
            await page.getByRole('button', { name: 'Update breakdown', exact: true }).click();
            await page.getByText('Paste the full text first.', { exact: true }).waitFor();
            const fullText = 'A complete source, including the missing sections. '.repeat(200);
            await page.getByRole('textbox', { name: 'Full text', exact: true }).fill(fullText);
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'Import full text', exact: true }).click();
            assert.equal(await page.getByRole('textbox', { name: 'Full text', exact: true }).inputValue(), fullText);
            analyzeFailure = true;
            await page.getByRole('button', { name: 'Update breakdown', exact: true }).click();
            await page.getByText(/Your pasted text is still here/).waitFor();
            assert.equal(await page.getByRole('textbox', { name: 'Full text', exact: true }).inputValue(), fullText);
            const before = await page.evaluate(async () => (await (await import('/js/db.js')).allNotes()).find((n) => n.id === 'a'));
            assert.equal(before.title, 'Sleep and memory');
            await axe('full text import');
            await screenshot('full-text-import', true);
            analyzeFailure = false;
            analyzeDelay = 300;
            const count = analyzeCount;
            await page.getByRole('button', { name: 'Update breakdown', exact: true }).click();
            assert.equal(await page.getByRole('button', { name: 'Update breakdown', exact: true }).isDisabled(), true);
            await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
            const after = await page.evaluate(async () => (await (await import('/js/db.js')).allNotes()).find((n) => n.id === 'a'));
            assert.equal(analyzeCount, count + 1);
            assert.equal(analyzedSource.text, fullText.trim());
            assert.equal(analyzedSource.url, before.source.url);
            assert.equal(after.sourceText, fullText.trim());
            assert.equal(after.createdAt, before.createdAt);
            assert.equal(after.userNotes, before.userNotes);
            assert.equal(after.connections[0].noteId, before.connections[0].noteId);
            assert.equal(after.source.siteName, before.source.siteName);
            assert.equal(after.source.wordCount, fullText.trim().split(/\s+/).length);
            analyzeDelay = 0;
        });
        } catch (error) {
            failed++; report.push({ name: currentCheck, status: 'failed', error: error.message });
            console.error('FAIL ' + currentCheck + '\n' + error.stack);
        } finally { await context.close(); await browser.close(); }
    }
    // Separate real service worker context verifies atomic cache includes the font and imprint.
    await check('service worker offline publication assets', async () => {
        const browser = await webkit.launch();
        const context = await browser.newContext({ serviceWorkers: 'allow' });
        const page = await context.newPage();
        await page.goto(url);
        await page.evaluate(async () => { await navigator.serviceWorker.ready; });
        await page.reload();
        await page.evaluate(async () => {
            const cache = await caches.open('aidedmind-v33');
            for (const path of ['/fonts/Newsreader.ttf', '/icons/mark.svg', '/tokens.css', '/shell.css', '/app.css', '/js/app.js']) {
                if (!(await cache.match(path))) throw Error('Missing cached asset ' + path);
            }
        });
        assert.equal(await page.evaluate(async () => (await (await caches.open('aidedmind-v33')).match('/index.html')).redirected), true);
        // Reopen a fresh tab under the installed controller, as on Safari launch.
        const reopened = await context.newPage();
        await reopened.goto(url + '/?reopen=1');
        await reopened.getByRole('heading', { name: 'Library', exact: true }).waitFor();
        await reopened.close();
        // A newer deployment must not swap the document under cached old assets.
        nextDeploymentDocument = true;
        try {
            await page.reload();
            await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();
            assert.equal(await page.getByRole('heading', { name: 'Next deployment markup' }).count(), 0);
        } finally { nextDeploymentDocument = false; }
        // Playwright #42775: WebKit's offline emulation breaks even literal
        // service-worker responses. Disconnect the origin server instead.
        await new Promise((done) => server.close(done));
        try {
            await page.reload();
            await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();
            await page.evaluate(() => document.fonts.ready);
            assert.ok(await page.evaluate(() => document.fonts.check('20px Newsreader')));
        } finally {
            await new Promise((done) => server.listen(4173, '127.0.0.1', done));
        }
        await page.evaluate(async () => {
            localStorage.setItem('repair-preservation', 'keep');
            const db = await import('/js/db.js');
            await db.saveNote({ id: 'repair-note', title: 'Keep this idea', createdAt: '2026-10-01' });
        });
        await page.goto(url + '/api/recover');
        await page.getByRole('button', { name: 'Repair and open AidedMind', exact: true }).click();
        await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('repair-preservation')), 'keep');
        assert.equal(await page.evaluate(async () => (await (await import('/js/db.js')).allNotes()).some((note) => note.id === 'repair-note')), true);
        await browser.close();
    });
    console.log('Browser checks passed: ' + passed + '; failed: ' + failed);
    if (failed) process.exitCode = 1;
} finally {
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed, failed, checks: report }, null, 2));
    await new Promise((done) => server.close(done));
}
