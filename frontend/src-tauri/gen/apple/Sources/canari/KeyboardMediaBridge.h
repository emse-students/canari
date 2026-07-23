#pragma once

#import <Foundation/Foundation.h>

@class WKWebView;

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
