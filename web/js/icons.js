// Stroke icons (24px grid) rendered as inline SVG elements.
const PATHS = {
    add: ['M12 5v14', 'M5 12h14'],
    library: ['M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z', 'M9 4h4v16H9', 'M14.5 5.2l3.4-.9a1 1 0 0 1 1.2.7l3 11.6a1 1 0 0 1-.7 1.2l-3.4.9'],
    graph: ['M3.5 7a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'M16 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M14.5 18a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'M7.7 8.8l7.6 7.4', 'M8.4 6.6l7.6-1.3', 'M17.8 7l-.5 8.5'],
    settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
    search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
    clipboard: ['M9 4h6v3H9z', 'M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2', 'M9 12h6', 'M9 16h4'],
    back: ['M15 5l-7 7 7 7'],
    more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
    share: ['M12 3v13', 'M7 8l5-5 5 5', 'M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'],
    article: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 12h7', 'M9 16h7'],
    youtube: ['M3.5 7.5a3 3 0 0 1 2.6-2.4C8 4.9 10 4.8 12 4.8s4 .1 5.9.3a3 3 0 0 1 2.6 2.4c.3 1.5.4 3 .4 4.5s-.1 3-.4 4.5a3 3 0 0 1-2.6 2.4c-1.9.2-3.9.3-5.9.3s-4-.1-5.9-.3a3 3 0 0 1-2.6-2.4C3.2 15 3.1 13.5 3.1 12s.1-3 .4-4.5z', 'M10 9l5 3-5 3z'],
    tiktok: ['M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5', 'M14 3c.4 2.6 2.2 4.3 5 4.5'],
    text: ['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z', 'M13.5 6.5l4 4'],
    concept: ['M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    refresh: ['M20 11a8 8 0 0 0-14.9-4', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.9 4', 'M20 20v-4h-4'],
    download: ['M12 4v12', 'M7 11l5 5 5-5', 'M5 20h14'],
    upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'],
    fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
    check: ['M5 12.5l4.5 4.5L19 7'],
    copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
    inbox: ['M4 13l2.5-8h11l2.5 8', 'M4 13v6h16v-6', 'M4 13h5l1 2h4l1-2h5'],
    sparkle: ['M12 4l1.8 4.9L19 10.5l-5.2 1.6L12 17l-1.8-4.9L5 10.5l5.2-1.6z', 'M19 17l.7 1.6 1.3.4-1.3.4L19 21l-.7-1.6L17 19l1.3-.4z'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    photo: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M8.5 10a1.5 1.5 0 1 0 0-.01', 'M20 15l-4.5-4.5L7 19'],
    camera: ['M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z']
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 22, strokeWidth = 1.8, className = 'icon' } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(strokeWidth));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    (PATHS[name] || PATHS.concept).forEach((d) => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    });
    return svg;
}
