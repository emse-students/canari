#pragma once

#import <Foundation/Foundation.h>

@class WKWebView;

/// Finds the app's WKWebView by traversing the connected window scenes.
///
/// Exposed rather than duplicated: this is the only way any native code here reaches the web
/// layer, and a second copy would be a second answer to "which WebView is the app's". Returns nil
/// before wry has created it, i.e. before `ffi::start_app()` - every caller must handle that.
WKWebView *_Nullable CanariFindWebView(void);

/// Bridges rich content (GIFs, images) committed by the iOS soft keyboard into the web layer.
///
/// iOS keyboards (e.g. Gboard) deliver media through UIPasteboard.general: the keyboard copies
/// the image to the pasteboard then triggers a paste. Android uses InputConnection.commitContent
/// (see KeyboardMediaBridge.kt), which we cannot intercept on iOS. Instead this bridge polls the
/// pasteboard's changeCount at a low frequency while the app is in the foreground and dispatches
/// newly-detected images to the frontend as a `canari-keyboard-media` DOM event, matching the
/// Android side byte-for-byte.
///
/// Call `CanariKeyboardMediaStart(wkWebView)` once after the WKWebView is created (post-bootstrap).
/// The bridge pauses polling automatically when the app resigns active and resumes on become-active.
void CanariKeyboardMediaStart(WKWebView *webView);
