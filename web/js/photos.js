// Prepares photos on the device before they're sent for a breakdown:
// scaled to Claude's useful maximum (1568px on the long edge) and re-encoded
// as JPEG, which keeps uploads small and fast. A tiny thumbnail is kept with
// the note; the full photo is never stored.
export const MAX_PHOTOS = 8;
const MAX_EDGE = 1568;
const THUMB_EDGE = 240;

async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode(); // Safari applies EXIF orientation and decodes HEIC here
        return img;
    } catch {
        throw new Error(`Couldn't open "${file.name || 'that photo'}". Try a JPEG or PNG.`);
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

export function fitWithin(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function draw(img, maxEdge) {
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs become white, not black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
}

function toBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process that photo.'))), 'image/jpeg', quality));
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export async function preparePhoto(file) {
    const img = await loadImage(file);
    const full = await blobToDataUrl(await toBlob(draw(img, MAX_EDGE), 0.78));
    const thumb = await blobToDataUrl(await toBlob(draw(img, THUMB_EDGE), 0.7));
    return {
        mediaType: 'image/jpeg',
        data: full.slice(full.indexOf(',') + 1),
        thumb,
        name: file.name || 'photo'
    };
}
