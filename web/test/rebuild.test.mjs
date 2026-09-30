import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRestore } from '../js/backup.js';
import { capture, DuplicateError } from '../js/api.js';
import { toMarkdown } from '../js/markdown.js';
const note = { id: 'a', title: 'Saved', createdAt: '2026-09-30T00:00:00Z', userNotes: 'My latest edits', source: { url: 'https://writer.substack.com/p/story', partial: false } };
test('restore rejects malformed and unsupported backups before any writes', () => {
    for (const data of [{ version: 2, notes: [] }, { version: 1, notes: [{ ...note, createdAt: 4 }] }, [note, note], [{ ...note, tags: 2 }], [{ ...note, source: { url: 4 } }]]) assert.throws(() => prepareRestore(data, []));
});
test('restore previews additions and never overwrites personal edits', () => {
    const result = prepareRestore({ version: 1, notes: [{ ...note, userNotes: 'Old' }, { ...note, id: 'b' }] }, [note]);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.additions.map((n) => n.id), ['b']);
    assert.equal(note.userNotes, 'My latest edits');
});
test('pasted Safari text for a complete saved link does not call a paid API', async () => {
    await assert.rejects(capture({ url: 'https://open.substack.com/pub/writer/p/story?r=abc', text: 'Full text' }, [note]), DuplicateError);
});
test('Markdown links use the final collision-resolved export names', () => {
    const first = { ...note, title: 'Same', connections: [{ noteId: 'b', relation: 'related', reason: 'Test' }] };
    const second = { ...note, id: 'b', title: 'Same' };
    const result = toMarkdown(first, new Map([['a', first], ['b', second]]), { fileNames: new Map([['a', 'Same.md'], ['b', 'Same 2.md']]) });
    assert.match(result, /\[\[Same 2\]\]/);
});
