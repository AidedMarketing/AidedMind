// Canvas force-directed graph, Obsidian style: drag, pan, pinch/wheel zoom,
// hover highlights neighbours, click opens a note.

const TYPE_COLORS = {
    article: '--node-article',
    youtube: '--node-youtube',
    tiktok: '--node-tiktok',
    text: '--node-text',
    concept: '--node-concept',
    photo: '--node-photo'
};

// themes: optional result of buildThemes(); each note node gets its theme
// id and color so the map can be colored and grouped by topic.
export function buildGraph(notes, { showConcepts = true, focusId = null, depth = 2, themes = null } = {}) {
    const nodes = new Map();
    const links = [];
    const linkKeys = new Set();
    const titleIndex = new Map(notes.map((note) => [note.title.toLowerCase(), note.id]));

    const addLink = (source, target, kind) => {
        if (source === target) return;
        const key = [source, target].sort().join('|') + kind;
        if (linkKeys.has(key)) return;
        linkKeys.add(key);
        links.push({ source, target, kind });
    };

    const themeColor = new Map((themes?.themes || []).map((t) => [t.id, t.color]));
    notes.forEach((note) => {
        const theme = themes?.byNote.get(note.id) || null;
        nodes.set(note.id, {
            id: note.id,
            label: note.title,
            type: note.source?.sourceType || 'text',
            isNote: true,
            theme,
            themeColor: theme ? themeColor.get(theme) : null
        });
    });
    notes.forEach((note) => {
        (note.connections || []).forEach((c) => {
            if (nodes.has(c.noteId)) addLink(note.id, c.noteId, 'connection');
        });
        const wikilinks = (note.userNotes || '').matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g);
        for (const match of wikilinks) {
            const target = titleIndex.get(match[1].trim().toLowerCase());
            if (target) addLink(note.id, target, 'connection');
        }
    });

    if (showConcepts) {
        const conceptNotes = new Map();
        notes.forEach((note) => {
            (note.concepts || []).forEach((concept) => {
                const key = concept.name.trim().toLowerCase();
                if (!conceptNotes.has(key)) conceptNotes.set(key, { name: concept.name, notes: new Set() });
                conceptNotes.get(key).notes.add(note.id);
            });
        });
        // A concept only earns a node when it bridges two or more notes,
        // otherwise the graph drowns in single-use leaves.
        conceptNotes.forEach((entry, key) => {
            if (entry.notes.size < 2) return;
            const id = `concept:${key}`;
            nodes.set(id, { id, label: entry.name, type: 'concept', isNote: false });
            entry.notes.forEach((noteId) => addLink(noteId, id, 'concept'));
        });
    }

    if (focusId && nodes.has(focusId)) {
        const keep = new Set([focusId]);
        let frontier = [focusId];
        for (let level = 0; level < depth; level++) {
            const next = [];
            links.forEach((link) => {
                frontier.forEach((id) => {
                    const other = link.source === id ? link.target : link.target === id ? link.source : null;
                    if (other && !keep.has(other)) {
                        keep.add(other);
                        next.push(other);
                    }
                });
            });
            frontier = next;
        }
        [...nodes.keys()].forEach((id) => { if (!keep.has(id)) nodes.delete(id); });
        return { nodes: [...nodes.values()], links: links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
    }
    return { nodes: [...nodes.values()], links };
}

export class GraphView {
    // colorBy: 'theme' colors notes by topic and draws soft areas around
    // each theme; 'source' colors them by where they came from.
    // areas: draw theme areas and names, and pull themes into their own
    // regions (off for the small map on a note).
    constructor(canvas, { onOpen, focusId = null, colorBy = 'source', themes = [], areas = true } = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hullCanvas = document.createElement('canvas');
        this.onOpen = onOpen;
        this.focusId = focusId;
        this.colorBy = colorBy;
        this.themes = themes;
        this.areas = areas;
        this.nodes = [];
        this.links = [];
        this.transform = { x: 0, y: 0, k: 1 };
        this.hover = null;
        this.drag = null;
        this.highlight = null;
        this.alpha = 1;
        this.running = false;
        this.pointers = new Map();
        this.bindEvents();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);
        this.resize();
    }

    setData({ nodes, links }) {
        const previous = new Map(this.nodes.map((n) => [n.id, n]));
        const radius = Math.sqrt(nodes.length) * 40;
        this.nodes = nodes.map((node, i) => {
            const old = previous.get(node.id);
            const angle = i * 2.399963; // golden angle spiral for an even start
            return {
                ...node,
                x: old ? old.x : Math.cos(angle) * radius * Math.sqrt(i / Math.max(1, nodes.length)),
                y: old ? old.y : Math.sin(angle) * radius * Math.sqrt(i / Math.max(1, nodes.length)),
                vx: 0,
                vy: 0,
                degree: 0
            };
        });
        const byId = new Map(this.nodes.map((n) => [n.id, n]));
        this.links = links
            .map((l) => ({ ...l, source: byId.get(l.source), target: byId.get(l.target) }))
            .filter((l) => l.source && l.target);
        this.links.forEach((l) => { l.source.degree++; l.target.degree++; });
        this.neighbors = new Map(this.nodes.map((n) => [n.id, new Set()]));
        this.links.forEach((l) => {
            this.neighbors.get(l.source.id).add(l.target.id);
            this.neighbors.get(l.target.id).add(l.source.id);
        });
        this.byId = byId;
        this.reheat(1);
        if (!previous.size) this.fitSoon = true;
    }

    setHighlight(query) {
        const q = (query || '').trim().toLowerCase();
        this.highlight = q ? new Set(this.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;
        this.draw();
    }

    // Lights up one theme's notes (and the ideas they share), or clears it.
    highlightTheme(themeId) {
        if (!themeId) {
            this.highlight = null;
        } else {
            const ids = new Set(this.nodes.filter((n) => n.theme === themeId).map((n) => n.id));
            this.links.forEach((l) => {
                if (!l.source.isNote && ids.has(l.target.id)) ids.add(l.source.id);
                if (!l.target.isNote && ids.has(l.source.id)) ids.add(l.target.id);
            });
            this.highlight = ids;
        }
        this.draw();
    }

    themed() {
        return this.colorBy === 'theme' && this.themes.length > 0;
    }

    radius(node) {
        return (node.isNote ? 5 : 3.5) + Math.sqrt(node.degree) * 2.2;
    }

    palette() {
        const style = getComputedStyle(this.canvas);
        const read = (name) => style.getPropertyValue(name).trim();
        const colors = {};
        Object.entries(TYPE_COLORS).forEach(([type, variable]) => { colors[type] = read(variable) || '#999'; });
        const themeColors = Array.from({ length: 8 }, (_, i) => read(`--theme-${i}`) || '#999');
        return {
            colors,
            themeColors,
            unthemed: read('--theme-none') || '#888',
            line: read('--graph-line'),
            lineStrong: read('--graph-line-strong'),
            label: read('--text'),
            dimLabel: read('--text-2'),
            halo: read('--bg')
        };
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
        this.hullCanvas.width = this.canvas.width;
        this.hullCanvas.height = this.canvas.height;
        this.dpr = dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!this.centered && rect.width) {
            this.transform.x = rect.width / 2;
            this.transform.y = rect.height / 2;
            this.centered = true;
        }
        this.draw();
    }

    reheat(alpha = 0.6) {
        this.alpha = Math.max(this.alpha, alpha);
        if (!this.running) {
            this.running = true;
            requestAnimationFrame(() => this.tick());
        }
    }

    tick() {
        if (!this.canvas.isConnected) {
            this.destroy();
            return;
        }
        this.step();
        if (this.fitSoon && this.alpha < 0.3) {
            this.fit();
            this.fitSoon = false;
            this.refitSoon = true;
        }
        // Fit once more when the layout has settled, unless you've already
        // moved or zoomed the map yourself.
        if (this.refitSoon && this.alpha < 0.03) {
            if (!this.userMoved) this.fit();
            this.refitSoon = false;
        }
        this.draw();
        if (this.alpha > 0.005) {
            requestAnimationFrame(() => this.tick());
        } else {
            this.running = false;
        }
    }

    step() {
        const nodes = this.nodes;
        const alpha = this.alpha;
        const repulsion = 2200;
        // With themes on, notes from different themes push apart harder so
        // each topic gets its own area instead of overlapping.
        const themed = this.themed() && this.areas;
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dist2 = dx * dx + dy * dy;
                if (dist2 < 0.01) {
                    dx = Math.random() - 0.5;
                    dy = Math.random() - 0.5;
                    dist2 = 0.25;
                }
                if (dist2 > 360000) continue;
                const apart = themed && a.theme !== b.theme && (a.theme || b.theme) ? 3 : 1;
                const force = (repulsion * apart * alpha) / dist2;
                const dist = Math.sqrt(dist2);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx -= fx; a.vy -= fy;
                b.vx += fx; b.vy += fy;
            }
        }
        this.links.forEach((link) => {
            const { source, target } = link;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const ideal = link.kind === 'concept' ? 75 : 115;
            // Shared-idea links pull less when themes are on, so an idea that
            // spans two themes doesn't drag notes out of their own area.
            const strength = (link.kind === 'concept' ? (themed ? 0.025 : 0.05) : 0.08) * alpha;
            const k = ((dist - ideal) / dist) * strength;
            source.vx += dx * k; source.vy += dy * k;
            target.vx -= dx * k; target.vy -= dy * k;
        });
        // Themes: pull each note gently toward its theme's centre, so topics
        // settle into their own areas of the map.
        if (this.themed() && this.areas) {
            const centres = new Map();
            nodes.forEach((node) => {
                if (!node.theme) return;
                const c = centres.get(node.theme) || { x: 0, y: 0, n: 0 };
                c.x += node.x; c.y += node.y; c.n++;
                centres.set(node.theme, c);
            });
            nodes.forEach((node) => {
                const c = node.theme && centres.get(node.theme);
                if (!c || c.n < 2) return;
                node.vx += (c.x / c.n - node.x) * 0.08 * alpha;
                node.vy += (c.y / c.n - node.y) * 0.08 * alpha;
            });
        }
        // Pull harder along the short screen axis so the layout matches a
        // portrait phone instead of settling into a wide blob.
        const portrait = this.height > this.width * 1.2;
        const gx = 0.008 * (portrait ? 2.2 : 1);
        const gy = 0.008 * (portrait ? 0.8 : 1.4);
        nodes.forEach((node) => {
            node.vx -= node.x * gx * alpha;
            node.vy -= node.y * gy * alpha;
            if (node === this.drag?.node) return;
            node.vx *= 0.6;
            node.vy *= 0.6;
            node.x += node.vx;
            node.y += node.vy;
        });
        this.alpha *= 0.985;
    }

    fit() {
        if (!this.nodes.length || !this.width) return;
        // Leave room for the theme areas and their names around the dots.
        const pad = this.themed() && this.areas ? 34 : 0;
        const xs = this.nodes.map((n) => n.x);
        const ys = this.nodes.map((n) => n.y);
        const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
        const minY = Math.min(...ys) - pad * 1.6, maxY = Math.max(...ys) + pad;
        const k = Math.min(2, Math.min((this.width - 60) / Math.max(80, maxX - minX), (this.height * 0.72) / Math.max(80, maxY - minY)));
        this.transform = {
            k,
            x: this.width / 2 - ((minX + maxX) / 2) * k,
            y: this.height / 2 - ((minY + maxY) / 2) * k
        };
        this.draw();
    }

    toWorld(px, py) {
        return { x: (px - this.transform.x) / this.transform.k, y: (py - this.transform.y) / this.transform.k };
    }

    nodeAt(px, py) {
        const p = this.toWorld(px, py);
        let best = null;
        let bestDist = Infinity;
        this.nodes.forEach((node) => {
            const d = Math.hypot(node.x - p.x, node.y - p.y);
            const hit = this.radius(node) + 14 / this.transform.k;
            if (d < hit && d < bestDist) {
                best = node;
                bestDist = d;
            }
        });
        return best;
    }

    draw() {
        const { ctx, width, height, transform } = this;
        if (!width) return;
        const palette = this.palette();
        const { line: lineColor, lineStrong, label: labelColor, dimLabel } = palette;
        ctx.clearRect(0, 0, width, height);
        if (this.themed() && this.areas) this.drawThemeAreas(palette);
        ctx.save();
        ctx.translate(transform.x, transform.y);
        ctx.scale(transform.k, transform.k);

        const active = this.hover || this.drag?.node || null;
        const activeSet = active ? this.neighbors.get(active.id) : null;
        const isLit = (node) => {
            if (this.highlight) return this.highlight.has(node.id);
            if (!active) return true;
            return node === active || activeSet.has(node.id);
        };

        this.links.forEach((link) => {
            const lit = active ? (link.source === active || link.target === active) : true;
            ctx.strokeStyle = lit && active ? lineStrong : lineColor;
            ctx.globalAlpha = lit ? (link.kind === 'concept' ? 0.55 : 0.9) : 0.12;
            ctx.lineWidth = (link.kind === 'concept' ? 0.8 : 1.4) / Math.sqrt(transform.k);
            if (link.kind === 'concept') ctx.setLineDash([3 / transform.k, 3 / transform.k]);
            ctx.beginPath();
            ctx.moveTo(link.source.x, link.source.y);
            ctx.lineTo(link.target.x, link.target.y);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        this.nodes.forEach((node) => {
            const lit = isLit(node);
            ctx.globalAlpha = lit ? 1 : 0.18;
            ctx.fillStyle = this.fillFor(node, palette);
            ctx.beginPath();
            const r = this.radius(node);
            if (node.isNote) {
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            } else {
                ctx.moveTo(node.x, node.y - r);
                ctx.lineTo(node.x + r, node.y);
                ctx.lineTo(node.x, node.y + r);
                ctx.lineTo(node.x - r, node.y);
                ctx.closePath();
            }
            ctx.fill();
            if (node.id === this.focusId || node === active) {
                ctx.lineWidth = 2 / transform.k;
                ctx.strokeStyle = labelColor;
                ctx.stroke();
            }
        });

        const placedThemes = this.themed() && this.areas ? this.drawThemeLabels(palette) : [];
        const fontSize = 12.5 / transform.k;
        ctx.font = `500 ${fontSize}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        // Greedy label placement: most important nodes first, skip any label
        // that would collide with one already drawn (in screen space).
        const placed = this.nodes.map((node) => {
            const r = this.radius(node) * transform.k;
            const nx = node.x * transform.k + transform.x;
            const ny = node.y * transform.k + transform.y;
            return { x1: nx - r, x2: nx + r, y1: ny - r, y2: ny + r, node };
        }).concat(placedThemes);
        const priority = (node) => (node === active || node.id === this.focusId ? 1000 : 0) +
            (this.highlight?.has(node.id) ? 500 : 0) + (active && isLit(node) ? 200 : 0) +
            (node.isNote ? 20 : 0) + node.degree;
        [...this.nodes].sort((a, b) => priority(b) - priority(a)).forEach((node) => {
            const lit = isLit(node);
            if (!lit && (active || this.highlight)) return;
            const important = node === active || node.id === this.focusId;
            const label = node.label.length > 28 && !important ? `${node.label.slice(0, 26)}…` : node.label;
            const y = node.y + this.radius(node) + 4 / transform.k;
            const w = ctx.measureText(label).width * transform.k;
            // Keep labels on screen near the edges.
            const rawX = node.x * transform.k + transform.x;
            const sx = Math.min(Math.max(rawX, w / 2 + 6), width - w / 2 - 6);
            const lx = (sx - transform.x) / transform.k;
            const sy = y * transform.k + transform.y;
            const rect = { x1: sx - w / 2 - 3, x2: sx + w / 2 + 3, y1: sy - 2, y2: sy + 17 };
            if (!important && placed.some((r) => r.node !== node && rect.x1 < r.x2 && rect.x2 > r.x1 && rect.y1 < r.y2 && rect.y2 > r.y1)) return;
            placed.push(rect);
            ctx.globalAlpha = 1;
            ctx.lineWidth = 3 / transform.k;
            ctx.strokeStyle = palette.halo;
            ctx.lineJoin = 'round';
            ctx.strokeText(label, lx, y);
            ctx.fillStyle = node.isNote ? labelColor : dimLabel;
            ctx.fillText(label, lx, y);
        });
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    fillFor(node, palette) {
        // With theme colors, shared-idea diamonds go neutral so they never
        // read as part of a theme.
        if (!node.isNote && this.themed()) return palette.unthemed;
        if (!node.isNote || !this.themed()) return palette.colors[node.type] || palette.colors.text;
        return node.theme ? palette.themeColors[node.themeColor ?? 0] : palette.unthemed;
    }

    // Soft area behind each theme: every member gets a wide disc, drawn
    // solid onto a scratch canvas and composited once, so overlapping discs
    // merge into one even blob instead of darkening where they overlap.
    drawThemeAreas(palette) {
        const { ctx, transform, hullCanvas, dpr } = this;
        const hull = hullCanvas.getContext('2d');
        const groups = new Map();
        this.nodes.forEach((node) => {
            if (!node.theme) return;
            if (!groups.has(node.theme)) groups.set(node.theme, []);
            groups.get(node.theme).push(node);
        });
        groups.forEach((members, themeId) => {
            if (members.length < 2) return;
            const dim = this.highlight && !members.some((m) => this.highlight.has(m.id));
            hull.setTransform(1, 0, 0, 1, 0, 0);
            hull.clearRect(0, 0, hullCanvas.width, hullCanvas.height);
            hull.setTransform(dpr * transform.k, 0, 0, dpr * transform.k, dpr * transform.x, dpr * transform.y);
            hull.fillStyle = palette.themeColors[members[0].themeColor ?? 0];
            hull.beginPath();
            members.forEach((m) => {
                const r = this.radius(m) + 26;
                hull.moveTo(m.x + r, m.y);
                hull.arc(m.x, m.y, r, 0, Math.PI * 2);
            });
            hull.fill();
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = dim ? 0.04 : 0.13;
            ctx.drawImage(hullCanvas, 0, 0);
            ctx.restore();
        });
    }

    // Theme names above their areas. Returns the screen boxes they take up,
    // so note labels avoid them.
    drawThemeLabels(palette) {
        const { ctx, transform } = this;
        const boxes = [];
        const byTheme = new Map();
        this.nodes.forEach((node) => {
            if (!node.theme) return;
            const b = byTheme.get(node.theme) || { minX: Infinity, maxX: -Infinity, minY: Infinity, n: 0, color: node.themeColor };
            b.minX = Math.min(b.minX, node.x);
            b.maxX = Math.max(b.maxX, node.x);
            b.minY = Math.min(b.minY, node.y - this.radius(node));
            b.n++;
            byTheme.set(node.theme, b);
        });
        const fontSize = 13;
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.font = `700 ${fontSize}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        this.themes
            .filter((t) => (byTheme.get(t.id)?.n || 0) >= 2)
            .forEach((theme) => {
                const b = byTheme.get(theme.id);
                const x = ((b.minX + b.maxX) / 2) * transform.k + transform.x;
                const y = (b.minY - 26) * transform.k + transform.y;
                const w = ctx.measureText(theme.label).width;
                const box = { x1: x - w / 2 - 4, x2: x + w / 2 + 4, y1: y - fontSize - 4, y2: y + 2 };
                if (boxes.some((o) => box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1)) return;
                boxes.push(box);
                const dim = this.highlight && !this.nodes.some((n) => n.theme === theme.id && this.highlight.has(n.id));
                ctx.globalAlpha = dim ? 0.25 : 1;
                ctx.lineWidth = 4;
                ctx.lineJoin = 'round';
                ctx.strokeStyle = palette.halo;
                ctx.strokeText(theme.label, x, y);
                ctx.fillStyle = palette.themeColors[b.color ?? 0];
                ctx.fillText(theme.label, x, y);
            });
        ctx.restore();
        return boxes;
    }

    bindEvents() {
        const canvas = this.canvas;
        const local = (event) => {
            const rect = canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        canvas.addEventListener('pointerdown', (event) => {
            canvas.setPointerCapture(event.pointerId);
            const p = local(event);
            this.pointers.set(event.pointerId, p);
            if (this.pointers.size === 2) {
                const [a, b] = [...this.pointers.values()];
                this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: this.transform.k };
                this.drag = null;
                return;
            }
            const node = this.nodeAt(p.x, p.y);
            this.drag = node
                ? { node, moved: false, start: p }
                : { pan: true, moved: false, start: p, origin: { ...this.transform } };
        });

        canvas.addEventListener('pointermove', (event) => {
            const p = local(event);
            if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, p);
            if (this.pinch && this.pointers.size === 2) {
                const [a, b] = [...this.pointers.values()];
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                this.zoomAt(mid, (this.pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch.dist);
                return;
            }
            if (!this.drag) {
                const node = this.nodeAt(p.x, p.y);
                if (node !== this.hover) {
                    this.hover = node;
                    canvas.style.cursor = node ? 'pointer' : 'grab';
                    this.draw();
                }
                return;
            }
            if (Math.hypot(p.x - this.drag.start.x, p.y - this.drag.start.y) > 4) {
                this.drag.moved = true;
                this.userMoved = true;
            }
            if (this.drag.node) {
                const w = this.toWorld(p.x, p.y);
                this.drag.node.x = w.x;
                this.drag.node.y = w.y;
                this.drag.node.vx = 0;
                this.drag.node.vy = 0;
                this.reheat(0.3);
            } else if (this.drag.pan) {
                this.transform.x = this.drag.origin.x + (p.x - this.drag.start.x);
                this.transform.y = this.drag.origin.y + (p.y - this.drag.start.y);
                this.draw();
            }
        });

        const end = (event) => {
            this.pointers.delete(event.pointerId);
            if (this.pointers.size < 2) this.pinch = null;
            if (this.drag && !this.drag.moved && this.drag.node && this.onOpen) {
                this.onOpen(this.drag.node);
            }
            this.drag = null;
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        canvas.addEventListener('pointerleave', () => {
            if (this.hover) {
                this.hover = null;
                this.draw();
            }
        });

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            this.zoomAt(local(event), this.transform.k * Math.exp(-event.deltaY * 0.0015));
        }, { passive: false });
    }

    zoomAt(point, k) {
        this.userMoved = true;
        const clamped = Math.min(6, Math.max(0.15, k));
        const world = this.toWorld(point.x, point.y);
        this.transform.k = clamped;
        this.transform.x = point.x - world.x * clamped;
        this.transform.y = point.y - world.y * clamped;
        this.draw();
    }

    destroy() {
        this.running = false;
        this.resizeObserver.disconnect();
    }
}
