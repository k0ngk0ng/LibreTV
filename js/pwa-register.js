// PWA 注册
if ('serviceWorker' in navigator) {
    let reloadingForNewWorker = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadingForNewWorker) return;
        reloadingForNewWorker = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
            .then(registration => registration.update())
            .catch(error => console.error('Service Worker 更新失败:', error));
    });
}
