async function fetchRuntimeVersion() {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) throw new Error('获取版本失败');
    const data = await response.json();
    return data?.version || 'unknown';
}

function displayVersion(version, error = false) {
    const versionElement = document.createElement('p');
    versionElement.className = 'text-gray-500 text-sm mt-1 text-center md:text-left';
    versionElement.textContent = `版本: ${error ? '检测失败' : version}`;
    if (error) versionElement.classList.add('text-amber-500');

    const copyright = document.querySelector('.footer p.text-gray-500.text-sm');
    if (copyright) {
        copyright.insertAdjacentElement('afterend', versionElement);
        return;
    }

    const footer = document.querySelector('.footer .container');
    footer?.appendChild(versionElement);
}

document.addEventListener('DOMContentLoaded', () => {
    fetchRuntimeVersion()
        .then(version => displayVersion(version))
        .catch(error => {
            console.error('版本检测出错:', error);
            displayVersion('', true);
        });
});
