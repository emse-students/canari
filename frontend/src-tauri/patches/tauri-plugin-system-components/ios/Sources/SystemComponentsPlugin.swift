//
//  SystemComponentsPlugin.swift
//  tauri-plugin-system-components
//
//  Mounts a native UITabBar (Liquid Glass on iOS 26) over the Tauri webview
//  and forwards tab selection to JS via the plugin event channel
//  (`addPluginListener('system-components', 'tabSelected', …)`).
//
//  Commands arrive on Tauri's ipc queue; all UIKit work hops to the main
//  queue (same pattern as the official plugins).
//

import Foundation
import Tauri
import UIKit
import WebKit

class TabItemArgs: Decodable {
    let id: String
    let title: String
    let sfSymbol: String?
    /// Bitmap icon as base64 (raw or data: URL) — e.g. a user avatar.
    /// Takes precedence over sfSymbol.
    let image: String?
    /// Clip the bitmap to a circle (avatar style).
    let circular: Bool?
    let badge: String?
    /// CANARI PATCH: render a bitmap icon as a TEMPLATE, so the bar tints it -
    /// the selected tab in the accent, the others grey - exactly like an SF
    /// Symbol. Upstream draws every bitmap `.alwaysOriginal` (its use is avatars),
    /// which leaves an app's own glyphs untinted and the selection invisible.
    let template: Bool?
}

/// The standalone account button beside the bar (Apple Music search-button
/// style). `image` (base64 / data URL) takes precedence over `sfSymbol`.
class AccessoryArgs: Decodable {
    let id: String
    let sfSymbol: String?
    let image: String?
}

class ConfigureTabBarArgs: Decodable {
    let items: [TabItemArgs]
    let selectedId: String?
    /// Hex accent color — applied to the selected item via the bar appearance.
    let tint: String?
    /// Optional circular account button floated beside the bar.
    let accessory: AccessoryArgs?
}

class SelectTabArgs: Decodable {
    let id: String
}

class SetBadgeArgs: Decodable {
    let id: String
    let value: String?
}

class SheetOptionArgs: Decodable {
    let value: String
    let label: String
}

class SheetRowArgs: Decodable {
    let id: String
    /// header | action | text | textfield | toggle | datetime | select | submit.
    /// Defaults to `action` (or `header` when `header == true`, for back-compat).
    let kind: String?
    let label: String
    let detail: String?
    /// Bitmap (base64 / data URL) — e.g. the account avatar. Wins over `sfSymbol`.
    let image: String?
    let sfSymbol: String?
    let badge: String?
    let destructive: Bool?
    /// Back-compat: `header: true` is the same as `kind: "header"`.
    let header: Bool?
    // Form fields:
    let value: String?
    let on: Bool?
    let placeholder: String?
    let options: [SheetOptionArgs]?
}

class PresentSheetArgs: Decodable {
    let id: String
    let tint: String?
    let rows: [SheetRowArgs]
}

class DismissSheetArgs: Decodable {
    let id: String
}

class SystemComponentsPlugin: Plugin {
    private var overlay: TabBarOverlayController?
    private var componentsOverlay: ComponentsOverlayController?
    private var webView: WKWebView?
    private var sheets: [String: SheetController] = [:]
    /// Restores the layout viewport WebKit shrinks for the input accessory bar
    /// and then forgets to give back. See KeyboardViewportGuard.
    private var keyboardGuard: KeyboardViewportGuard?

    @objc public override func load(webview: WKWebView) {
        self.webView = webview
        self.keyboardGuard = KeyboardViewportGuard(webView: webview)
    }

    @objc public func configureTabBar(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ConfigureTabBarArgs.self)
        guard !args.items.isEmpty else {
            invoke.reject("configureTabBar requires at least one item")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let host = self.manager.viewController else {
                invoke.reject("host view controller unavailable")
                return
            }
            // Idempotent: reconfiguring updates the mounted bar in place.
            let overlay = self.overlay ?? self.mount(on: host)
            overlay.apply(items: args.items, selectedId: args.selectedId)
            overlay.applyTint(args.tint.flatMap(ColorUtil.from(hex:)))
            if let acc = args.accessory {
                // Avatar aspect-filled to a square; the round button clips it.
                let image = acc.image.flatMap(ImageUtil.decode).map {
                    ImageUtil.icon($0, side: 50, circular: false)
                }
                overlay.setAccessory(id: acc.id, image: image, sfSymbol: acc.sfSymbol)
            } else {
                overlay.setAccessory(id: nil, image: nil, sfSymbol: nil)
            }
            invoke.resolve()
        }
    }

    @objc public func removeTabBar(_ invoke: Invoke) {
        DispatchQueue.main.async { [weak self] in
            if let overlay = self?.overlay {
                overlay.willMove(toParent: nil)
                overlay.view.removeFromSuperview()
                overlay.removeFromParent()
                self?.overlay = nil
            }
            invoke.resolve()
        }
    }

    @objc public func showTabBar(_ invoke: Invoke) {
        setHidden(false, invoke)
    }

    @objc public func hideTabBar(_ invoke: Invoke) {
        setHidden(true, invoke)
    }

    @objc public func selectTab(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SelectTabArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let overlay = self?.overlay else {
                invoke.reject("tab bar is not configured")
                return
            }
            if overlay.select(id: args.id) {
                invoke.resolve()
            } else {
                invoke.reject("unknown tab id: \(args.id)")
            }
        }
    }

    @objc public func setBadge(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetBadgeArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let overlay = self?.overlay else {
                invoke.reject("tab bar is not configured")
                return
            }
            if overlay.setBadge(id: args.id, value: args.value) {
                invoke.resolve()
            } else {
                invoke.reject("unknown tab id: \(args.id)")
            }
        }
    }

    @objc public func createComponent(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(CreateComponentArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let host = self.manager.viewController else {
                invoke.reject("host view controller unavailable")
                return
            }
            let overlay = self.componentsOverlay ?? self.mountComponents(on: host)
            overlay.create(args, webView: self.webView)
            invoke.resolve()
        }
    }

    @objc public func updateComponent(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(UpdateComponentArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let overlay = self?.componentsOverlay, overlay.update(id: args.id, props: args.props)
            else {
                invoke.reject("unknown component: \(args.id)")
                return
            }
            invoke.resolve()
        }
    }

    @objc public func updateComponents(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(UpdateComponentsArgs.self)
        DispatchQueue.main.async { [weak self] in
            if let overlay = self?.componentsOverlay {
                for item in args.components {
                    _ = overlay.update(id: item.id, props: item.props)
                }
            }
            invoke.resolve()
        }
    }

    @objc public func removeComponent(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(RemoveComponentArgs.self)
        DispatchQueue.main.async { [weak self] in
            self?.componentsOverlay?.remove(id: args.id)
            invoke.resolve()
        }
    }

    @objc public func getTabBarInsets(_ invoke: Invoke) {
        DispatchQueue.main.async { [weak self] in
            let bottom = self?.overlay?.bottomInset ?? 0
            invoke.resolve(["bottom": Double(bottom)])
        }
    }

    /// Whether real Liquid Glass (`UIGlassEffect`) is available: an iOS-26 SDK
    /// build (`compiler(>=6.2)`) running on iOS 26+. Below that the glass
    /// components fall back to a material blur, so callers gate the native
    /// glass tab bar on this rather than sniffing the (WebKit-frozen) UA string.
    @objc public func isGlassSupported(_ invoke: Invoke) {
        var supported = false
        #if compiler(>=6.2)
            if #available(iOS 26.0, *) { supported = true }
        #endif
        invoke.resolve(["supported": supported, "fallback": !supported])
    }

    @objc public func presentSheet(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PresentSheetArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let host = self.manager.viewController else {
                invoke.reject("host view controller unavailable")
                return
            }
            let tintColor = args.tint.flatMap(ColorUtil.from(hex:))
            let mappedRows: [SheetRow] = args.rows.map { r in
                let kind: SheetRowKind =
                    r.header == true
                    ? .header : (r.kind.flatMap(SheetRowKind.init(rawValue:)) ?? .action)
                let image = r.image.flatMap(ImageUtil.decode).map {
                    ImageUtil.icon($0, side: kind == .header ? 40 : 24, circular: true)
                }
                return SheetRow(
                    id: r.id, kind: kind, label: r.label, detail: r.detail, image: image,
                    sfSymbol: r.sfSymbol, badge: r.badge, destructive: r.destructive ?? false,
                    value: r.value, on: r.on ?? false, placeholder: r.placeholder,
                    options: (r.options ?? []).map { SheetOption(value: $0.value, label: $0.label) })
            }
            let sheetId = args.id

            // Already on screen with this id → swap content in place (no
            // dismiss→present race/flicker) and we're done.
            if let existing = self.sheets[sheetId], existing.presentingViewController != nil {
                existing.update(rows: mappedRows, tint: tintColor)
                invoke.resolve()
                return
            }

            let sheet = SheetController()
            sheet.tint = tintColor
            sheet.rows = mappedRows
            sheet.onSelect = { [weak self] rowId in
                self?.trigger("sheetRow", data: ["sheetId": sheetId, "rowId": rowId])
            }
            sheet.onField = { [weak self] rowId, value in
                self?.trigger(
                    "sheetField", data: ["sheetId": sheetId, "rowId": rowId, "value": value])
            }
            sheet.onSubmit = { [weak self] rowId, values in
                let json =
                    (try? JSONSerialization.data(withJSONObject: values)).flatMap {
                        String(data: $0, encoding: .utf8)
                    } ?? "{}"
                self?.trigger(
                    "sheetSubmit", data: ["sheetId": sheetId, "rowId": rowId, "values": json])
            }
            sheet.onDismissed = { [weak self] in
                self?.trigger("sheetDismissed", data: ["sheetId": sheetId])
                self?.sheets[sheetId] = nil
            }
            // Sheet detents / grabber are iOS 15+; iOS 14 gets a plain modal.
            if #available(iOS 15.0, *), let pres = sheet.sheetPresentationController {
                pres.detents = [.medium(), .large()]
                pres.prefersGrabberVisible = true
                pres.preferredCornerRadius = 24
            }
            // Drop any stale controller stored under this id that never made it
            // on screen, then register the new one.
            self.sheets[sheetId]?.dismiss(animated: false)
            self.sheets[sheetId] = sheet

            // Sequence the presentation behind any in-flight modal transition.
            // iOS silently drops a present that overlaps another present/dismiss,
            // so a caller swapping one native sheet for another (dismiss A +
            // present B in the same turn) would otherwise have to time an
            // arbitrary delay. Instead we wait for the host to settle: ride out
            // an animating transition via its coordinator; if one of OUR sheets
            // is still up, dismiss it and swap; if a modal we DON'T own is up
            // (system alert, share sheet, permission prompt, …) leave it and
            // present above it. Attempt-capped so a stuck modal can't loop.
            func present(from presenter: UIViewController) {
                presenter.present(sheet, animated: true) {
                    sheet.presentationController?.delegate = sheet
                }
            }
            func presentWhenClear(_ attempt: Int) {
                if attempt >= 10 {
                    present(from: host)
                    return
                }
                if let coordinator = host.transitionCoordinator {
                    coordinator.animate(alongsideTransition: nil) { _ in
                        presentWhenClear(attempt + 1)
                    }
                    return
                }
                // Walk to the topmost presented controller.
                var top: UIViewController = host
                while let next = top.presentedViewController { top = next }
                if top === host {
                    present(from: host)
                } else if self.sheets.values.contains(where: { $0 === top }) {
                    // Our own sheet — dismiss it, then swap in the new one.
                    top.dismiss(animated: true) { presentWhenClear(attempt + 1) }
                } else {
                    // A modal we don't own — never force-dismiss it; stack above.
                    present(from: top)
                }
            }
            presentWhenClear(0)
            invoke.resolve()
        }
    }

    @objc public func dismissSheet(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(DismissSheetArgs.self)
        DispatchQueue.main.async { [weak self] in
            if let sheet = self?.sheets[args.id] {
                sheet.dismiss(animated: true)
                self?.sheets[args.id] = nil
            }
            invoke.resolve()
        }
    }

    private func setHidden(_ hidden: Bool, _ invoke: Invoke) {
        DispatchQueue.main.async { [weak self] in
            guard let overlay = self?.overlay else {
                invoke.reject("tab bar is not configured")
                return
            }
            UIView.transition(
                with: overlay.view, duration: 0.25, options: .transitionCrossDissolve
            ) {
                overlay.tabBar.isHidden = hidden
            }
            invoke.resolve()
        }
    }

    /// Adds the overlay as a child VC of the webview's host VC. The overlay's
    /// root view is a touch-passthrough covering the host view, so the bar
    /// tracks rotation/safe-area while the webview stays interactive.
    private func mount(on host: UIViewController) -> TabBarOverlayController {
        let overlay = TabBarOverlayController()
        overlay.onSelect = { [weak self] id in
            self?.trigger("tabSelected", data: ["id": id])
        }
        host.addChild(overlay)
        overlay.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.addSubview(overlay.view)
        NSLayoutConstraint.activate([
            overlay.view.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
            overlay.view.trailingAnchor.constraint(equalTo: host.view.trailingAnchor),
            overlay.view.topAnchor.constraint(equalTo: host.view.topAnchor),
            overlay.view.bottomAnchor.constraint(equalTo: host.view.bottomAnchor),
        ])
        overlay.didMove(toParent: host)
        self.overlay = overlay
        return overlay
    }

    /// Adds the components overlay as a child VC of the webview's host VC,
    /// same pattern as the tab bar.
    private func mountComponents(on host: UIViewController) -> ComponentsOverlayController {
        let overlay = ComponentsOverlayController()
        overlay.onEvent = { [weak self] id, event, on, value, detail in
            var data: JSObject = ["id": id, "event": event]
            if let on { data["on"] = on }
            if let value { data["value"] = value }
            if let detail { data["detail"] = detail }
            self?.trigger("componentEvent", data: data)
        }
        host.addChild(overlay)
        overlay.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.addSubview(overlay.view)
        NSLayoutConstraint.activate([
            overlay.view.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
            overlay.view.trailingAnchor.constraint(equalTo: host.view.trailingAnchor),
            overlay.view.topAnchor.constraint(equalTo: host.view.topAnchor),
            overlay.view.bottomAnchor.constraint(equalTo: host.view.bottomAnchor),
        ])
        overlay.didMove(toParent: host)
        self.componentsOverlay = overlay
        return overlay
    }
}

@_cdecl("init_plugin_system_components")
func initPlugin() -> Plugin {
    return SystemComponentsPlugin()
}
