(function () {
    const PREFIX = 'libretv.playback.';
    const MAX_AGE = 24 * 60 * 60 * 1000;

    function createId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function key(id) {
        return `${PREFIX}${id}`;
    }

    function cleanup() {
        const now = Date.now();
        for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
            const storageKey = sessionStorage.key(index);
            if (!storageKey?.startsWith(PREFIX)) continue;
            try {
                const state = JSON.parse(sessionStorage.getItem(storageKey));
                if (!state?.updatedAt || now - state.updatedAt > MAX_AGE) sessionStorage.removeItem(storageKey);
            } catch {
                sessionStorage.removeItem(storageKey);
            }
        }
    }

    function normalize(input) {
        return {
            title: String(input.title || '未知视频'),
            episodes: Array.isArray(input.episodes) ? [...input.episodes] : [],
            episodeIndex: Math.max(0, Number.parseInt(input.episodeIndex || 0, 10) || 0),
            sourceCode: String(input.sourceCode || ''),
            sourceName: String(input.sourceName || input.sourceCode || ''),
            vodId: String(input.vodId || ''),
            returnUrl: String(input.returnUrl || '/'),
            updatedAt: Date.now(),
        };
    }

    function create(input) {
        cleanup();
        const id = createId();
        sessionStorage.setItem(key(id), JSON.stringify(normalize(input)));
        return id;
    }

    function get(id) {
        if (!id) return null;
        try {
            const state = JSON.parse(sessionStorage.getItem(key(id)));
            if (!state) return null;
            return state;
        } catch {
            return null;
        }
    }

    function update(id, updates) {
        const current = get(id);
        if (!current) return null;
        const next = normalize({ ...current, ...updates });
        sessionStorage.setItem(key(id), JSON.stringify(next));
        return next;
    }

    window.PlaybackState = { create, get, update };
})();
