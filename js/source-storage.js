function normalizeCustomApi(api) {
    try {
        const normalizeUrl = value => {
            if (!value) return '';
            const parsed = new URL(String(value).trim());
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
            return parsed.toString().replace(/\/$/, '');
        };
        const url = normalizeUrl(api?.url);
        const detail = normalizeUrl(api?.detail);
        const name = String(api?.name || '')
            .replace(/[<>&"'\`\u0000-\u001f]/g, '')
            .trim()
            .slice(0, 50);
        if (!name || !url) return null;
        return { name, url, detail, isAdult: Boolean(api?.isAdult) };
    } catch {
        return null;
    }
}

function getStoredCustomApis() {
    try {
        const parsed = JSON.parse(localStorage.getItem('customAPIs') || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeCustomApi).filter(Boolean);
    } catch {
        return [];
    }
}

function getCustomApiInfo(customApiIndex) {
    const index = Number.parseInt(customApiIndex, 10);
    const apis = typeof customAPIs !== 'undefined' && Array.isArray(customAPIs)
        ? customAPIs
        : getStoredCustomApis();
    return Number.isInteger(index) && index >= 0 && index < apis.length ? apis[index] : null;
}
