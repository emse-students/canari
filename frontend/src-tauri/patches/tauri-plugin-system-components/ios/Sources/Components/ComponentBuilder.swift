//
//  ComponentBuilder.swift
//  tauri-plugin-system-components
//
//  The contract every component file implements, the shared services it may
//  need (`ComponentContext`), and the registry that maps a kind string to its
//  builder. Adding a component = one new file + one line in the registry.
//

import UIKit
import WebKit

/// Shared services a component may use while building itself.
struct ComponentContext {
    /// Report an interaction: (id, event, on?, value?, detail?).
    let emit: (String, String, Bool?, Double?, String?) -> Void
    /// The app's webview (for `below` / DOM-synced placement). May be nil.
    weak var webView: WKWebView?
    /// Recursively build a child control (used by `container`).
    let makeChild: (CreateComponentArgs) -> UIView?
}

/// One native component kind, isolated to its own file (single responsibility).
protocol ComponentBuilder {
    /// Build the bare control. Anchoring + optional glass-wrapping are the
    /// overlay controller's job, not the component's.
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView?
    /// Apply a live property update to an existing control. Default: no-op.
    static func update(_ control: UIView, _ props: ComponentPropsArgs)
}

extension ComponentBuilder {
    static func update(_ control: UIView, _ props: ComponentPropsArgs) {}
}

/// Maps a kind string to its builder — the single place that knows the full
/// component set.
enum ComponentRegistry {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        switch args.kind {
        case "switch": return SwitchComponent.make(args, ctx)
        case "button": return ButtonComponent.make(args, ctx)
        case "slider": return SliderComponent.make(args, ctx)
        case "progress": return ProgressComponent.make(args, ctx)
        case "image": return ImageComponent.make(args, ctx)
        case "glass": return GlassComponent.make(args, ctx)
        case "container": return ContainerComponent.make(args, ctx)
        case "tabBar": return TabBarComponent.make(args, ctx)
        default: return nil
        }
    }

    static func update(_ control: UIView, kind: String, props: ComponentPropsArgs) {
        switch kind {
        case "switch": SwitchComponent.update(control, props)
        case "button": ButtonComponent.update(control, props)
        case "slider": SliderComponent.update(control, props)
        case "progress": ProgressComponent.update(control, props)
        case "image": ImageComponent.update(control, props)
        case "tabBar": TabBarComponent.update(control, props)
        default: break
        }
    }
}
