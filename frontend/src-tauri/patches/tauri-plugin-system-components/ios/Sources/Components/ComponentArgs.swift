//
//  ComponentArgs.swift
//  tauri-plugin-system-components
//
//  Decodable argument models shared by the component system. Kept separate
//  from any one component so each component file owns only its own rendering.
//

import Foundation

/// Per-kind properties. All optional; a component reads only what it needs.
class ComponentPropsArgs: Decodable {
    let label: String?
    let on: Bool?
    let value: Double?
    let min: Double?
    let max: Double?
    let sfSymbol: String?
    let image: String?
    let circular: Bool?
    let glass: Bool?
    let prominent: Bool?
    let tint: String?
    let width: Double?
    let height: Double?
    /// Top-left position in CSS points, for `absolute` placement.
    let x: Double?
    let y: Double?
    /// Corner radius for `glass` panels.
    let cornerRadius: Double?

    // CANARI PATCH: the conversation's native glass chrome (see `ComponentProps` in models.rs).
    /// A button's entries: the button opens this menu on a tap and reports the chosen `id`.
    let menu: [MenuItemArgs]?
    /// Hide the mounted view without removing it.
    let hidden: Bool?
    /// VoiceOver's name for an icon-only control.
    let accessibilityLabel: String?
    /// Hex colour for a button's title and template glyphs (unset: the system tint).
    let foreground: String?
    /// Side, in points, of a button's bitmap image (default 20).
    let imageSide: Double?
    /// Point size of a button's title: bold, one line, truncated at the tail.
    let titleSize: Double?

    // `container` layout.
    let axis: String?
    let align: String?
    let spacing: Double?
    let inset: Double?

    // `tabBar`.
    let items: [TabItemArgs]?
    let selectedId: String?
    /// How the bar lays out its items: `"fill"` spreads them across the full
    /// width, `"centered"` hugs them in the middle, `"automatic"` (default) lets
    /// the system decide. Maps to `UITabBar.ItemPositioning`.
    let itemPositioning: String?
}

/// CANARI PATCH: one entry of a button's `menu`.
class MenuItemArgs: Decodable {
    let id: String
    let title: String
    /// Glyph drawn as a template, so the menu colours it like its text.
    let image: String?
    /// A toggle's state (checkmark); nil for an entry that is not a toggle.
    let on: Bool?
}

class CreateComponentArgs: Decodable {
    let id: String
    let kind: String
    let props: ComponentPropsArgs?
    let anchor: String?
    let dx: Double?
    let dy: Double?
    /// Insert below the (transparent) webview so DOM content renders sharp
    /// on top while the view shows through unpainted page regions.
    let below: Bool?
    /// Child components, for `kind == "container"` (recursive).
    let children: [CreateComponentArgs]?
}

class UpdateComponentArgs: Decodable {
    let id: String
    let props: ComponentPropsArgs
}

class UpdateComponentsArgs: Decodable {
    let components: [UpdateComponentArgs]
}

class RemoveComponentArgs: Decodable {
    let id: String
}
