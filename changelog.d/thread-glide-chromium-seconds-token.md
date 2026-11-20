### Fixed - the thread glide plays on Chromium and the Android WebView, and no longer warns at every arrival

`motionMs` accepted only `220ms`, while Chromium answers the token as `.22s`, so the glide never ran there and a WARN was logged at each message arrival. The parser now reads `ms` and `s`, leading-dot numbers included ([threadGrowthObserver](frontend/src/lib/utils/chat/threadGrowthObserver.ts)).
