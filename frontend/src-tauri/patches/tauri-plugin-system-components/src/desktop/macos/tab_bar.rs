//! Native floating tab bar: NSSegmentedControl (the NSTabViewController
//! toolbar-tabs control) in a glass capsule pinned to the bottom center.

use std::sync::{Arc, Mutex};

use objc2::rc::Retained;
use objc2::{msg_send, sel};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSColor, NSControlSize, NSImage, NSImageScaling,
    NSSegmentSwitchTracking, NSSegmentedControl,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use tauri::{AppHandle, Emitter, Runtime, WebviewWindow};

use super::{
    attach_target, circular_image, content_view, find_subview, glass_capsule, image_from_base64,
    on_main_thread, parse_hex_color, set_identifier, ActionTarget, ID_PREFIX,
};
use crate::models::{ConfigureTabBarOptions, TabBarInsets, TabSelectedPayload};
use crate::Error;

/// Event listened to by the JS `onTabSelected` helper (the desktop
/// counterpart of the iOS plugin-event channel).
const TAB_SELECTED_EVENT: &str = "system-components://tab-selected";

/// Gap between the floating capsule and the window's bottom edge.
const BAR_BOTTOM_MARGIN: f64 = 20.0;
/// Padding around the segmented control inside the capsule.
const BAR_PADDING_X: f64 = 10.0;
const BAR_PADDING_Y: f64 = 8.0;
/// Side of bitmap tab icons (avatars), in points.
const TAB_IMAGE_SIDE: f64 = 18.0;

fn bar_id() -> String {
    format!("{ID_PREFIX}tab-bar")
}
fn control_id() -> String {
    format!("{ID_PREFIX}tab-control")
}

pub fn configure<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    tab_ids: &Arc<Mutex<Vec<String>>>,
    options: ConfigureTabBarOptions,
) -> crate::Result<()> {
    if options.items.is_empty() {
        return Err(Error::WindowHandle(
            "configureTabBar requires at least one item".into(),
        ));
    }
    let ids: Vec<String> = options.items.iter().map(|i| i.id.clone()).collect();
    *tab_ids.lock().unwrap() = ids.clone();
    let ids_for_action = Arc::clone(tab_ids);

    on_main_thread(&window, move |win| {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| Error::WindowHandle("not on main thread".into()))?;
        let content = content_view(win)?;

        // Idempotent: rebuild from scratch on reconfigure.
        if let Some(existing) = find_subview(&content, &bar_id()) {
            existing.removeFromSuperview();
        }

        let control = NSSegmentedControl::new(mtm);
        let count = options.items.len() as isize;
        control.setSegmentCount(count);
        control.setTrackingMode(NSSegmentSwitchTracking::SelectOne);
        control.setControlSize(NSControlSize::Large);
        for (i, item) in options.items.iter().enumerate() {
            let idx = i as isize;
            control.setLabel_forSegment(&NSString::from_str(&item.title), idx);
            let image: Option<Retained<NSImage>> = match &item.image {
                // Bitmap icon (e.g. avatar), optionally clipped to a circle.
                Some(b64) => image_from_base64(b64).map(|img| {
                    if item.circular.unwrap_or(false) {
                        circular_image(&img, TAB_IMAGE_SIDE)
                    } else {
                        img
                    }
                }),
                // SF Symbols exist on macOS 11+; nil renders the label only.
                None => item.sf_symbol.as_deref().and_then(|name| {
                    NSImage::imageWithSystemSymbolName_accessibilityDescription(
                        &NSString::from_str(name),
                        None,
                    )
                }),
            };
            control.setImage_forSegment(image.as_deref(), idx);
            control.setImageScaling_forSegment(NSImageScaling::ScaleProportionallyDown, idx);
        }
        let selected = options
            .selected_id
            .as_deref()
            .and_then(|id| ids.iter().position(|i| i == id))
            .unwrap_or(0) as isize;
        control.setSelectedSegment(selected);

        // Wire taps → Tauri event.
        let target = ActionTarget::new(Box::new(move |sender| {
            let idx: isize = unsafe { msg_send![sender, selectedSegment] };
            let ids = ids_for_action.lock().unwrap();
            if let Some(id) = ids.get(idx as usize) {
                let _ = app.emit(TAB_SELECTED_EVENT, TabSelectedPayload { id: id.clone() });
            }
        }));
        attach_target(&control, &target);
        control.sizeToFit();
        set_identifier(&control, &control_id());
        let control_size = control.frame().size;

        let bar_size = NSSize::new(
            control_size.width + BAR_PADDING_X * 2.0,
            control_size.height + BAR_PADDING_Y * 2.0,
        );
        let bounds = content.bounds();
        let bar_origin = NSPoint::new(
            (bounds.size.width - bar_size.width) / 2.0,
            BAR_BOTTOM_MARGIN,
        );

        control.setFrameOrigin(NSPoint::new(BAR_PADDING_X, BAR_PADDING_Y));
        let bar = glass_capsule(mtm, &control, bar_size.height / 2.0);
        if let Some((r, g, b, a)) = options.tint.as_deref().and_then(parse_hex_color) {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a);
            control.setSelectedSegmentBezelColor(Some(&color));
            // Glass capsule tint (macOS 26 NSGlassEffectView only).
            unsafe {
                if bar.respondsToSelector(sel!(setTintColor:)) {
                    // Halve the alpha so the glass stays translucent.
                    let tinted = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a * 0.5);
                    let _: () = msg_send![&*bar, setTintColor: &*tinted];
                }
            }
        }
        bar.setFrame(NSRect::new(bar_origin, bar_size));
        // Flexible left/right/top margins keep the capsule pinned to the
        // bottom center as the window resizes.
        bar.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewMinXMargin
                | NSAutoresizingMaskOptions::ViewMaxXMargin
                | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        set_identifier(&bar, &bar_id());

        // On top of the webview (addSubview appends above siblings).
        content.addSubview(&bar);
        Ok(())
    })
}

pub fn remove<R: Runtime>(
    window: WebviewWindow<R>,
    tab_ids: &Arc<Mutex<Vec<String>>>,
) -> crate::Result<()> {
    tab_ids.lock().unwrap().clear();
    on_main_thread(&window, move |win| {
        let content = content_view(win)?;
        if let Some(bar) = find_subview(&content, &bar_id()) {
            bar.removeFromSuperview();
        }
        Ok(())
    })
}

pub fn set_hidden<R: Runtime>(window: WebviewWindow<R>, hidden: bool) -> crate::Result<()> {
    on_main_thread(&window, move |win| {
        let content = content_view(win)?;
        let bar = find_subview(&content, &bar_id())
            .ok_or_else(|| Error::WindowHandle("tab bar is not configured".into()))?;
        bar.setHidden(hidden);
        Ok(())
    })
}

pub fn select<R: Runtime>(
    window: WebviewWindow<R>,
    tab_ids: &Arc<Mutex<Vec<String>>>,
    id: String,
) -> crate::Result<()> {
    let idx = tab_ids
        .lock()
        .unwrap()
        .iter()
        .position(|i| *i == id)
        .ok_or_else(|| Error::WindowHandle(format!("unknown tab id: {id}")))?
        as isize;
    on_main_thread(&window, move |win| {
        let content = content_view(win)?;
        let control = find_subview(&content, &control_id())
            .ok_or_else(|| Error::WindowHandle("tab bar is not configured".into()))?;
        let _: () = unsafe { msg_send![&*control, setSelectedSegment: idx] };
        Ok(())
    })
}

pub fn insets<R: Runtime>(window: WebviewWindow<R>) -> crate::Result<TabBarInsets> {
    on_main_thread(&window, move |win| {
        let content = content_view(win)?;
        let bottom = match find_subview(&content, &bar_id()) {
            Some(bar) if !bar.isHidden() => bar.frame().size.height + BAR_BOTTOM_MARGIN + 8.0,
            _ => 0.0,
        };
        Ok(TabBarInsets { bottom })
    })
}
