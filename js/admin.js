(function () {
    const createForm = document.getElementById('createUserForm');
    const createMessage = document.getElementById('createMessage');
    const usersMessage = document.getElementById('usersMessage');
    const usersList = document.getElementById('usersList');
    const template = document.getElementById('userCardTemplate');

    function setMessage(element, message, isError = false) {
        element.textContent = message || '';
        element.classList.toggle('is-error', isError);
    }

    function formatDate(timestamp) {
        return timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '从未登录';
    }

    async function responseData(response) {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
        return data;
    }

    async function updateUser(user, card) {
        const role = card.querySelector('.user-role').value;
        const enabled = card.querySelector('.user-enabled').checked;
        const passwordInput = card.querySelector('.user-password');
        const payload = { role, enabled };
        if (passwordInput.value) payload.password = passwordInput.value;

        const response = await Auth.fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        await responseData(response);
        passwordInput.value = '';
    }

    async function deleteUser(user) {
        if (!window.confirm(`确定删除用户“${user.username}”吗？其观看记录也会一并删除。`)) return false;
        const response = await Auth.fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 204) await responseData(response);
        return true;
    }

    function renderUsers(users) {
        usersList.replaceChildren();
        if (!users.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = '暂无用户';
            usersList.appendChild(empty);
            return;
        }

        users.forEach(user => {
            const card = template.content.firstElementChild.cloneNode(true);
            card.querySelector('.user-name').textContent = user.username;
            card.querySelector('.user-meta').textContent = `创建于 ${formatDate(user.createdAt)} · 最近登录 ${formatDate(user.lastLoginAt)}`;

            const status = card.querySelector('.status-badge');
            status.textContent = user.enabled ? (user.role === 'admin' ? '管理员' : '正常') : '已停用';
            status.classList.toggle('disabled', !user.enabled);

            const roleSelect = card.querySelector('.user-role');
            const enabledInput = card.querySelector('.user-enabled');
            roleSelect.value = user.role;
            enabledInput.checked = user.enabled;

            const isCurrentUser = user.id === Auth.user.id;
            if (isCurrentUser) {
                card.querySelector('.user-name').append('（当前账户）');
                card.querySelector('.delete-user').disabled = true;
            }

            card.querySelector('.save-user').addEventListener('click', async event => {
                const button = event.currentTarget;
                button.disabled = true;
                setMessage(usersMessage, '');
                try {
                    await updateUser(user, card);
                    setMessage(usersMessage, `已保存 ${user.username} 的设置`);
                    await loadUsers();
                } catch (error) {
                    setMessage(usersMessage, error.message, true);
                } finally {
                    button.disabled = false;
                }
            });

            card.querySelector('.delete-user').addEventListener('click', async event => {
                const button = event.currentTarget;
                button.disabled = true;
                setMessage(usersMessage, '');
                try {
                    if (await deleteUser(user)) {
                        setMessage(usersMessage, `已删除 ${user.username}`);
                        await loadUsers();
                    }
                } catch (error) {
                    setMessage(usersMessage, error.message, true);
                } finally {
                    button.disabled = isCurrentUser;
                }
            });

            usersList.appendChild(card);
        });
    }

    async function loadUsers() {
        const response = await Auth.fetch('/api/admin/users', { cache: 'no-store' });
        const data = await responseData(response);
        renderUsers(data.users || []);
    }

    createForm.addEventListener('submit', async event => {
        event.preventDefault();
        const button = createForm.querySelector('button[type="submit"]');
        button.disabled = true;
        setMessage(createMessage, '');
        try {
            const response = await Auth.fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: createForm.username.value.trim(),
                    password: createForm.password.value,
                    role: createForm.role.value,
                }),
            });
            const data = await responseData(response);
            setMessage(createMessage, `用户 ${data.user.username} 已创建`);
            createForm.reset();
            await loadUsers();
        } catch (error) {
            setMessage(createMessage, error.message, true);
        } finally {
            button.disabled = false;
        }
    });

    document.getElementById('refreshUsers').addEventListener('click', () => {
        setMessage(usersMessage, '正在刷新…');
        loadUsers().then(() => setMessage(usersMessage, '')).catch(error => setMessage(usersMessage, error.message, true));
    });
    document.getElementById('adminLogout').addEventListener('click', () => Auth.logout().catch(error => setMessage(usersMessage, error.message, true)));

    Auth.ready.then(() => {
        document.getElementById('adminIdentity').textContent = `当前管理员：${Auth.user.username}`;
        if (Auth.user.role !== 'admin') {
            window.location.replace('/');
            return;
        }
        return loadUsers();
    }).catch(error => setMessage(usersMessage, error.message, true));
})();
