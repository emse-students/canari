use tauri::{command, AppHandle, Manager, Runtime, WebviewWindow};

use crate::models::*;
use crate::Result;
use crate::SystemComponentsExt;

#[command]
pub(crate) async fn configure_tab_bar<R: Runtime>(
    app: AppHandle<R>,
    options: ConfigureTabBarOptions,
) -> Result<()> {
    app.system_components().configure_tab_bar(options)
}

#[command]
pub(crate) async fn remove_tab_bar<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.system_components().remove_tab_bar()
}

#[command]
pub(crate) async fn show_tab_bar<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.system_components().show_tab_bar()
}

#[command]
pub(crate) async fn hide_tab_bar<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.system_components().hide_tab_bar()
}

#[command]
pub(crate) async fn select_tab<R: Runtime>(
    app: AppHandle<R>,
    options: SelectTabOptions,
) -> Result<()> {
    app.system_components().select_tab(options)
}

#[command]
pub(crate) async fn set_badge<R: Runtime>(
    app: AppHandle<R>,
    options: SetBadgeOptions,
) -> Result<()> {
    app.system_components().set_badge(options)
}

#[command]
pub(crate) async fn get_tab_bar_insets<R: Runtime>(app: AppHandle<R>) -> Result<TabBarInsets> {
    app.system_components().get_tab_bar_insets()
}

#[command]
pub(crate) async fn present_sheet<R: Runtime>(
    app: AppHandle<R>,
    options: PresentSheetOptions,
) -> Result<()> {
    app.system_components().present_sheet(options)
}

#[command]
pub(crate) async fn dismiss_sheet<R: Runtime>(
    app: AppHandle<R>,
    options: DismissSheetOptions,
) -> Result<()> {
    app.system_components().dismiss_sheet(options)
}

#[command]
pub(crate) async fn create_component<R: Runtime>(
    app: AppHandle<R>,
    options: CreateComponentOptions,
) -> Result<()> {
    app.system_components().create_component(options)
}

#[command]
pub(crate) async fn update_component<R: Runtime>(
    app: AppHandle<R>,
    options: UpdateComponentOptions,
) -> Result<()> {
    app.system_components().update_component(options)
}

#[command]
pub(crate) async fn update_components<R: Runtime>(
    app: AppHandle<R>,
    options: UpdateComponentsOptions,
) -> Result<()> {
    app.system_components().update_components(options)
}

#[command]
pub(crate) async fn remove_component<R: Runtime>(
    app: AppHandle<R>,
    options: RemoveComponentOptions,
) -> Result<()> {
    app.system_components().remove_component(options)
}

#[command]
pub(crate) async fn is_glass_supported<R: Runtime>(app: AppHandle<R>) -> Result<GlassSupport> {
    app.system_components().is_glass_supported()
}

#[command]
pub(crate) async fn set_window_glass<R: Runtime>(
    window: WebviewWindow<R>,
    options: Option<WindowGlassOptions>,
) -> Result<()> {
    window
        .app_handle()
        .system_components()
        .set_window_glass(window.clone(), options.unwrap_or_default())
}

#[command]
pub(crate) async fn clear_window_glass<R: Runtime>(window: WebviewWindow<R>) -> Result<()> {
    window
        .app_handle()
        .system_components()
        .clear_window_glass(window.clone())
}
