//! Glass window background: NSGlassEffectView (macOS 26) or
//! NSVisualEffectView blur fallback, inserted below the transparent webview.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::sel;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSColor, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol};
use tauri::{Runtime, WebviewWindow};

use super::{
    content_view, find_subview, glass_class, on_main_thread, parse_hex_color, set_identifier,
    ID_PREFIX,
};
use crate::models::WindowGlassOptions;
use crate::Error;

fn view_id() -> String {
    format!("{ID_PREFIX}glass-view")
}

pub fn set<R: Runtime>(window: WebviewWindow<R>, options: WindowGlassOptions) -> crate::Result<()> {
    on_main_thread(&window, move |win| {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| Error::WindowHandle("not on main thread".into()))?;
        let content = content_view(win)?;

        // Idempotent: replace any glass view from a previous call.
        if let Some(existing) = find_subview(&content, &view_id()) {
            existing.removeFromSuperview();
        }

        let glass: Retained<NSView> = match glass_class() {
            Some(cls) => unsafe { msg_send![cls, new] },
            None => {
                // Pre-macOS-26 fallback: behind-window blur.
                let effect = NSVisualEffectView::new(mtm);
                effect.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
                effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                effect.setState(NSVisualEffectState::FollowsWindowActiveState);
                Retained::into_super(effect)
            }
        };

        glass.setFrame(content.bounds());
        glass.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        set_identifier(&glass, &view_id());

        unsafe {
            // macOS 26 NSGlassEffectView options; guarded so the
            // NSVisualEffectView fallback (or an SDK rename) degrades to
            // plain glass instead of crashing.
            if let Some(radius) = options.corner_radius {
                if glass.respondsToSelector(sel!(setCornerRadius:)) {
                    let _: () = msg_send![&*glass, setCornerRadius: radius];
                }
            }
            if let Some(tint) = options.tint_color.as_deref().and_then(parse_hex_color) {
                if glass.respondsToSelector(sel!(setTintColor:)) {
                    let (r, g, b, a) = tint;
                    let color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a);
                    let _: () = msg_send![&*glass, setTintColor: &*color];
                }
            }

            // Below all siblings — i.e. behind the WKWebView, which must be
            // transparent (tauri.conf.json: window `transparent` +
            // `macOSPrivateApi`) for the glass to show through.
            content.addSubview_positioned_relativeTo(&glass, NSWindowOrderingMode::Below, None);
        }
        Ok(())
    })
}

pub fn clear<R: Runtime>(window: WebviewWindow<R>) -> crate::Result<()> {
    on_main_thread(&window, move |win| {
        let content = content_view(win)?;
        if let Some(existing) = find_subview(&content, &view_id()) {
            existing.removeFromSuperview();
        }
        Ok(())
    })
}
