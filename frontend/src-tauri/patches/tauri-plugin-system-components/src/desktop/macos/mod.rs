//! Shared AppKit plumbing: main-thread dispatch, view lookup by identifier,
//! the dynamic NSGlassEffectView capsule, base64 → NSImage decoding, and the
//! generic target/action bridge.

pub mod components;
pub mod tab_bar;
pub mod window_glass;

use std::sync::mpsc;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass};
use objc2_app_kit::NSWindow;
use objc2_app_kit::{
    NSImage, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView,
};
use objc2_foundation::{
    MainThreadMarker, NSData, NSDataBase64DecodingOptions, NSObjectProtocol, NSPoint, NSRect,
    NSSize, NSString,
};
use tauri::{Runtime, WebviewWindow};

use crate::models::GlassSupport;
use crate::Error;

/// Identifier prefix for every view this plugin installs.
pub const ID_PREFIX: &str = "tauri-plugin-system-components.";

pub fn glass_class() -> Option<&'static AnyClass> {
    // Dynamic lookup: NSGlassEffectView only exists in the macOS 26 SDK /
    // runtime; resolving it by name keeps the crate buildable and runnable
    // against older toolchains and systems.
    AnyClass::get(c"NSGlassEffectView")
}

pub fn glass_support() -> GlassSupport {
    let supported = glass_class().is_some();
    GlassSupport {
        supported,
        fallback: !supported,
    }
}

/// Runs `f` on the main thread and waits for its result.
pub fn on_main_thread<R, T, F>(window: &WebviewWindow<R>, f: F) -> crate::Result<T>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&WebviewWindow<R>) -> crate::Result<T> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f(&win));
        })
        .map_err(|e| Error::WindowHandle(e.to_string()))?;
    rx.recv()
        .map_err(|e| Error::WindowHandle(format!("main thread dropped result: {e}")))?
}

pub fn content_view<R: Runtime>(window: &WebviewWindow<R>) -> crate::Result<Retained<NSView>> {
    let ptr = window
        .ns_window()
        .map_err(|e| Error::WindowHandle(e.to_string()))?;
    let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    ns_window
        .contentView()
        .ok_or_else(|| Error::WindowHandle("window has no contentView".into()))
}

pub fn find_subview(root: &NSView, identifier: &str) -> Option<Retained<NSView>> {
    for sub in root.subviews().iter() {
        let id: Option<Retained<NSString>> = unsafe { msg_send![&*sub, identifier] };
        if id.is_some_and(|id| id.to_string() == identifier) {
            return Some(sub);
        }
        if let Some(found) = find_subview(&sub, identifier) {
            return Some(found);
        }
    }
    None
}

pub fn set_identifier(view: &NSView, identifier: &str) {
    let ident = NSString::from_str(identifier);
    let _: () = unsafe { msg_send![view, setIdentifier: &*ident] };
}

/// The WKWebView inside the window's content view — the first direct
/// subview that isn't one of ours.
pub fn find_webview(content: &NSView) -> Option<Retained<NSView>> {
    for sub in content.subviews().iter() {
        let id: Option<Retained<NSString>> = unsafe { msg_send![&*sub, identifier] };
        if !id.is_some_and(|id| id.to_string().starts_with(ID_PREFIX)) {
            return Some(sub);
        }
    }
    None
}

pub fn parse_hex_color(hex: &str) -> Option<(f64, f64, f64, f64)> {
    let hex = hex.trim_start_matches('#');
    let (r, g, b, a) = match hex.len() {
        6 => (&hex[0..2], &hex[2..4], &hex[4..6], "ff"),
        8 => (&hex[0..2], &hex[2..4], &hex[4..6], &hex[6..8]),
        _ => return None,
    };
    let p = |s: &str| u8::from_str_radix(s, 16).ok().map(|v| v as f64 / 255.0);
    Some((p(r)?, p(g)?, p(b)?, p(a)?))
}

/// Decodes a base64 string (raw or `data:` URL) into an NSImage.
pub fn image_from_base64(input: &str) -> Option<Retained<NSImage>> {
    let b64 = match input.split_once(',') {
        // data:image/png;base64,<payload>
        Some((head, payload)) if head.starts_with("data:") => payload,
        _ => input,
    };
    let ns_b64 = NSString::from_str(b64.trim());
    let data = NSData::initWithBase64EncodedString_options(
        NSData::alloc(),
        &ns_b64,
        NSDataBase64DecodingOptions::IgnoreUnknownCharacters,
    )?;
    NSImage::initWithData(NSImage::alloc(), &data)
}

/// Renders `image` clipped to a circle at `diameter` points.
pub fn circular_image(image: &NSImage, diameter: f64) -> Retained<NSImage> {
    unsafe {
        let size = NSSize::new(diameter, diameter);
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
        let out: Retained<NSImage> = msg_send![NSImage::alloc(), initWithSize: size];
        let _: () = msg_send![&*out, lockFocus];
        let path_cls = AnyClass::get(c"NSBezierPath").expect("NSBezierPath");
        let path: Retained<AnyObject> = msg_send![path_cls, bezierPathWithOvalInRect: rect];
        let _: () = msg_send![&*path, addClip];
        // NSCompositingOperationSourceOver = 2
        let _: () = msg_send![
            image,
            drawInRect: rect,
            fromRect: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)),
            operation: 2usize,
            fraction: 1.0f64
        ];
        let _: () = msg_send![&*out, unlockFocus];
        out
    }
}

/// A rounded "capsule" container: real NSGlassEffectView on macOS 26, blur
/// fallback otherwise. The returned view has `content` installed inside it;
/// size the capsule yourself and place `content` at its padded origin first.
pub fn glass_capsule(
    mtm: MainThreadMarker,
    content: &NSView,
    corner_radius: f64,
) -> Retained<NSView> {
    match glass_class() {
        Some(cls) => {
            let glass: Retained<NSView> = unsafe { msg_send![cls, new] };
            unsafe {
                if glass.respondsToSelector(sel!(setCornerRadius:)) {
                    let _: () = msg_send![&*glass, setCornerRadius: corner_radius];
                }
                // Wrapper so the content sits padded inside the glass.
                let wrapper = NSView::new(mtm);
                wrapper.addSubview(content);
                if glass.respondsToSelector(sel!(setContentView:)) {
                    let _: () = msg_send![&*glass, setContentView: &*wrapper];
                } else {
                    glass.addSubview(&wrapper);
                }
            }
            glass
        }
        None => {
            let effect = NSVisualEffectView::new(mtm);
            effect.setMaterial(NSVisualEffectMaterial::HUDWindow);
            effect.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
            effect.setState(NSVisualEffectState::Active);
            unsafe {
                effect.setWantsLayer(true);
                let layer: *mut AnyObject = msg_send![&*effect, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setCornerRadius: corner_radius];
                    let _: () = msg_send![layer, setMasksToBounds: true];
                }
            }
            effect.addSubview(content);
            Retained::into_super(effect)
        }
    }
}

// MARK: generic target/action bridge

pub struct ActionTargetIvars {
    on_action: Box<dyn Fn(&AnyObject)>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the class is only
    // used as an NSControl target on the main thread.
    #[unsafe(super(NSObject))]
    #[name = "TauriSystemComponentsActionTarget"]
    #[ivars = ActionTargetIvars]
    pub struct ActionTarget;

    impl ActionTarget {
        #[unsafe(method(performAction:))]
        fn perform_action(&self, sender: &AnyObject) {
            (self.ivars().on_action)(sender);
        }
    }
);

impl ActionTarget {
    pub fn new(on_action: Box<dyn Fn(&AnyObject)>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ActionTargetIvars { on_action });
        unsafe { msg_send![super(this), init] }
    }
}

/// Key for associating an ActionTarget with its control: NSControl.target
/// is weak, so the association is what keeps the target alive.
static ACTION_TARGET_ASSOC_KEY: u8 = 0;

/// Wires `target` as `control`'s target/action and retains it via an
/// associated object.
pub fn attach_target(control: &NSView, target: &Retained<ActionTarget>) {
    unsafe {
        let _: () = msg_send![control, setTarget: &**target];
        let _: () = msg_send![control, setAction: sel!(performAction:)];
        objc2::ffi::objc_setAssociatedObject(
            control as *const NSView as *mut _,
            &ACTION_TARGET_ASSOC_KEY as *const u8 as *const _,
            Retained::as_ptr(target) as *mut AnyObject,
            objc2::ffi::OBJC_ASSOCIATION_RETAIN,
        );
    }
}
