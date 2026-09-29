//! Desktop implementations.
//!
//! macOS is the real implementation (AppKit, in [`macos`]); Windows/Linux
//! reject every command with `Unsupported`, which the JS side documents as
//! the signal to render HTML fallbacks.

#[cfg(target_os = "macos")]
mod macos;

use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime, WebviewWindow};

use crate::models::*;
use crate::Error;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<SystemComponents<R>> {
    Ok(SystemComponents {
        app: app.clone(),
        tab_ids: Arc::new(Mutex::new(Vec::new())),
    })
}

/// Access to the system-components APIs on desktop.
pub struct SystemComponents<R: Runtime> {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    app: AppHandle<R>,
    /// Tab ids by segment index — shared with the AppKit action callback.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    tab_ids: Arc<Mutex<Vec<String>>>,
}

/// Routes a call to the macOS implementation, or rejects elsewhere.
macro_rules! macos_only {
    ($body:expr, $msg:literal) => {{
        #[cfg(target_os = "macos")]
        {
            $body
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(Error::Unsupported($msg))
        }
    }};
}

impl<R: Runtime> SystemComponents<R> {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn window(&self) -> crate::Result<WebviewWindow<R>> {
        self.app
            .get_webview_window("main")
            .or_else(|| self.app.webview_windows().into_values().next())
            .ok_or_else(|| Error::WindowHandle("no webview window".into()))
    }

    pub fn configure_tab_bar(&self, options: ConfigureTabBarOptions) -> crate::Result<()> {
        let _ = &options;
        macos_only!(
            macos::tab_bar::configure(self.window()?, self.app.clone(), &self.tab_ids, options),
            "the native tab bar is iOS/macOS-only"
        )
    }

    pub fn remove_tab_bar(&self) -> crate::Result<()> {
        macos_only!(
            macos::tab_bar::remove(self.window()?, &self.tab_ids),
            "the native tab bar is iOS/macOS-only"
        )
    }

    pub fn show_tab_bar(&self) -> crate::Result<()> {
        macos_only!(
            macos::tab_bar::set_hidden(self.window()?, false),
            "the native tab bar is iOS/macOS-only"
        )
    }

    pub fn hide_tab_bar(&self) -> crate::Result<()> {
        macos_only!(
            macos::tab_bar::set_hidden(self.window()?, true),
            "the native tab bar is iOS/macOS-only"
        )
    }

    pub fn select_tab(&self, options: SelectTabOptions) -> crate::Result<()> {
        let _ = &options;
        macos_only!(
            macos::tab_bar::select(self.window()?, &self.tab_ids, options.id),
            "the native tab bar is iOS/macOS-only"
        )
    }

    pub fn set_badge(&self, _options: SetBadgeOptions) -> crate::Result<()> {
        // NSSegmentedControl has no badge concept; keep badges iOS-only.
        Err(Error::Unsupported("tab badges are iOS-only"))
    }

    pub fn get_tab_bar_insets(&self) -> crate::Result<TabBarInsets> {
        macos_only!(
            macos::tab_bar::insets(self.window()?),
            "the native tab bar is iOS/macOS-only"
        )
    }

    pub fn present_sheet(&self, _options: PresentSheetOptions) -> crate::Result<()> {
        Err(crate::Error::Unsupported("native sheets are iOS-only"))
    }

    pub fn dismiss_sheet(&self, _options: DismissSheetOptions) -> crate::Result<()> {
        Err(crate::Error::Unsupported("native sheets are iOS-only"))
    }

    pub fn create_component(&self, options: CreateComponentOptions) -> crate::Result<()> {
        let _ = &options;
        macos_only!(
            macos::components::create(self.window()?, self.app.clone(), options),
            "native components are iOS/macOS-only"
        )
    }

    pub fn update_component(&self, options: UpdateComponentOptions) -> crate::Result<()> {
        let _ = &options;
        macos_only!(
            macos::components::update(self.window()?, options),
            "native components are iOS/macOS-only"
        )
    }

    pub fn update_components(&self, options: UpdateComponentsOptions) -> crate::Result<()> {
        let _ = &options;
        macos_only!(
            macos::components::update_batch(self.window()?, options),
            "native components are iOS/macOS-only"
        )
    }

    pub fn remove_component(&self, options: RemoveComponentOptions) -> crate::Result<()> {
        let _ = &options;
        macos_only!(
            macos::components::remove(self.window()?, options.id),
            "native components are iOS/macOS-only"
        )
    }

    pub fn is_glass_supported(&self) -> crate::Result<GlassSupport> {
        #[cfg(target_os = "macos")]
        {
            Ok(macos::glass_support())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(GlassSupport {
                supported: false,
                fallback: false,
            })
        }
    }

    pub fn set_window_glass(
        &self,
        window: WebviewWindow<R>,
        options: WindowGlassOptions,
    ) -> crate::Result<()> {
        let _ = (&window, &options);
        macos_only!(
            macos::window_glass::set(window, options),
            "window glass is macOS-only"
        )
    }

    pub fn clear_window_glass(&self, window: WebviewWindow<R>) -> crate::Result<()> {
        let _ = &window;
        macos_only!(
            macos::window_glass::clear(window),
            "window glass is macOS-only"
        )
    }
}
