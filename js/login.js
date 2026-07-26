(function () {
    const form = document.getElementById('loginForm');
    const errorElement = document.getElementById('loginError');
    const button = document.getElementById('loginButton');
    const versionElement = document.getElementById('versionInfo');

    function safeNextUrl() {
        const value = new URLSearchParams(window.location.search).get('next') || '/';
        try {
            const url = new URL(value, window.location.origin);
            if (url.origin !== window.location.origin || url.pathname === '/login.html') return '/';
            return `${url.pathname}${url.search}${url.hash}`;
        } catch {
            return '/';
        }
    }

    async function redirectIfLoggedIn() {
        try {
            const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
            if (response.ok) window.location.replace(safeNextUrl());
        } catch {
            // 登录页仍可继续使用，提交时会显示网络错误。
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorElement.textContent = '';
        button.disabled = true;
        button.textContent = '正在登录…';

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: form.username.value.trim(),
                    password: form.password.value,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '登录失败，请稍后重试');
            window.location.replace(safeNextUrl());
        } catch (error) {
            errorElement.textContent = error.message || '网络连接失败，请稍后重试';
            form.password.select();
        } finally {
            button.disabled = false;
            button.textContent = '登录';
        }
    });

    fetch('/api/version', { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            if (data) versionElement.textContent = `版本: ${data.version}`;
        })
        .catch(() => {});

    redirectIfLoggedIn();
})();
