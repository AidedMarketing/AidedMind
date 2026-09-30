import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

test('all release assets exist in the atomic offline cache', async () => {
    const sw = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
    const paths = [...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
    for (const path of paths) await readFile(new URL('../' + path, import.meta.url));
    assert.ok(paths.includes('fonts/Newsreader.ttf'));
    assert.ok(paths.includes('icons/mark.svg'));
});

test('PWA raster imprint assets are valid PNGs at their declared sizes', async () => {
    for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
        const png = await readFile(new URL('../icons/' + file, import.meta.url));
        assert.equal(png.readUInt32BE(0), 0x89504e47);
        assert.equal(png.readUInt32BE(16), size);
        assert.equal(png.readUInt32BE(20), size);
        let offset = 8;
        const chunks = [];
        while (offset < png.length) {
            const length = png.readUInt32BE(offset);
            const type = png.toString('ascii', offset + 4, offset + 8);
            if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
            offset += length + 12;
        }
        assert.equal(inflateSync(Buffer.concat(chunks)).length, size * (1 + size * 4));
    }
});

function luminance(hex) {
    const values = hex.match(/\w\w/g).map((v) => parseInt(v, 16) / 255)
        .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
}
test('editorial ink, metadata and action palette meets normal-text contrast', () => {
    for (const palette of [
        { backgrounds: ['f6f2e9', 'fcf9f2', 'eee8dd'], foregrounds: ['302d28', '615b52', '71685d', '6b5087'] },
        { backgrounds: ['242320', '2c2b28', '34332f'], foregrounds: ['f4efe5', 'cbc4b8', 'b5aea3', 'c7b8e8'] }
    ]) for (const bg of palette.backgrounds) for (const fg of palette.foregrounds) {
        const a = luminance(bg), b = luminance(fg);
        assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, fg + ' on ' + bg);
    }
});
