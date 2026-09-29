use serde::{Deserialize, Serialize};

/// A single tab in the native bottom tab bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabItem {
    /// Stable identifier reported back in `tabSelected` events.
    pub id: String,
    /// User-visible label under the icon.
    pub title: String,
    /// SF Symbol name (e.g. "house.fill"). Must exist on the device's OS
    /// version; unknown names render a label-only item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sf_symbol: Option<String>,
    /// Bitmap icon as base64 (raw or `data:` URL) — e.g. a user avatar.
    /// Takes precedence over `sf_symbol`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Clip the bitmap `image` to a circle (avatar style).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circular: Option<bool>,
    /// Optional badge text (e.g. "3"). `None` shows no badge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

/// A standalone account button floated beside the bar (Apple Music
/// search-button style). `image` (base64 / data URL) wins over `sf_symbol`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessoryItem {
    /// Stable id reported back in `tabSelected` events when tapped.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sf_symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureTabBarOptions {
    pub items: Vec<TabItem>,
    /// Tab to select initially; defaults to the first item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_id: Option<String>,
    /// Hex accent color `#RRGGBB[AA]` — selected-item color on iOS, glass
    /// capsule tint + selected segment color on macOS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<String>,
    /// Optional circular account button beside the bar (iOS). Ignored on macOS,
    /// where the account button is an overlay component instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessory: Option<AccessoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectTabOptions {
    pub id: String,
}

/// An option for a `select` sheet row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetOption {
    pub value: String,
    pub label: String,
}

/// One row in a native sheet (iOS), rendered natively. Tappable rows report
/// the `id` via `sheetRow`; form rows report via `sheetField` / `sheetSubmit`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRow {
    pub id: String,
    /// `header | action | text | textfield | toggle | datetime | select | submit`.
    /// Defaults to `action` (or `header` when `header == true`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Bitmap (base64 / data URL) — wins over `sf_symbol`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sf_symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    /// Back-compat: same as `kind: "header"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<bool>,
    /// Initial value: `textfield` text / `datetime` ISO-8601 / `select` value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Initial `toggle` state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// `select` options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SheetOption>>,
}

/// Present a native Liquid Glass bottom sheet (iOS) with natively-rendered rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentSheetOptions {
    /// Stable id reported in `sheetRow` / `sheetDismissed` events.
    pub id: String,
    /// Hex accent `#RRGGBB[AA]` for badges / selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<String>,
    pub rows: Vec<SheetRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissSheetOptions {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBadgeOptions {
    pub id: String,
    /// `None` clears the badge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// Space the web content should reserve so the floating bar doesn't cover it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBarInsets {
    /// Bar height + bottom safe area, in CSS points.
    pub bottom: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGlassOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
    /// Hex color, `#RRGGBB` or `#RRGGBBAA`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint_color: Option<String>,
}

/// Payload of the `system-components://tab-selected` event emitted on macOS
/// (iOS delivers the same shape through the plugin event channel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSelectedPayload {
    pub id: String,
}

/// Kind of native overlay component.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    /// UISwitch / NSSwitch — emits `change` with `on`.
    Switch,
    /// UIButton (glass configuration on iOS 26) / NSButton — emits `click`.
    Button,
    /// UISlider / NSSlider — emits `change` with `value`.
    Slider,
    /// UIProgressView / NSProgressIndicator — display only.
    Progress,
    /// UIImageView / NSImageView — display only (avatars, thumbnails).
    Image,
    /// A bare glass panel (UIGlassEffect / NSGlassEffectView, blur
    /// fallback) — pair with `below: true` + `absolute` placement to back
    /// DOM elements with real glass (see `attachGlassCard` in the JS API).
    Glass,
    /// A layout container (UIStackView / NSStackView) that arranges its
    /// `children` along `props.axis` — the building block consumers compose
    /// their own nav (bar or sidebar) from. Imposes no specific layout.
    Container,
    /// The system tab bar (UITabBar / NSSegmentedControl) as a composable
    /// component: `props.items` are the tabs; selection arrives as a
    /// `select` component event whose `detail` is the chosen tab id.
    TabBar,
}

/// Where a component is pinned, relative to the window/safe area.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentAnchor {
    TopLeading,
    #[default]
    TopTrailing,
    BottomLeading,
    BottomTrailing,
    Center,
    /// Centered against one edge of the safe area — for docking a nav
    /// container as a bottom bar (`Bottom`) or a side rail (`Leading` /
    /// `Trailing`). `props.inset` sets the gap from that edge.
    Bottom,
    Top,
    Leading,
    Trailing,
    /// Position by `props.x`/`props.y` (CSS points from the top-left) —
    /// for views synced to DOM element rects.
    Absolute,
    /// Cover the whole window, resizing with it (e.g. background images).
    Fill,
}

/// Per-kind properties. All optional; irrelevant fields are ignored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ComponentProps {
    /// Text: button title, switch/slider accessibility label.
    pub label: Option<String>,
    /// Switch state.
    pub on: Option<bool>,
    /// Slider/progress value (progress is 0..1).
    pub value: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// SF Symbol for buttons.
    pub sf_symbol: Option<String>,
    /// Bitmap as base64 (raw or `data:` URL) — image components, button icons.
    pub image: Option<String>,
    /// Clip the bitmap to a circle (avatar style).
    pub circular: Option<bool>,
    /// Wrap the control in a floating glass capsule.
    pub glass: Option<bool>,
    /// Prominent (tinted) button style.
    pub prominent: Option<bool>,
    /// Hex tint color `#RRGGBB[AA]`.
    pub tint: Option<String>,
    /// Explicit size in points (defaults to the control's natural size).
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// Top-left position in CSS points, for `absolute` placement. Also
    /// accepted by `update_component` to move/resize (DOM scroll sync).
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// Corner radius for `glass` panels.
    pub corner_radius: Option<f64>,

    // ── `container` layout ───────────────────────────────────────────────
    /// `horizontal` (a bar) or `vertical` (a sidebar). Default `horizontal`.
    pub axis: Option<String>,
    /// Cross-axis alignment of children: `center` (default) | `leading` |
    /// `trailing` | `fill`.
    pub align: Option<String>,
    /// Gap between children, in points.
    pub spacing: Option<f64>,
    /// Gap from the anchored edge of the safe area, in points.
    pub inset: Option<f64>,

    // ── `tabBar` ─────────────────────────────────────────────────────────
    /// The tabs, when `kind == tabBar`.
    pub items: Option<Vec<TabItem>>,
    /// Initially-selected tab id (defaults to the first).
    pub selected_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateComponentOptions {
    /// Stable identifier, reported back in component events.
    pub id: String,
    pub kind: ComponentKind,
    #[serde(default)]
    pub props: ComponentProps,
    #[serde(default)]
    pub anchor: ComponentAnchor,
    /// Offset from the anchor, in points (dx grows inward/right, dy inward/down).
    #[serde(default)]
    pub dx: f64,
    #[serde(default)]
    pub dy: f64,
    /// Insert the view *below* the webview instead of above it. The webview
    /// is made transparent so unpainted DOM regions reveal the view — this
    /// is how glass panels sit behind DOM content (text stays sharp on
    /// top while the glass refracts what's behind the page).
    #[serde(default)]
    pub below: bool,
    /// Child components, when `kind == container` — arranged along
    /// `props.axis`. Each child is a full component spec (so containers may
    /// nest, and a `tabBar` or `button` can live inside).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<CreateComponentOptions>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateComponentOptions {
    pub id: String,
    pub props: ComponentProps,
}

/// Batched form of [`UpdateComponentOptions`] — one IPC round trip and one
/// (animation-disabled) native transaction for all geometry updates of a
/// frame. Used by the DOM scroll-sync path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateComponentsOptions {
    pub components: Vec<UpdateComponentOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveComponentOptions {
    pub id: String,
}

/// Payload of the `system-components://component-event` event on macOS (iOS
/// delivers the same shape through the plugin event channel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEventPayload {
    pub id: String,
    /// `click` (button), `change` (switch/slider), or `select` (tab bar).
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// String payload — the chosen tab id for a `tabBar` `select` event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassSupport {
    /// `true` when the real `NSGlassEffectView` (macOS 26+) is available.
    pub supported: bool,
    /// `true` when `set_window_glass` would use the `NSVisualEffectView`
    /// blur fallback instead of real glass.
    pub fallback: bool,
}
