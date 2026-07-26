(function () {
    if (window.LibreTVPlayerRuntimeSyncLoaded) return;

    const currentScript = document.currentScript;
    const baseUrl = currentScript?.src || document.baseURI;
    const runtimeUrl = new URL('player-runtime-sync.js', baseUrl);
    if (currentScript?.src) {
        runtimeUrl.search = new URL(currentScript.src).search;
    }

    const script = document.createElement('script');
    script.src = runtimeUrl.toString();
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
})();
