(function () {
    const state = {
        user: null,
        csrfToken: null,
    };

    function redirectToLogin() {
        const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.location.replace(`/login.html?next=${encodeURIComponent(next)}`);
    }

    async function loadSession() {
        const response = await fetch('/api/auth/me', {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
        });
        if (response.status === 401) {
            redirectToLogin();
            throw new Error('登录已失效');
        }
        if (!response.ok) throw new Error('无法读取登录状态');
        const data = await response.json();
        state.user = data.user;
        state.csrfToken = data.csrfToken;
        return data;
    }

    const ready = loadSession();

    async function authFetch(input, init = {}) {
        await ready;
        const options = { ...init, credentials: 'same-origin' };
        const method = String(options.method || 'GET').toUpperCase();
        const headers = new Headers(options.headers || {});
        headers.set('Accept', 'application/json');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            headers.set('X-CSRF-Token', state.csrfToken);
        }
        options.headers = headers;

        const response = await fetch(input, options);
        if (response.status === 401) {
            redirectToLogin();
            throw new Error('登录已失效');
        }
        return response;
    }

    async function logout() {
        const response = await authFetch('/api/auth/logout', { method: 'POST' });
        if (!response.ok && response.status !== 204) throw new Error('退出登录失败');
        window.location.replace('/login.html');
    }

    function renderAccountControls() {
        const container = document.getElementById('accountControls');
        if (!container || !state.user) return;
        const username = document.getElementById('currentUsername');
        const adminLink = document.getElementById('adminLink');
        const logoutButton = document.getElementById('logoutButton');
        if (username) username.textContent = state.user.username;
        if (adminLink) adminLink.classList.toggle('hidden', state.user.role !== 'admin');
        if (logoutButton) {
            logoutButton.addEventListener('click', () => {
                logout().catch(error => window.showToast?.(error.message, 'error'));
            });
        }
        container.classList.remove('hidden');
        container.classList.add('flex');
    }

    ready.then(() => {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', renderAccountControls, { once: true });
        } else {
            renderAccountControls();
        }
    }).catch(() => {});

    window.Auth = {
        ready,
        fetch: authFetch,
        logout,
        get user() { return state.user; },
        get csrfToken() { return state.csrfToken; },
    };
})();
