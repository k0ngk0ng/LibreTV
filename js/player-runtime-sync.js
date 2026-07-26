const selectedAPIs = (() => {
    try {
        const parsed = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
})();
window.LibreTVPlayerRuntimeSyncLoaded = true;
const customAPIs = (() => {
    try {
        if (typeof getStoredCustomApis === 'function') return getStoredCustomApis();
    } catch {
        // 混合缓存可能加载到不兼容的旧 helper；播放器仍应继续启动。
    }
    return [];
})();
const PLAYER_API_SITES = typeof API_SITES !== 'undefined' && API_SITES ? API_SITES : {};
const PLAYER_AD_FILTER_STORAGE = typeof PLAYER_CONFIG !== 'undefined'
    ? PLAYER_CONFIG.adFilteringStorage
    : 'adFilteringEnabled';
const PLAYER_PROXY_URL = typeof PROXY_URL !== 'undefined' ? PROXY_URL : '/proxy/';

function getPlayerCustomApiInfo(customApiIndex) {
    const index = Number.parseInt(customApiIndex, 10);
    return Number.isInteger(index) && index >= 0 && index < customAPIs.length ? customAPIs[index] : null;
}

// 改进返回功能
function goBack(event) {
    // 防止默认链接行为
    if (event) event.preventDefault();

    // 1. 优先检查URL参数中的returnUrl
    const urlParams = new URLSearchParams(window.location.search);
    const returnUrl = urlParams.get('returnUrl');

    if (returnUrl) {
        // 如果URL中有returnUrl参数，优先使用
        window.location.href = decodeURIComponent(returnUrl);
        return;
    }

    // 其次使用当前标签页独立保存的播放上下文
    const playbackState = PlaybackState.get(urlParams.get('playback'));
    if (playbackState?.returnUrl) {
        window.location.href = playbackState.returnUrl;
        return;
    }

    // 2. 检查当前标签页保存的lastPageUrl
    const lastPageUrl = sessionStorage.getItem('lastPageUrl');
    if (lastPageUrl && lastPageUrl !== window.location.href) {
        window.location.href = lastPageUrl;
        return;
    }

    // 3. 检查是否是从搜索页面进入的播放器
    const referrer = document.referrer;

    // 检查 referrer 是否包含搜索参数
    if (referrer && (referrer.includes('/s=') || referrer.includes('?s='))) {
        // 如果是从搜索页面来的，返回到搜索页面
        window.location.href = referrer;
        return;
    }

    // 4. 如果是在iframe中打开的，尝试关闭iframe
    if (window.self !== window.top) {
        try {
            // 尝试调用父窗口的关闭播放器函数
            window.parent.closeVideoPlayer && window.parent.closeVideoPlayer();
            return;
        } catch (e) {
            console.error('调用父窗口closeVideoPlayer失败:', e);
        }
    }

    // 5. 无法确定上一页，则返回首页
    if (!referrer || referrer === '') {
        window.location.href = '/';
        return;
    }

    // 6. 以上都不满足，使用默认行为：返回上一页
    window.history.back();
}

// 页面加载时在当前标签页保存返回目标
window.addEventListener('load', function () {
    // 保存前一页面URL
    if (document.referrer && document.referrer !== window.location.href) {
        sessionStorage.setItem('lastPageUrl', document.referrer);
    }
});


// =================================
// ============== PLAYER ==========
// =================================
// 全局变量
let currentVideoTitle = '';
let currentEpisodeIndex = 0;
let art = null; // 用于 ArtPlayer 实例
let currentHls = null; // 跟踪当前HLS实例
let currentEpisodes = [];
let episodesReversed = false;
let autoplayEnabled = true; // 默认开启自动连播
let videoHasEnded = false; // 跟踪视频是否已经自然结束
let userClickedPosition = null; // 记录用户点击的位置
let shortcutHintTimeout = null; // 用于控制快捷键提示显示时间
let adFilteringEnabled = true; // 默认开启广告过滤
let progressSaveInterval = null; // 定期保存进度的计时器
let currentVideoUrl = ''; // 记录当前实际的视频URL
let playbackStateId = ''; // 当前标签页独立的播放上下文
let activeMediaContext = null; // 当前 video 元素实际加载的剧集，避免切集时与目标剧集混淆
let playbackLoadGeneration = 0; // 每次同页切集递增，用于丢弃旧媒体的异步恢复结果
let pendingPlayerHistorySave = null;
let playerHistorySaveWorker = null;
let playerHistoryRetryTimer = null;
let playerHistoryRetryAttempt = 0;
let lastPlayerHistoryTimestamp = 0;
let lastSuccessfulPlayerHistoryTimestamp = 0;
const PLAYER_HISTORY_RETRY_DELAYS = [1000, 3000, 10000, 30000];
const PLAYER_HISTORY_REQUEST_TIMEOUT = 15000;
const PLAYER_HISTORY_KEEPALIVE_EVENTS = new Set(['beforeunload', 'pagehide', 'visibilitychange', 'freeze']);
const isWebkit = (typeof window.webkitConvertPointFromNodeToPage === 'function');
Artplayer.FULLSCREEN_WEB_IN_BODY = true;

// 页面加载
if (document.readyState === 'loading' || !document.readyState) {
    document.addEventListener('DOMContentLoaded', initializePageContent, { once: true });
} else {
    initializePageContent();
}

// 初始化页面内容
function initializePageContent() {

    // 解析URL参数
    const urlParams = new URLSearchParams(window.location.search);
    playbackStateId = urlParams.get('playback') || '';
    const playbackState = PlaybackState.get(playbackStateId);
    let videoUrl = urlParams.get('url');
    const title = urlParams.get('title') || playbackState?.title;
    const sourceCode = urlParams.get('source') || playbackState?.sourceCode;
    let index = parseInt(urlParams.get('index') || playbackState?.episodeIndex || '0');
    const episodesList = urlParams.get('episodes'); // 从URL获取集数信息
    const savedPosition = parseInt(urlParams.get('position') || '0'); // 获取保存的播放位置
    // 解决历史记录问题：检查URL是否是player.html开头的链接
    // 如果是，说明这是历史记录重定向，需要解析真实的视频URL
    if (videoUrl && videoUrl.includes('player.html')) {
        try {
            // 尝试从嵌套URL中提取真实的视频链接
            const nestedUrlParams = new URLSearchParams(videoUrl.split('?')[1]);
            // 从嵌套参数中获取真实视频URL
            const nestedVideoUrl = nestedUrlParams.get('url');
            // 检查嵌套URL是否包含播放位置信息
            const nestedPosition = nestedUrlParams.get('position');
            const nestedIndex = nestedUrlParams.get('index');
            const nestedTitle = nestedUrlParams.get('title');

            if (nestedVideoUrl) {
                videoUrl = nestedVideoUrl;

                // 更新当前URL参数
                const url = new URL(window.location.href);
                if (!urlParams.has('position') && nestedPosition) {
                    url.searchParams.set('position', nestedPosition);
                }
                if (!urlParams.has('index') && nestedIndex) {
                    url.searchParams.set('index', nestedIndex);
                }
                if (!urlParams.has('title') && nestedTitle) {
                    url.searchParams.set('title', nestedTitle);
                }
                // 替换当前URL
                window.history.replaceState({}, '', url);
            } else {
                showError('历史记录链接无效，请返回首页重新访问');
            }
        } catch (e) {
        }
    }

    // 保存当前视频URL
    currentVideoUrl = videoUrl || '';

    currentVideoTitle = title || '未知视频';
    currentEpisodeIndex = index;

    // 设置自动连播开关状态
    autoplayEnabled = localStorage.getItem('autoplayEnabled') !== 'false'; // 默认为true
    document.getElementById('autoplayToggle').checked = autoplayEnabled;

    // 获取广告过滤设置
    adFilteringEnabled = localStorage.getItem(PLAYER_AD_FILTER_STORAGE) !== 'false'; // 默认为true

    // 监听自动连播开关变化
    document.getElementById('autoplayToggle').addEventListener('change', function (e) {
        autoplayEnabled = e.target.checked;
        localStorage.setItem('autoplayEnabled', autoplayEnabled);
    });

    // 优先使用当前标签页的播放上下文，其次兼容URL传递的集数信息。
    try {
        if (playbackState?.episodes && Array.isArray(playbackState.episodes)) {
            currentEpisodes = [...playbackState.episodes];
        } else if (episodesList) {
            // 如果URL中有集数数据，优先使用它
            currentEpisodes = JSON.parse(decodeURIComponent(episodesList));
        } else {
            currentEpisodes = videoUrl ? [videoUrl] : [];
        }

        // 检查集数索引是否有效，如果无效则调整为0
        if (index < 0 || (currentEpisodes.length > 0 && index >= currentEpisodes.length)) {
            // 如果索引太大，则使用最大有效索引
            if (index >= currentEpisodes.length && currentEpisodes.length > 0) {
                index = currentEpisodes.length - 1;
            } else {
                index = 0;
            }

            // 更新URL以反映修正后的索引
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('index', index);
            window.history.replaceState({}, '', newUrl);
        }

        // 更新当前索引为验证过的值
        currentEpisodeIndex = index;
        if (!videoUrl && currentEpisodes[index]) videoUrl = currentEpisodes[index];
        currentVideoUrl = videoUrl || '';
        PlaybackState.update(playbackStateId, {
            title: currentVideoTitle,
            episodes: currentEpisodes,
            episodeIndex: currentEpisodeIndex,
            sourceCode: sourceCode || '',
        });

        episodesReversed = localStorage.getItem('episodesReversed') === 'true';
    } catch (e) {
        currentEpisodes = [];
        currentEpisodeIndex = 0;
        episodesReversed = false;
    }

    // 设置页面标题
    document.title = currentVideoTitle + ' - LibreTV播放器';
    document.getElementById('videoTitle').textContent = currentVideoTitle;

    // 初始化播放器
    if (videoUrl) {
        initPlayer(videoUrl);
    } else {
        showError('无效的视频链接');
    }

    // 渲染源信息
    renderResourceInfoBar();

    // 更新集数信息
    updateEpisodeInfo();

    // 渲染集数列表
    renderEpisodes();

    // 更新按钮状态
    updateButtonStates();

    // 更新排序按钮状态
    updateOrderButton();

    // 添加对进度条的监听，确保点击准确跳转
    setTimeout(() => {
        setupProgressBarPreciseClicks();
    }, 1000);

    // 添加键盘快捷键事件监听
    document.addEventListener('keydown', handleKeyboardShortcuts);

    // 添加页面离开事件监听，保存播放位置
    window.addEventListener('beforeunload', saveCurrentProgress);
    window.addEventListener('pagehide', saveCurrentProgress);
    window.addEventListener('online', retryPlayerHistorySaveNow);

    // 新增：页面隐藏（切后台/切标签）时也保存
    document.addEventListener('visibilitychange', function (event) {
        if (document.visibilityState === 'hidden') {
            saveCurrentProgress(event);
        }
    });
    document.addEventListener('freeze', saveCurrentProgress);

}

// 处理键盘快捷键
function handleKeyboardShortcuts(e) {
    // 忽略输入框中的按键事件
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
        if (currentEpisodeIndex > 0) {
            playPreviousEpisode();
            showShortcutHint('上一集', 'left');
            e.preventDefault();
        }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
        if (currentEpisodeIndex < currentEpisodes.length - 1) {
            playNextEpisode();
            showShortcutHint('下一集', 'right');
            e.preventDefault();
        }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
        if (art && art.currentTime > 5) {
            art.currentTime -= 5;
            showShortcutHint('快退', 'left');
            e.preventDefault();
        }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
        if (art && art.currentTime < art.duration - 5) {
            art.currentTime += 5;
            showShortcutHint('快进', 'right');
            e.preventDefault();
        }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
        if (art && art.volume < 1) {
            art.volume += 0.1;
            showShortcutHint('音量+', 'up');
            e.preventDefault();
        }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
        if (art && art.volume > 0) {
            art.volume -= 0.1;
            showShortcutHint('音量-', 'down');
            e.preventDefault();
        }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
        if (art) {
            art.toggle();
            showShortcutHint('播放/暂停', 'play');
            e.preventDefault();
        }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
        if (art) {
            art.fullscreen = !art.fullscreen;
            showShortcutHint('切换全屏', 'fullscreen');
            e.preventDefault();
        }
    }
}

// 显示快捷键提示
function showShortcutHint(text, direction) {
    const hintElement = document.getElementById('shortcutHint');
    const textElement = document.getElementById('shortcutText');
    const iconElement = document.getElementById('shortcutIcon');

    // 清除之前的超时
    if (shortcutHintTimeout) {
        clearTimeout(shortcutHintTimeout);
    }

    // 设置文本和图标方向
    textElement.textContent = text;

    if (direction === 'left') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>';
    } else if (direction === 'right') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>';
    }  else if (direction === 'up') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path>';
    } else if (direction === 'down') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>';
    } else if (direction === 'fullscreen') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"></path>';
    } else if (direction === 'play') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3l14 9-14 9V3z"></path>';
    }

    // 显示提示
    hintElement.classList.add('show');

    // 两秒后隐藏
    shortcutHintTimeout = setTimeout(() => {
        hintElement.classList.remove('show');
    }, 2000);
}

// 初始化播放器
function initPlayer(videoUrl) {
    if (!videoUrl) {
        return
    }

    // 销毁旧实例
    if (art) {
        art.destroy();
        art = null;
    }

    // 配置HLS.js选项
    const hlsConfig = {
        debug: false,
        loader: adFilteringEnabled ? CustomHlsJsLoader : Hls.DefaultConfig.loader,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 30 * 1000 * 1000,
        maxBufferHole: 0.5,
        fragLoadingMaxRetry: 6,
        fragLoadingMaxRetryTimeout: 64000,
        fragLoadingRetryDelay: 1000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        startLevel: -1,
        abrEwmaDefaultEstimate: 500000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        abrMaxWithRealBitrate: true,
        stretchShortVideoTrack: true,
        appendErrorMaxRetry: 5,  // 增加尝试次数
        liveSyncDurationCount: 3,
        liveDurationInfinity: false
    };

    // Create new ArtPlayer instance
    art = new Artplayer({
        container: '#player',
        url: videoUrl,
        type: 'm3u8',
        title: videoTitle,
        volume: 0.8,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: true,
        screenshot: true,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: true,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        hotkey: false,
        theme: '#23ade5',
        lang: navigator.language.toLowerCase(),
        moreVideoAttr: {
            crossOrigin: 'anonymous',
        },
        customType: {
            m3u8: function (video, url) {
                // 清理之前的HLS实例
                if (currentHls && currentHls.destroy) {
                    try {
                        currentHls.destroy();
                    } catch (e) {
                    }
                }

                // 创建新的HLS实例
                const hls = new Hls(hlsConfig);
                currentHls = hls;

                // 跟踪是否已经显示错误
                let errorDisplayed = false;
                // 跟踪是否有错误发生
                let errorCount = 0;
                // 跟踪视频是否开始播放
                let playbackStarted = false;
                // 跟踪视频是否出现bufferAppendError
                let bufferAppendErrorCount = 0;

                // 监听视频播放事件
                video.addEventListener('playing', function () {
                    playbackStarted = true;
                    document.getElementById('player-loading').style.display = 'none';
                    document.getElementById('error').style.display = 'none';
                });

                // 监听视频进度事件
                video.addEventListener('timeupdate', function () {
                    if (video.currentTime > 1) {
                        // 视频进度超过1秒，隐藏错误（如果存在）
                        document.getElementById('error').style.display = 'none';
                    }
                });

                hls.loadSource(url);
                hls.attachMedia(video);

                // enable airplay, from https://github.com/video-dev/hls.js/issues/5989
                // 检查是否已存在source元素，如果存在则更新，不存在则创建
                let sourceElement = video.querySelector('source');
                if (sourceElement) {
                    // 更新现有source元素的URL
                    sourceElement.src = videoUrl;
                } else {
                    // 创建新的source元素
                    sourceElement = document.createElement('source');
                    sourceElement.src = videoUrl;
                    video.appendChild(sourceElement);
                }
                video.disableRemotePlayback = false;

                hls.on(Hls.Events.MANIFEST_PARSED, function () {
                    video.play().catch(e => {
                    });
                });

                hls.on(Hls.Events.ERROR, function (event, data) {
                    // 增加错误计数
                    errorCount++;

                    // 处理bufferAppendError
                    if (data.details === 'bufferAppendError') {
                        bufferAppendErrorCount++;
                        // 如果视频已经开始播放，则忽略这个错误
                        if (playbackStarted) {
                            return;
                        }

                        // 如果出现多次bufferAppendError但视频未播放，尝试恢复
                        if (bufferAppendErrorCount >= 3) {
                            hls.recoverMediaError();
                        }
                    }

                    // 如果是致命错误，且视频未播放
                    if (data.fatal && !playbackStarted) {
                        // 尝试恢复错误
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                hls.recoverMediaError();
                                break;
                            default:
                                // 仅在多次恢复尝试后显示错误
                                if (errorCount > 3 && !errorDisplayed) {
                                    errorDisplayed = true;
                                    showError('视频加载失败，可能是格式不兼容或源不可用');
                                }
                                break;
                        }
                    }
                });

                // 监听分段加载事件
                hls.on(Hls.Events.FRAG_LOADED, function () {
                    document.getElementById('player-loading').style.display = 'none';
                });

                // 监听级别加载事件
                hls.on(Hls.Events.LEVEL_LOADED, function () {
                    document.getElementById('player-loading').style.display = 'none';
                });
            }
        }
    });
    const playerInstance = art;
    playerInstance.video.addEventListener('pause', saveCurrentProgress);

    // 自动隐藏工具栏的逻辑
    let hideTimer;
    const HIDE_DELAY = 2000; // 2秒后隐藏

    // 创建鼠标跟踪状态
    let isMouseActive = false;
    let isMouseOverPlayer = false;

    function hideControls() {
        if (isMouseActive || !isMouseOverPlayer) return;
        art.controls.classList.add('art-controls-hide');
    }

    function showControls() {
        art.controls.classList.remove('art-controls-hide');
    }

    function resetHideTimer() {
        clearTimeout(hideTimer);
        showControls();
        isMouseActive = true;

        hideTimer = setTimeout(() => {
            isMouseActive = false;
            hideControls();
        }, HIDE_DELAY);
    }

    // 监听全屏状态变化
    art.on('fullscreenWeb:enter', () => {
        // 添加全局事件监听
        document.addEventListener('mousemove', resetHideTimer);
        document.addEventListener('mouseleave', handleMouseLeave);
        document.addEventListener('mouseenter', handleMouseEnter);

        // 添加播放器区域事件
        art.player.addEventListener('mouseenter', () => isMouseOverPlayer = true);
        art.player.addEventListener('mouseleave', () => isMouseOverPlayer = false);

        // 初始状态
        isMouseOverPlayer = true;
        resetHideTimer();
    });

    art.on('fullscreenWeb:exit', () => {
        // 移除所有事件监听
        document.removeEventListener('mousemove', resetHideTimer);
        document.removeEventListener('mouseleave', handleMouseLeave);
        document.removeEventListener('mouseenter', handleMouseEnter);

        art.player.removeEventListener('mouseenter', () => isMouseOverPlayer = true);
        art.player.removeEventListener('mouseleave', () => isMouseOverPlayer = false);

        // 清除定时器并显示控件
        clearTimeout(hideTimer);
        showControls();
    });

    // 处理鼠标离开浏览器窗口
    function handleMouseLeave() {
        // 立即隐藏工具栏
        hideControls();
        clearTimeout(hideTimer);
    }

    // 处理鼠标返回浏览器窗口
    function handleMouseEnter() {
        isMouseActive = true;
        resetHideTimer();
    }

    // 播放器加载完成后初始隐藏工具栏
    playerInstance.on('ready', () => {
        if (art !== playerInstance) return;
        playerInstance.controls.classList.add('art-controls-hide');
    });

    // 全屏模式处理
    playerInstance.on('fullscreen', function () {
        if (art !== playerInstance) return;
        if (window.screen.orientation && window.screen.orientation.lock) {
            window.screen.orientation.lock('landscape')
                .then(() => {
                })
                .catch((error) => {
                });
        }
    });

    playerInstance.on('video:loadedmetadata', async function() {
        if (art !== playerInstance) return;
        document.getElementById('player-loading').style.display = 'none';
        videoHasEnded = false; // 视频加载时重置结束标志
        const loadContext = {
            generation: playbackLoadGeneration,
            videoUrl: currentVideoUrl,
            episodeIndex: currentEpisodeIndex,
            player: playerInstance,
            videoElement: playerInstance.video,
        };
        activeMediaContext = loadContext;

        // 只有首次打开播放器时恢复进度；同页切集必须从0开始。
        const shouldRestorePosition = loadContext.generation === 0;
        const urlParams = new URLSearchParams(window.location.search);
        let savedPosition = shouldRestorePosition ? parseInt(urlParams.get('position') || '0') : 0;

        if (shouldRestorePosition && !(savedPosition > 10)) {
            try {
                const sourceCode = urlParams.get('source') || PlaybackState.get(playbackStateId)?.sourceCode || '';
                const vodId = urlParams.get('id') || PlaybackState.get(playbackStateId)?.vodId || '';
                let lookupUrl = '';
                if (sourceCode && vodId) {
                    lookupUrl = `/api/history/lookup?source=${encodeURIComponent(sourceCode)}&vodId=${encodeURIComponent(vodId)}`;
                } else if (currentEpisodes[0]) {
                    lookupUrl = `/api/history/lookup?showIdentifier=${encodeURIComponent(currentEpisodes[0])}`;
                }
                if (lookupUrl) {
                    const response = await Auth.fetch(lookupUrl, { cache: 'no-store' });
                    const item = response.ok ? (await response.json()).item : null;
                    if (item && item.episodeIndex === loadContext.episodeIndex) {
                        savedPosition = Number(item.playbackPosition || 0);
                    }
                }
            } catch (error) {
                console.warn('读取服务器播放进度失败:', error);
            }
        }

        // 用户可能在历史查询完成前再次切集，旧请求不得修改新视频的时间。
        if (art !== playerInstance || activeMediaContext !== loadContext || playbackLoadGeneration !== loadContext.generation) {
            return;
        }

        if (savedPosition > 10 && savedPosition < playerInstance.duration - 2) {
            playerInstance.currentTime = savedPosition;
            showPositionRestoreHint(savedPosition);
        }

        // 设置进度条点击监听
        setupProgressBarPreciseClicks();

        // 视频加载成功后，在稍微延迟后将其添加到观看历史
        setTimeout(saveToHistory, 3000);

        // 启动定期保存播放进度
        startProgressSaveInterval();
    })

    // 错误处理
    playerInstance.on('video:error', function (error) {
        if (art !== playerInstance) return;
        // 如果正在切换视频，忽略错误
        if (window.isSwitchingVideo) {
            return;
        }

        // 隐藏所有加载指示器
        const loadingElements = document.querySelectorAll('#player-loading, .player-loading-container');
        loadingElements.forEach(el => {
            if (el) el.style.display = 'none';
        });

        showError('视频播放失败: ' + (error.message || '未知错误'));
    });

    // 添加移动端长按三倍速播放功能
    setupLongPressSpeedControl();

    // 视频播放结束事件
    playerInstance.on('video:ended', function () {
        if (art !== playerInstance) return;
        videoHasEnded = true;
        saveToHistory({ includeEpisodes: false });
        clearVideoProgress();

        // 如果自动播放下一集开启，且确实有下一集
        if (autoplayEnabled && currentEpisodeIndex < currentEpisodes.length - 1) {
            // 稍长延迟以确保所有事件处理完成
            setTimeout(() => {
                // 确认不是因为用户拖拽导致的假结束事件
                playNextEpisode();
                videoHasEnded = false; // 重置标志
            }, 1000);
        } else {
            playerInstance.fullscreen = false;
        }
    });

    // 添加双击全屏支持
    playerInstance.on('video:playing', () => {
        if (art !== playerInstance) return;
        // 绑定双击事件到视频容器
        if (playerInstance.video) {
            playerInstance.video.addEventListener('dblclick', () => {
                playerInstance.fullscreen = !playerInstance.fullscreen;
                playerInstance.play();
            });
        }
    });

    // 10秒后如果仍在加载，但不立即显示错误
    setTimeout(function () {
        if (art !== playerInstance) return;
        // 如果视频已经播放开始，则不显示错误
        if (playerInstance.video && playerInstance.video.currentTime > 0) {
            return;
        }

        const loadingElement = document.getElementById('player-loading');
        if (loadingElement && loadingElement.style.display !== 'none') {
            loadingElement.innerHTML = `
                <div class="loading-spinner"></div>
                <div>视频加载时间较长，请耐心等待...</div>
                <div style="font-size: 12px; color: #aaa; margin-top: 10px;">如长时间无响应，请尝试其他视频源</div>
            `;
        }
    }, 10000);
}

// 自定义M3U8 Loader用于过滤广告
class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
        super(config);
        const load = this.load.bind(this);
        this.load = function (context, config, callbacks) {
            // 拦截manifest和level请求
            if (context.type === 'manifest' || context.type === 'level') {
                const onSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, context) {
                    // 如果是m3u8文件，处理内容以移除广告分段
                    if (response.data && typeof response.data === 'string') {
                        // 过滤掉广告段 - 实现更精确的广告过滤逻辑
                        response.data = filterAdsFromM3U8(response.data, true);
                    }
                    return onSuccess(response, stats, context);
                };
            }
            // 执行原始load方法
            load(context, config, callbacks);
        };
    }
}

// 过滤可疑的广告内容
function filterAdsFromM3U8(m3u8Content, strictMode = false) {
    if (!m3u8Content) return '';

    // 按行分割M3U8内容
    const lines = m3u8Content.split('\n');
    const filteredLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 只过滤#EXT-X-DISCONTINUITY标识
        if (!line.includes('#EXT-X-DISCONTINUITY')) {
            filteredLines.push(line);
        }
    }

    return filteredLines.join('\n');
}


// 显示错误
function showError(message) {
    // 在视频已经播放的情况下不显示错误
    if (art && art.video && art.video.currentTime > 1) {
        return;
    }
    const loadingEl = document.getElementById('player-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    const errorEl = document.getElementById('error');
    if (errorEl) errorEl.style.display = 'flex';
    const errorMsgEl = document.getElementById('error-message');
    if (errorMsgEl) errorMsgEl.textContent = message;
}

// 更新集数信息
function updateEpisodeInfo() {
    if (currentEpisodes.length > 0) {
        document.getElementById('episodeInfo').textContent = `第 ${currentEpisodeIndex + 1}/${currentEpisodes.length} 集`;
    } else {
        document.getElementById('episodeInfo').textContent = '无集数信息';
    }
}

// 更新按钮状态
function updateButtonStates() {
    const prevButton = document.getElementById('prevButton');
    const nextButton = document.getElementById('nextButton');

    // 处理上一集按钮
    if (currentEpisodeIndex > 0) {
        prevButton.classList.remove('bg-gray-700', 'cursor-not-allowed');
        prevButton.classList.add('bg-[#222]', 'hover:bg-[#333]');
        prevButton.removeAttribute('disabled');
    } else {
        prevButton.classList.add('bg-gray-700', 'cursor-not-allowed');
        prevButton.classList.remove('bg-[#222]', 'hover:bg-[#333]');
        prevButton.setAttribute('disabled', '');
    }

    // 处理下一集按钮
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        nextButton.classList.remove('bg-gray-700', 'cursor-not-allowed');
        nextButton.classList.add('bg-[#222]', 'hover:bg-[#333]');
        nextButton.removeAttribute('disabled');
    } else {
        nextButton.classList.add('bg-gray-700', 'cursor-not-allowed');
        nextButton.classList.remove('bg-[#222]', 'hover:bg-[#333]');
        nextButton.setAttribute('disabled', '');
    }
}

// 渲染集数按钮
function renderEpisodes() {
    const episodesList = document.getElementById('episodesList');
    if (!episodesList) return;

    if (!currentEpisodes || currentEpisodes.length === 0) {
        episodesList.innerHTML = '<div class="col-span-full text-center text-gray-400 py-8">没有可用的集数</div>';
        return;
    }

    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    let html = '';

    episodes.forEach((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        const isActive = realIndex === currentEpisodeIndex;

        html += `
            <button id="episode-${realIndex}"
                    onclick="playEpisode(${realIndex})"
                    class="px-4 py-2 ${isActive ? 'episode-active' : '!bg-[#222] hover:!bg-[#333] hover:!shadow-none'} !border ${isActive ? '!border-blue-500' : '!border-[#333]'} rounded-lg transition-colors text-center episode-btn">
                ${realIndex + 1}
            </button>
        `;
    });

    episodesList.innerHTML = html;
}

// 播放指定集数
function playEpisode(index) {
    // 确保index在有效范围内
    if (index < 0 || index >= currentEpisodes.length) {
        return;
    }

    // 保存当前播放进度（如果正在播放）
    if (art && art.video && !art.video.paused && !videoHasEnded) {
        saveCurrentProgress();
    }

    // 清除进度保存计时器
    if (progressSaveInterval) {
        clearInterval(progressSaveInterval);
        progressSaveInterval = null;
    }

    // 首先隐藏之前可能显示的错误
    document.getElementById('error').style.display = 'none';
    // 显示加载指示器
    document.getElementById('player-loading').style.display = 'flex';
    document.getElementById('player-loading').innerHTML = `
        <div class="loading-spinner"></div>
        <div>正在加载视频...</div>
    `;

    // 获取 sourceCode
    const urlParams2 = new URLSearchParams(window.location.search);
    const sourceCode = urlParams2.get('source_code');

    // 准备切换剧集的URL
    const url = currentEpisodes[index];

    playbackLoadGeneration += 1;

    // 更新当前剧集索引
    currentEpisodeIndex = index;
    currentVideoUrl = url;
    videoHasEnded = false; // 重置视频结束标志
    PlaybackState.update(playbackStateId, {
        title: currentVideoTitle,
        episodes: currentEpisodes,
        episodeIndex: index,
    });

    clearVideoProgress();

    // 更新URL参数（不刷新页面）
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('index', index);
    currentUrl.searchParams.set('url', url);
    currentUrl.searchParams.delete('position');
    window.history.replaceState({}, '', currentUrl.toString());

    if (isWebkit) {
        initPlayer(url);
    } else {
        art.switch = url;
    }

    // 更新UI
    updateEpisodeInfo();
    updateButtonStates();
    renderEpisodes();

    // 重置用户点击位置记录
    userClickedPosition = null;

    // 三秒后保存到历史记录
    setTimeout(() => saveToHistory(), 3000);
}

// 播放上一集
function playPreviousEpisode() {
    if (currentEpisodeIndex > 0) {
        playEpisode(currentEpisodeIndex - 1);
    }
}

// 播放下一集
function playNextEpisode() {
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
    }
}

// 复制播放链接
function copyLinks() {
    // 尝试从URL中获取参数
    const urlParams = new URLSearchParams(window.location.search);
    const linkUrl = urlParams.get('url') || '';
    if (linkUrl !== '') {
        navigator.clipboard.writeText(linkUrl).then(() => {
            showToast('播放链接已复制', 'success');
        }).catch(err => {
            showToast('复制失败，请检查浏览器权限', 'error');
        });
    }
}

// 切换集数排序
function toggleEpisodeOrder() {
    episodesReversed = !episodesReversed;

    // 保存到localStorage
    localStorage.setItem('episodesReversed', episodesReversed);

    // 重新渲染集数列表
    renderEpisodes();

    // 更新排序按钮
    updateOrderButton();
}

// 更新排序按钮状态
function updateOrderButton() {
    const orderText = document.getElementById('orderText');
    const orderIcon = document.getElementById('orderIcon');

    if (orderText && orderIcon) {
        orderText.textContent = episodesReversed ? '正序排列' : '倒序排列';
        orderIcon.style.transform = episodesReversed ? 'rotate(180deg)' : '';
    }
}

// 设置进度条准确点击处理
function setupProgressBarPreciseClicks() {
    // 查找DPlayer的进度条元素
    const progressBar = document.querySelector('.dplayer-bar-wrap');
    if (!progressBar || !art || !art.video) return;

    // 移除可能存在的旧事件监听器
    progressBar.removeEventListener('mousedown', handleProgressBarClick);

    // 添加新的事件监听器
    progressBar.addEventListener('mousedown', handleProgressBarClick);

    // 在移动端也添加触摸事件支持
    progressBar.removeEventListener('touchstart', handleProgressBarTouch);
    progressBar.addEventListener('touchstart', handleProgressBarTouch);

    // 处理进度条点击
    function handleProgressBarClick(e) {
        if (!art || !art.video) return;

        // 计算点击位置相对于进度条的比例
        const rect = e.currentTarget.getBoundingClientRect();
        const percentage = (e.clientX - rect.left) / rect.width;

        // 计算点击位置对应的视频时间
        const duration = art.video.duration;
        let clickTime = percentage * duration;

        // 处理视频接近结尾的情况
        if (duration - clickTime < 1) {
            // 如果点击位置非常接近结尾，稍微往前移一点
            clickTime = Math.min(clickTime, duration - 1.5);

        }

        // 记录用户点击的位置
        userClickedPosition = clickTime;

        // 阻止默认事件传播，避免DPlayer内部逻辑将视频跳至末尾
        e.stopPropagation();

        // 直接设置视频时间
        art.seek(clickTime);
    }

    // 处理移动端触摸事件
    function handleProgressBarTouch(e) {
        if (!art || !art.video || !e.touches[0]) return;

        const touch = e.touches[0];
        const rect = e.currentTarget.getBoundingClientRect();
        const percentage = (touch.clientX - rect.left) / rect.width;

        const duration = art.video.duration;
        let clickTime = percentage * duration;

        // 处理视频接近结尾的情况
        if (duration - clickTime < 1) {
            clickTime = Math.min(clickTime, duration - 1.5);
        }

        // 记录用户点击的位置
        userClickedPosition = clickTime;

        e.stopPropagation();
        art.seek(clickTime);
    }
}

// 在播放器初始化后添加或更新服务器端观看记录
function captureActivePlaybackSnapshot() {
    if (!activeMediaContext || !art || !art.video) return null;
    if (activeMediaContext.player && activeMediaContext.player !== art) return null;
    if (activeMediaContext.videoElement && activeMediaContext.videoElement !== art.video) return null;
    const video = activeMediaContext.videoElement || art.video;
    return {
        videoUrl: activeMediaContext.videoUrl,
        episodeIndex: activeMediaContext.episodeIndex,
        generation: activeMediaContext.generation,
        playbackPosition: Number(video.currentTime) || 0,
        duration: Number(video.duration) || 0,
    };
}

const nextPlayerHistoryTimestamp = () => {
    lastPlayerHistoryTimestamp = Math.max(Date.now(), lastPlayerHistoryTimestamp + 1);
    return lastPlayerHistoryTimestamp;
};

const playerHistoryTimestamp = payload => {
    const timestamp = Number(payload?.timestamp);
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const mergePlayerHistorySave = (current, incoming) => {
    if (!current) return incoming ? { ...incoming } : null;
    if (!incoming) return { ...current };

    const currentIsNewer = playerHistoryTimestamp(current) > playerHistoryTimestamp(incoming);
    const older = currentIsNewer ? incoming : current;
    const newer = currentIsNewer ? current : incoming;
    const merged = { ...older, ...newer };
    if (!Array.isArray(newer.episodes) && Array.isArray(older.episodes)) {
        merged.episodes = [...older.episodes];
    }
    return merged;
};

const cancelPlayerHistoryRetry = () => {
    if (!playerHistoryRetryTimer) return;
    clearTimeout(playerHistoryRetryTimer);
    playerHistoryRetryTimer = null;
};

const postPlayerHistory = async (videoInfo, { keepalive = false } = {}) => {
    let controller = null;
    let timeoutId = null;
    if (!keepalive && typeof AbortController === 'function') {
        controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), PLAYER_HISTORY_REQUEST_TIMEOUT);
    }

    try {
        const response = await Auth.fetch('/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(videoInfo),
            keepalive,
            ...(controller ? { signal: controller.signal } : {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '保存观看记录失败');
        return data.item;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

const markPlayerHistorySaveSucceeded = payload => {
    const timestamp = playerHistoryTimestamp(payload);
    lastSuccessfulPlayerHistoryTimestamp = Math.max(lastSuccessfulPlayerHistoryTimestamp, timestamp);
    if (pendingPlayerHistorySave && playerHistoryTimestamp(pendingPlayerHistorySave) <= timestamp) {
        pendingPlayerHistorySave = null;
    }
    playerHistoryRetryAttempt = 0;
    cancelPlayerHistoryRetry();
};

const schedulePlayerHistoryRetry = () => {
    if (playerHistoryRetryTimer || !pendingPlayerHistorySave) return;
    const delay = PLAYER_HISTORY_RETRY_DELAYS[Math.min(
        Math.max(0, playerHistoryRetryAttempt - 1),
        PLAYER_HISTORY_RETRY_DELAYS.length - 1,
    )];
    playerHistoryRetryTimer = setTimeout(() => {
        playerHistoryRetryTimer = null;
        startPlayerHistorySaveWorker();
    }, delay);
};

const handlePlayerHistorySaveFailure = (payload, error) => {
    if (playerHistoryTimestamp(payload) > lastSuccessfulPlayerHistoryTimestamp) {
        pendingPlayerHistorySave = mergePlayerHistorySave(payload, pendingPlayerHistorySave);
    }
    playerHistoryRetryAttempt += 1;
    console.warn('保存服务器观看进度失败，将自动重试:', error);
    schedulePlayerHistoryRetry();
};

const startPlayerHistorySaveWorker = () => {
    if (playerHistorySaveWorker || playerHistoryRetryTimer || !pendingPlayerHistorySave) {
        return playerHistorySaveWorker || Promise.resolve();
    }

    const payload = pendingPlayerHistorySave;
    pendingPlayerHistorySave = null;
    playerHistorySaveWorker = postPlayerHistory(payload)
        .then(() => markPlayerHistorySaveSucceeded(payload))
        .catch(error => handlePlayerHistorySaveFailure(payload, error))
        .finally(() => {
            playerHistorySaveWorker = null;
            if (pendingPlayerHistorySave && !playerHistoryRetryTimer) {
                startPlayerHistorySaveWorker();
            }
        });
    return playerHistorySaveWorker;
};

const flushUrgentPlayerHistorySave = () => {
    if (!pendingPlayerHistorySave) return Promise.resolve();
    const payload = pendingPlayerHistorySave;
    return postPlayerHistory(payload, { keepalive: true })
        .then(() => markPlayerHistorySaveSucceeded(payload))
        .catch(error => handlePlayerHistorySaveFailure(payload, error));
};

const queuePlayerHistorySave = (videoInfo, { keepalive = false } = {}) => {
    pendingPlayerHistorySave = mergePlayerHistorySave(pendingPlayerHistorySave, videoInfo);
    if (keepalive) return flushUrgentPlayerHistorySave();
    return startPlayerHistorySaveWorker();
};

function retryPlayerHistorySaveNow() {
    cancelPlayerHistoryRetry();
    startPlayerHistorySaveWorker();
}

async function saveToHistory({ includeEpisodes = true, keepalive = false, playbackSnapshot = null } = {}) {
    const snapshot = playbackSnapshot || captureActivePlaybackSnapshot();

    // 确保 currentEpisodes 非空且有当前视频URL
    if (!currentEpisodes || currentEpisodes.length === 0 || !snapshot?.videoUrl) {
        return;
    }

    // 尝试从URL中获取参数
    const urlParams = new URLSearchParams(window.location.search);
    const playbackState = PlaybackState.get(playbackStateId);
    const sourceCode = urlParams.get('source') || playbackState?.sourceCode || '';
    const sourceName = playbackState?.sourceName || PLAYER_API_SITES[sourceCode]?.name || sourceCode;
    const id_from_params = urlParams.get('id') || playbackState?.vodId || '';

    const showIdentifier = sourceCode && id_from_params
        ? `${sourceCode}_${id_from_params}`
        : (currentEpisodes[0] || snapshot.videoUrl);

    // 构建要保存的视频信息对象
    const videoInfo = {
        title: currentVideoTitle,
        directVideoUrl: snapshot.videoUrl, // Current episode's direct URL
        url: `player.html?url=${encodeURIComponent(snapshot.videoUrl)}&title=${encodeURIComponent(currentVideoTitle)}&source=${encodeURIComponent(sourceName)}&source_code=${encodeURIComponent(sourceCode)}&id=${encodeURIComponent(id_from_params || '')}&index=${snapshot.episodeIndex}&position=${Math.floor(snapshot.playbackPosition || 0)}`,
        episodeIndex: snapshot.episodeIndex,
        sourceName,
        vod_id: id_from_params,
        sourceCode,
        showIdentifier,
        timestamp: nextPlayerHistoryTimestamp(),
        playbackPosition: snapshot.playbackPosition,
        duration: snapshot.duration,
        ...(includeEpisodes ? { episodes: [...currentEpisodes] } : {}),
    };

    await queuePlayerHistorySave(videoInfo, { keepalive });
}

// 显示恢复位置提示
function showPositionRestoreHint(position) {
    if (!position || position < 10) return;

    // 创建提示元素
    const hint = document.createElement('div');
    hint.className = 'position-restore-hint';
    hint.innerHTML = `
        <div class="hint-content">
            已从 ${formatTime(position)} 继续播放
        </div>
    `;

    // 添加到播放器容器
    const playerContainer = document.querySelector('.player-container'); // Ensure this selector is correct
    if (playerContainer) { // Check if playerContainer exists
        playerContainer.appendChild(hint);
    } else {
        return; // Exit if container not found
    }

    // 显示提示
    setTimeout(() => {
        hint.classList.add('show');

        // 3秒后隐藏
        setTimeout(() => {
            hint.classList.remove('show');
            setTimeout(() => hint.remove(), 300);
        }, 3000);
    }, 100);
}

// 格式化时间为 mm:ss 格式
function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 开始定期保存播放进度
function startProgressSaveInterval() {
    // 清除可能存在的旧计时器
    if (progressSaveInterval) {
        clearInterval(progressSaveInterval);
    }

    // 每30秒保存一次播放进度
    progressSaveInterval = setInterval(saveCurrentProgress, 30000);
}

// 保存当前播放进度
function saveCurrentProgress(event) {
    const snapshot = captureActivePlaybackSnapshot();
    if (!snapshot || !snapshot.duration || snapshot.playbackPosition < 1) return;

    // playEpisode 会在递增 generation 前显式保存旧集；之后到达的任何旧媒体事件都必须忽略。
    if (snapshot.generation !== playbackLoadGeneration) return;

    saveToHistory({
        includeEpisodes: false,
        keepalive: PLAYER_HISTORY_KEEPALIVE_EVENTS.has(event?.type),
        playbackSnapshot: snapshot,
    });
}

// 设置移动端长按三倍速播放功能
function setupLongPressSpeedControl() {
    if (!art || !art.video) return;

    const playerElement = document.getElementById('player');
    let longPressTimer = null;
    let originalPlaybackRate = 1.0;
    let isLongPress = false;

    // 显示快速提示
    function showSpeedHint(speed) {
        showShortcutHint(`${speed}倍速`, 'right');
    }

    // 禁用右键
    playerElement.oncontextmenu = () => {
        // 检测是否为移动设备
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        // 只在移动设备上禁用右键
        if (isMobile) {
            const dplayerMenu = document.querySelector(".dplayer-menu");
            const dplayerMask = document.querySelector(".dplayer-mask");
            if (dplayerMenu) dplayerMenu.style.display = "none";
            if (dplayerMask) dplayerMask.style.display = "none";
            return false;
        }
        return true; // 在桌面设备上允许右键菜单
    };

    // 触摸开始事件
    playerElement.addEventListener('touchstart', function (e) {
        // 检查视频是否正在播放，如果没有播放则不触发长按功能
        if (art.video.paused) {
            return; // 视频暂停时不触发长按功能
        }

        // 保存原始播放速度
        originalPlaybackRate = art.video.playbackRate;

        // 设置长按计时器
        longPressTimer = setTimeout(() => {
            // 再次检查视频是否仍在播放
            if (art.video.paused) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                return;
            }

            // 长按超过500ms，设置为3倍速
            art.video.playbackRate = 3.0;
            isLongPress = true;
            showSpeedHint(3.0);

            // 只在确认为长按时阻止默认行为
            e.preventDefault();
        }, 500);
    }, { passive: false });

    // 触摸结束事件
    playerElement.addEventListener('touchend', function (e) {
        // 清除长按计时器
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        // 如果是长按状态，恢复原始播放速度
        if (isLongPress) {
            art.video.playbackRate = originalPlaybackRate;
            isLongPress = false;
            showSpeedHint(originalPlaybackRate);

            // 阻止长按后的点击事件
            e.preventDefault();
        }
        // 如果不是长按，则允许正常的点击事件（暂停/播放）
    });

    // 触摸取消事件
    playerElement.addEventListener('touchcancel', function () {
        // 清除长按计时器
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        // 如果是长按状态，恢复原始播放速度
        if (isLongPress) {
            art.video.playbackRate = originalPlaybackRate;
            isLongPress = false;
        }
    });

    // 触摸移动事件 - 防止在长按时触发页面滚动
    playerElement.addEventListener('touchmove', function (e) {
        if (isLongPress) {
            e.preventDefault();
        }
    }, { passive: false });

    // 视频暂停时取消长按状态
    art.video.addEventListener('pause', function () {
        if (isLongPress) {
            art.video.playbackRate = originalPlaybackRate;
            isLongPress = false;
        }

        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    });
}

// 清除视频进度记录
function clearVideoProgress() {
    // 进度由服务器按用户和剧集保存；切换集数时无需清理其他标签页的数据。
}

let controlsLocked = false;
function toggleControlsLock() {
    const container = document.getElementById('playerContainer');
    controlsLocked = !controlsLocked;
    container.classList.toggle('controls-locked', controlsLocked);
    const icon = document.getElementById('lockIcon');
    // 切换图标：锁 / 解锁
    icon.innerHTML = controlsLocked
        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d=\"M12 15v2m0-8V7a4 4 0 00-8 0v2m8 0H4v8h16v-8H6v-6z\"/>'
        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d=\"M15 11V7a3 3 0 00-6 0v4m-3 4h12v6H6v-6z\"/>';
}

// 支持在iframe中关闭播放器
function closeEmbeddedPlayer() {
    try {
        if (window.self !== window.top) {
            // 如果在iframe中，尝试调用父窗口的关闭方法
            if (window.parent && typeof window.parent.closeVideoPlayer === 'function') {
                window.parent.closeVideoPlayer();
                return true;
            }
        }
    } catch (e) {
        console.error('尝试关闭嵌入式播放器失败:', e);
    }
    return false;
}

function renderResourceInfoBar() {
    // 获取容器元素
    const container = document.getElementById('resourceInfoBarContainer');
    if (!container) {
        console.error('找不到资源信息卡片容器');
        return;
    }

    // 获取当前视频 source_code
    const urlParams = new URLSearchParams(window.location.search);
    const currentSource = urlParams.get('source') || '';

    // 查找当前源名称，从 API_SITES 和 custom_api 中查找即可
    let resourceName = currentSource
    if (currentSource && PLAYER_API_SITES[currentSource]) {
        resourceName = PLAYER_API_SITES[currentSource].name;
    }
    if (resourceName === currentSource) {
        const customIndex = parseInt(currentSource.replace('custom_', ''), 10);
        if (customAPIs[customIndex]) {
            resourceName = customAPIs[customIndex].name || '自定义资源';
        }
    }

    container.replaceChildren();
    const left = document.createElement('div');
    left.className = 'resource-info-bar-left flex';
    const name = document.createElement('span');
    name.textContent = resourceName || '未知资源';
    const count = document.createElement('span');
    count.className = 'resource-info-bar-videos';
    count.textContent = `${currentEpisodes.length} 个视频`;
    left.append(name, count);

    const button = document.createElement('button');
    button.className = 'resource-switch-btn flex';
    button.id = 'switchResourceBtn';
    button.innerHTML = '<span class="resource-switch-icon"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v16m0 0l-6-6m6 6l6-6" stroke="#a67c2d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>切换资源';
    button.addEventListener('click', showSwitchResourceModal);
    container.append(left, button);
}

async function showSwitchResourceModal() {
    const urlParams = new URLSearchParams(window.location.search);
    const currentSourceCode = urlParams.get('source');
    const currentVideoId = urlParams.get('id');

    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modalTitle');
    const modalContent = document.getElementById('modalContent');

    modalTitle.textContent = currentVideoTitle;
    modalContent.innerHTML = '<div style="text-align:center;padding:20px;color:#aaa;grid-column:1/-1;">正在加载资源列表...</div>';
    modal.classList.remove('hidden');

    // 搜索
    const resourceOptions = selectedAPIs.map((curr) => {
        if (PLAYER_API_SITES[curr]) {
            return { key: curr, name: PLAYER_API_SITES[curr].name };
        }
        const customIndex = parseInt(curr.replace('custom_', ''), 10);
        if (customAPIs[customIndex]) {
            return { key: curr, name: customAPIs[customIndex].name || '自定义资源' };
        }
        return { key: curr, name: '未知资源' };
    });
    let allResults = {};
    await Promise.all(resourceOptions.map(async (opt) => {
        let queryResult = await searchByAPIAndKeyWord(opt.key, currentVideoTitle);
        if (queryResult.length == 0) {
            return
        }
        // 优先取完全同名资源，否则默认取第一个
        let result = queryResult[0]
        queryResult.forEach((res) => {
            if (res.vod_name == currentVideoTitle) {
                result = res;
            }
        })
        allResults[opt.key] = result;
    }));

    // 对结果进行排序
    const sortedResults = Object.entries(allResults).sort(([keyA, resultA], [keyB, resultB]) => {
        // 当前播放的源放在最前面
        const isCurrentA = String(keyA) === String(currentSourceCode) && String(resultA.vod_id) === String(currentVideoId);
        const isCurrentB = String(keyB) === String(currentSourceCode) && String(resultB.vod_id) === String(currentVideoId);

        if (isCurrentA && !isCurrentB) return -1;
        if (!isCurrentA && isCurrentB) return 1;

        // 其余按照 selectedAPIs 的顺序排列
        const indexA = selectedAPIs.indexOf(keyA);
        const indexB = selectedAPIs.indexOf(keyB);

        return indexA - indexB;
    });

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3 p-4';
    for (const [sourceKey, result] of sortedResults) {
        if (!result) continue;
        const isCurrentSource = String(sourceKey) === String(currentSourceCode) && String(result.vod_id) === String(currentVideoId);
        const sourceName = resourceOptions.find(opt => opt.key === sourceKey)?.name || '未知资源';
        const card = document.createElement('div');
        card.className = `relative group ${isCurrentSource ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:scale-105 transition-transform'}`;
        if (!isCurrentSource) card.addEventListener('click', () => switchToResource(sourceKey, result.vod_id));

        const imageWrapper = document.createElement('div');
        imageWrapper.className = 'aspect-[2/3] rounded-lg overflow-hidden bg-gray-800';
        const image = document.createElement('img');
        image.src = /^https?:\/\//i.test(String(result.vod_pic || '')) ? `${PLAYER_PROXY_URL}${encodeURIComponent(result.vod_pic)}` : 'image/nomedia.png';
        image.alt = String(result.vod_name || currentVideoTitle);
        image.className = 'w-full h-full object-cover';
        image.addEventListener('error', () => { image.src = 'image/nomedia.png'; }, { once: true });
        imageWrapper.appendChild(image);

        const textWrapper = document.createElement('div');
        textWrapper.className = 'mt-1';
        const resultName = document.createElement('div');
        resultName.className = 'text-xs font-medium text-gray-200 truncate';
        resultName.textContent = String(result.vod_name || currentVideoTitle);
        const source = document.createElement('div');
        source.className = 'text-[10px] text-gray-400';
        source.textContent = sourceName;
        textWrapper.append(resultName, source);
        card.append(imageWrapper, textWrapper);

        if (isCurrentSource) {
            const overlay = document.createElement('div');
            overlay.className = 'absolute inset-0 flex items-center justify-center';
            const badge = document.createElement('div');
            badge.className = 'bg-black bg-opacity-50 rounded-lg px-2 py-0.5 text-xs text-white';
            badge.textContent = '当前播放';
            overlay.appendChild(badge);
            card.appendChild(overlay);
        }
        grid.appendChild(card);
    }
    modalContent.replaceChildren(grid);
}

// 切换资源的函数
async function switchToResource(sourceKey, vodId) {
    // 关闭模态框
    document.getElementById('modal').classList.add('hidden');

    showLoading();
    try {
        // 构建API参数
        let apiParams = '';

        // 处理自定义API源
        if (sourceKey.startsWith('custom_')) {
            const customIndex = sourceKey.replace('custom_', '');
            const customApi = getPlayerCustomApiInfo(customIndex);
            if (!customApi) {
                showToast('自定义API配置无效', 'error');
                hideLoading();
                return;
            }
            // 传递 detail 字段
            if (customApi.detail) {
                apiParams = '&customApi=' + encodeURIComponent(customApi.url) + '&customDetail=' + encodeURIComponent(customApi.detail) + '&source=custom';
            } else {
                apiParams = '&customApi=' + encodeURIComponent(customApi.url) + '&source=custom';
            }
        } else {
            // 内置API
            apiParams = '&source=' + sourceKey;
        }

        // Add a timestamp to prevent caching
        const timestamp = new Date().getTime();
        const cacheBuster = `&_t=${timestamp}`;
        const response = await fetch(`/api/detail?id=${encodeURIComponent(vodId)}${apiParams}${cacheBuster}`);

        const data = await response.json();

        if (!data.episodes || data.episodes.length === 0) {
            showToast('未找到播放资源', 'error');
            hideLoading();
            return;
        }

        // 获取当前播放的集数索引
        const currentIndex = currentEpisodeIndex;

        // 确定要播放的集数索引
        let targetIndex = 0;
        if (currentIndex < data.episodes.length) {
            // 如果当前集数在新资源中存在，则使用相同集数
            targetIndex = currentIndex;
        }

        // 获取目标集数的URL
        const targetUrl = data.episodes[targetIndex];

        const previousState = PlaybackState.get(playbackStateId);
        if (playbackStateId) {
            PlaybackState.update(playbackStateId, {
                title: currentVideoTitle,
                episodes: data.episodes,
                episodeIndex: targetIndex,
                sourceCode: sourceKey,
                sourceName: PLAYER_API_SITES[sourceKey]?.name || sourceKey,
                vodId,
            });
        } else {
            playbackStateId = PlaybackState.create({
                title: currentVideoTitle,
                episodes: data.episodes,
                episodeIndex: targetIndex,
                sourceCode: sourceKey,
                sourceName: PLAYER_API_SITES[sourceKey]?.name || sourceKey,
                vodId,
                returnUrl: previousState?.returnUrl || '/',
            });
        }

        const watchUrl = new URL('/player.html', window.location.origin);
        watchUrl.searchParams.set('id', vodId);
        watchUrl.searchParams.set('source', sourceKey);
        watchUrl.searchParams.set('url', targetUrl);
        watchUrl.searchParams.set('index', targetIndex);
        watchUrl.searchParams.set('title', currentVideoTitle);
        watchUrl.searchParams.set('playback', playbackStateId);
        if (previousState?.returnUrl) watchUrl.searchParams.set('returnUrl', previousState.returnUrl);

        // 跳转到播放页面
        window.location.href = watchUrl.toString();

    } catch (error) {
        console.error('切换资源失败:', error);
        showToast('切换资源失败，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}
