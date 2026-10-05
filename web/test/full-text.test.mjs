import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveUpdatedNote } from '../js/library.js';

test('full-text correction preserves identity and personal context without retaining incomplete source flags', () => {
    const previous = { id: 'saved', createdAt: '2026-01-01', userNotes: 'My thinking', topic: 'My topic', topicByUser: true,
        sourceText: 'short opening', source: { url: 'https://publication.example/p/post', sharedUrl: 'https://open.example/post', author: 'Author', siteName: 'Publication', thumbnail: 'image', partial: true, transcriptSource: 'paywall', wordCount: 20 },
        connections: [{ noteId: 'manual', origin: 'user', reason: 'My reason' }, { noteId: 'existing', origin: 'aidedmind' }], removedLinks: ['blocked'], rejectedLinks: ['rejected'], photos: ['thumbnail'] };
    const fresh = { id: 'new', createdAt: '2026-02-01', topic: 'Suggested', sourceText: 'The complete article', source: { url: previous.source.url, partial: undefined, wordCount: 1000, transcriptSource: '' },
        connections: [{ noteId: 'manual', origin: 'aidedmind', reason: 'Suggested reason' }, { noteId: 'new-link' }], photos: [] };
    const updated = preserveUpdatedNote(fresh, previous);
    assert.equal(updated.id, 'saved');
    assert.equal(updated.createdAt, previous.createdAt);
    assert.equal(updated.userNotes, 'My thinking');
    assert.equal(updated.sourceText, fresh.sourceText);
    assert.equal(updated.source.partial, undefined);
    assert.equal(updated.source.transcriptSource, '');
    assert.equal(updated.source.wordCount, 1000);
    assert.equal(updated.source.author, 'Author');
    assert.equal(updated.source.siteName, 'Publication');
    assert.equal(updated.source.sharedUrl, previous.source.sharedUrl);
    assert.equal(updated.topic, 'My topic');
    assert.deepEqual(updated.photos, previous.photos);
    assert.deepEqual(updated.removedLinks, previous.removedLinks);
    assert.deepEqual(updated.rejectedLinks, previous.rejectedLinks);
    assert.equal(updated.connections.length, 3);
    assert.equal(updated.connections[0].reason, 'My reason');
    assert.equal(previous.sourceText, 'short opening');
});
