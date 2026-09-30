const KEY = 'aidedmind-accessibility';
const defaults = { scale: 1, contrast: false, sans: false, spacing: false, links: false, motion: false };
export function accessibilitySettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
        return { ...Object.fromEntries(Object.keys(defaults).filter((key) => key !== 'scale').map((key) => [key, raw[key] === true])), scale: [1, 1.15, 1.3, 1.5, 2].includes(raw.scale) ? raw.scale : 1 };
    } catch { return { ...defaults }; }
}
export function applyAccessibility(settings = accessibilitySettings()) {
    const root = document.documentElement;
    root.style.setProperty('--text-scale', settings.scale);
    for (const key of ['contrast', 'sans', 'spacing', 'links', 'motion']) root.classList.toggle(`a11y-${key}`, settings[key]);
}
export function accessibilityPanel({ h, openSheet, closeSheet, toast }) {
    const settings = accessibilitySettings();
    const save = () => {
        applyAccessibility(settings);
        try { localStorage.setItem(KEY, JSON.stringify(settings)); }
        catch { toast('Preferences work now, but could not be saved on this device.'); }
    };
    const buttons = [];
    const scaleLabel = h('p', { role: 'status' }, `Text size: ${Math.round(settings.scale * 100)}%`);
    const scales = [1, 1.15, 1.3, 1.5, 2];
    const sizeButtons = scales.map((scale) => h('button', { type: 'button', class: 'btn', 'aria-pressed': String(settings.scale === scale), onclick: () => {
        settings.scale = scale; save();
        scaleLabel.textContent = `Text size: ${Math.round(scale * 100)}%`;
        sizeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(scales[i] === scale)));
    } }, `${Math.round(scale * 100)}%`));
    const toggles = [['contrast', 'High contrast'], ['sans', 'System reading font'], ['spacing', 'More reading space'], ['links', 'Underline links'], ['motion', 'Reduce motion']].map(([key, label]) => {
        const button = h('button', { type: 'button', class: 'btn', 'aria-pressed': String(settings[key]), onclick: () => {
            settings[key] = !settings[key]; save(); button.setAttribute('aria-pressed', String(settings[key]));
        } }, label);
        buttons.push([key, button]); return button;
    });
    openSheet(h('h2', {}, 'Accessibility'), h('p', {}, 'Adjust this device for comfortable reading. Your system’s reduced-motion preference is always respected.'),
        scaleLabel, h('div', { class: 'a11y-controls', role: 'group', 'aria-label': 'Text size' }, sizeButtons),
        h('div', { class: 'a11y-controls' }, toggles),
        h('button', { type: 'button', class: 'btn block', onclick: () => {
            Object.assign(settings, defaults); save();
            buttons.forEach(([key, button]) => button.setAttribute('aria-pressed', String(settings[key])));
            sizeButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === 0)));
            scaleLabel.textContent = 'Text size: 100%';
        } }, 'Reset preferences'),
        h('button', { type: 'button', class: 'btn primary block', onclick: closeSheet }, 'Done'));
}
