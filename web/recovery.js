// Only downloaded app caches and the app controller are refreshed.
// Never open, clear or migrate IndexedDB, localStorage or user content here.
const button = document.getElementById('repair');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Refreshing the app files…';
    try {
        const scope = new URL('/', location.href).href;
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.filter((registration) => registration.scope === scope).map((registration) => registration.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => /^aidedmind-v\d+$/.test(key)).map((key) => caches.delete(key)));
        location.replace('/');
    } catch {
        status.textContent = 'The app files could not be refreshed. Try again with an internet connection. Your saved pieces have not been changed.';
        button.disabled = false;
        button.focus();
    }
});
