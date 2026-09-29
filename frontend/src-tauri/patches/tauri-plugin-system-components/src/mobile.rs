use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, plugin::PluginHandle, AppHandle, Runtime, WebviewWindow};

use crate::models::*;
use crate::Error;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_system_components);

/// Initializes the Swift (iOS) or Kotlin (Android) plugin class registered by
/// the host app.
///
/// iOS implements the full surface (tab bar, components, sheets). Android
/// implements **sheets only** — the tab-bar / component commands still reject
/// with `Unsupported`, so the web app keeps its HTML pill there and only the
/// native bottom sheet is used.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    #[allow(unused_variables)] api: PluginApi<R, C>,
) -> crate::Result<SystemComponents<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_system_components)?;
    #[cfg(target_os = "android")]
    let handle =
        api.register_android_plugin("com.sosweetham.systemcomponents", "SystemComponentsPlugin")?;
    Ok(SystemComponents { handle })
}

/// Access to the system-components APIs on mobile.
pub struct SystemComponents<R: Runtime> {
    handle: PluginHandle<R>,
}

/// Forwards a command to the native plugin on every mobile platform (iOS +
/// Android). Used for the sheet commands, which both platforms implement.
macro_rules! mobile_command {
    ($self:ident, $name:literal, $payload:expr) => {{
        $self
            .handle
            .run_mobile_plugin($name, $payload)
            .map_err(Into::into)
    }};
}

/// Forwards a command to the Swift plugin on iOS; rejects on Android (which has
/// no native tab bar / floating components). Swift method names are camelCase to
/// match the `@objc` selectors.
macro_rules! ios_command {
    ($self:ident, $name:literal, $payload:expr) => {{
        #[cfg(target_os = "ios")]
        {
            $self
                .handle
                .run_mobile_plugin($name, $payload)
                .map_err(Into::into)
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = $payload;
            Err(Error::Unsupported("the native tab bar is iOS-only"))
        }
    }};
}

impl<R: Runtime> SystemComponents<R> {
    pub fn configure_tab_bar(&self, options: ConfigureTabBarOptions) -> crate::Result<()> {
        ios_command!(self, "configureTabBar", options)
    }

    pub fn remove_tab_bar(&self) -> crate::Result<()> {
        ios_command!(self, "removeTabBar", ())
    }

    pub fn show_tab_bar(&self) -> crate::Result<()> {
        ios_command!(self, "showTabBar", ())
    }

    pub fn hide_tab_bar(&self) -> crate::Result<()> {
        ios_command!(self, "hideTabBar", ())
    }

    pub fn select_tab(&self, options: SelectTabOptions) -> crate::Result<()> {
        ios_command!(self, "selectTab", options)
    }

    pub fn set_badge(&self, options: SetBadgeOptions) -> crate::Result<()> {
        ios_command!(self, "setBadge", options)
    }

    pub fn get_tab_bar_insets(&self) -> crate::Result<TabBarInsets> {
        ios_command!(self, "getTabBarInsets", ())
    }

    // Sheets are implemented on BOTH iOS (UISheetPresentationController) and
    // Android (Material BottomSheetDialog), so they run on every mobile target.
    pub fn present_sheet(&self, options: PresentSheetOptions) -> crate::Result<()> {
        mobile_command!(self, "presentSheet", options)
    }

    pub fn dismiss_sheet(&self, options: DismissSheetOptions) -> crate::Result<()> {
        mobile_command!(self, "dismissSheet", options)
    }

    pub fn create_component(&self, options: CreateComponentOptions) -> crate::Result<()> {
        ios_command!(self, "createComponent", options)
    }

    pub fn update_component(&self, options: UpdateComponentOptions) -> crate::Result<()> {
        ios_command!(self, "updateComponent", options)
    }

    pub fn update_components(&self, options: UpdateComponentsOptions) -> crate::Result<()> {
        ios_command!(self, "updateComponents", options)
    }

    pub fn remove_component(&self, options: RemoveComponentOptions) -> crate::Result<()> {
        ios_command!(self, "removeComponent", options)
    }

    // `set_window_glass` / `clear_window_glass` are a macOS (desktop) concept and
    // never reach native mobile. `is_glass_supported`, though, is meaningful on
    // iOS: it reports whether the native Liquid Glass tab bar / components render
    // as real glass (iOS 26 SDK + iOS 26 runtime) or fall back to a material blur.
    // Callers use it to decide between the native glass bar and the HTML pill —
    // the WebKit user-agent freezes the OS version, so it can't be used for this.

    pub fn is_glass_supported(&self) -> crate::Result<GlassSupport> {
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin("isGlassSupported", ())
                .map_err(Into::into)
        }
        // Android has no native glass bar; keep the safe default.
        #[cfg(not(target_os = "ios"))]
        {
            Ok(GlassSupport {
                supported: false,
                fallback: false,
            })
        }
    }

    pub fn set_window_glass(
        &self,
        _window: WebviewWindow<R>,
        _options: WindowGlassOptions,
    ) -> crate::Result<()> {
        Err(Error::Unsupported("window glass is macOS-only"))
    }

    pub fn clear_window_glass(&self, _window: WebviewWindow<R>) -> crate::Result<()> {
        Err(Error::Unsupported("window glass is macOS-only"))
    }
}
