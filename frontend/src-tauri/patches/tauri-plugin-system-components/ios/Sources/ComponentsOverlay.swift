//
//  ComponentsOverlay.swift
//  tauri-plugin-system-components
//
//  The controller hosting native overlay components over the webview. It only
//  orchestrates — lifecycle (create / update / remove), optional glass-wrapping,
//  and anchoring. Each component's own rendering lives in its file under
//  `Components/`; the kind→builder mapping is `ComponentRegistry`.
//

import UIKit
import WebKit

/// Covers the host view but only claims touches landing on a managed
/// component — everything else falls through to the webview.
final class ComponentsPassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

final class ComponentsOverlayController: UIViewController {
    private var components: [String: (container: UIView, control: UIView, kind: String)] = [:]
    private weak var webViewRef: WKWebView?
    /// (id, event, on, value, detail)
    var onEvent: ((String, String, Bool?, Double?, String?) -> Void)?

    override func loadView() {
        let v = ComponentsPassthroughView()
        v.backgroundColor = .clear
        view = v
    }

    var isEmpty: Bool { components.isEmpty }

    // MARK: creation

    func create(_ args: CreateComponentArgs, webView: WKWebView?) {
        webViewRef = webView
        guard let container = build(args) else { return }

        let props = args.props
        let anchor = args.anchor ?? "topTrailing"
        if args.below ?? false, let webView {
            // Below the webview: make the webview transparent so unpainted DOM
            // regions reveal the native view (barcode-scanner pattern).
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear
            if anchor == "absolute" {
                webView.scrollView.insertSubview(container, at: 0)
                placeByFrame(container, in: webView.scrollView, anchor: anchor, props: props)
            } else if let parent = webView.superview {
                parent.insertSubview(container, belowSubview: webView)
                placeByFrame(container, in: parent, anchor: anchor, props: props)
            }
        } else if anchor == "absolute" || anchor == "fill" {
            view.addSubview(container)
            placeByFrame(container, in: view, anchor: anchor, props: props)
        } else {
            container.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(container)
            activateAnchorConstraints(
                for: container, anchor: anchor,
                dx: CGFloat(args.dx ?? 0), dy: CGFloat(args.dy ?? 0),
                inset: props?.inset.map { CGFloat($0) })
            if let control = components[args.id]?.control {
                if let w = props?.width {
                    control.widthAnchor.constraint(equalToConstant: CGFloat(w)).isActive = true
                }
                if let h = props?.height {
                    control.heightAnchor.constraint(equalToConstant: CGFloat(h)).isActive = true
                }
            }
        }
    }

    /// Build a component's view (recursively for `container` children), glass-wrap
    /// it if asked, and register it by id so updates/removal can find it. Returns
    /// the (possibly wrapped) view to mount.
    @discardableResult
    private func build(_ args: CreateComponentArgs) -> UIView? {
        remove(id: args.id)
        let ctx = ComponentContext(
            emit: { [weak self] id, event, on, value, detail in
                self?.onEvent?(id, event, on, value, detail)
            },
            webView: webViewRef,
            makeChild: { [weak self] childArgs in self?.build(childArgs) }
        )
        guard let control = ComponentRegistry.make(args, ctx) else { return nil }
        var container = control
        if args.props?.glass ?? false {
            container = wrapInGlassCapsule(control)
        }
        components[args.id] = (container, control, args.kind)
        return container
    }

    /// Frame-based placement (UIKit coordinates match CSS: y from the top).
    private func placeByFrame(
        _ container: UIView, in parent: UIView, anchor: String, props: ComponentPropsArgs?
    ) {
        if anchor == "fill" {
            container.frame = parent.bounds
            container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        } else {
            container.frame = CGRect(
                x: props?.x ?? 0,
                y: props?.y ?? 0,
                width: props?.width ?? 200,
                height: props?.height ?? 120
            )
        }
    }

    // MARK: updates

    func update(id: String, props: ComponentPropsArgs) -> Bool {
        guard let entry = components[id] else { return false }
        // Geometry updates (DOM scroll/resize sync) act on the mounted view.
        if props.x != nil || props.y != nil || props.width != nil || props.height != nil {
            var frame = entry.container.frame
            if let w = props.width { frame.size.width = CGFloat(w) }
            if let h = props.height { frame.size.height = CGFloat(h) }
            if let x = props.x { frame.origin.x = CGFloat(x) }
            if let y = props.y { frame.origin.y = CGFloat(y) }
            entry.container.frame = frame
        }
        ComponentRegistry.update(entry.control, kind: entry.kind, props: props)
        return true
    }

    func remove(id: String) {
        if let entry = components.removeValue(forKey: id) {
            entry.container.removeFromSuperview()
        }
    }

    // MARK: layout helpers

    private func wrapInGlassCapsule(_ control: UIView) -> UIView {
        let effect: UIVisualEffect
        // UIGlassEffect ships in the iOS 26 SDK (Xcode 26 / Swift 6.2); compile
        // it out on older SDKs that lack the symbol.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            effect = UIGlassEffect()
        } else {
            effect = UIBlurEffect(style: .systemMaterial)
        }
        #else
        effect = UIBlurEffect(style: .systemMaterial)
        #endif
        let capsule = UIVisualEffectView(effect: effect)
        capsule.clipsToBounds = true
        capsule.layer.cornerRadius = 24
        control.translatesAutoresizingMaskIntoConstraints = false
        capsule.contentView.addSubview(control)
        NSLayoutConstraint.activate([
            control.leadingAnchor.constraint(equalTo: capsule.contentView.leadingAnchor, constant: 14),
            control.trailingAnchor.constraint(equalTo: capsule.contentView.trailingAnchor, constant: -14),
            control.topAnchor.constraint(equalTo: capsule.contentView.topAnchor, constant: 10),
            control.bottomAnchor.constraint(equalTo: capsule.contentView.bottomAnchor, constant: -10),
        ])
        return capsule
    }

    private func activateAnchorConstraints(
        for container: UIView, anchor: String, dx: CGFloat, dy: CGFloat, inset: CGFloat?
    ) {
        let guide = view.safeAreaLayoutGuide
        let margin: CGFloat = inset ?? 16
        var constraints: [NSLayoutConstraint] = []
        switch anchor {
        case "topLeading":
            constraints = [
                container.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: margin + dx),
                container.topAnchor.constraint(equalTo: guide.topAnchor, constant: margin + dy),
            ]
        case "bottomLeading":
            constraints = [
                container.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: margin + dx),
                container.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -(margin + dy)),
            ]
        case "bottomTrailing":
            constraints = [
                container.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -(margin + dx)),
                container.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -(margin + dy)),
            ]
        case "center":
            constraints = [
                container.centerXAnchor.constraint(equalTo: guide.centerXAnchor, constant: dx),
                container.centerYAnchor.constraint(equalTo: guide.centerYAnchor, constant: dy),
            ]
        // Edge-docked: span the cross-axis so a bottom/top bar fills the width
        // (and a side rail fills the height), letting its children lay out
        // across the edge instead of floating a content-sized blob at the
        // center. `inset` (margin) is the gap from the docked edge and the
        // side insets along it. `dx` nudges the whole bar horizontally (same
        // shift on both edges, so the width is unchanged); `dy` adjusts the gap
        // from the docked edge.
        case "bottom":
            constraints = [
                container.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: margin + dx),
                container.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -margin + dx),
                container.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -(margin + dy)),
            ]
        case "top":
            constraints = [
                container.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: margin + dx),
                container.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -margin + dx),
                container.topAnchor.constraint(equalTo: guide.topAnchor, constant: margin + dy),
            ]
        case "leading":
            constraints = [
                container.topAnchor.constraint(equalTo: guide.topAnchor, constant: margin),
                container.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -margin),
                container.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: margin + dx),
            ]
        case "trailing":
            constraints = [
                container.topAnchor.constraint(equalTo: guide.topAnchor, constant: margin),
                container.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -margin),
                container.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -(margin + dx)),
            ]
        default:  // topTrailing
            constraints = [
                container.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -(margin + dx)),
                container.topAnchor.constraint(equalTo: guide.topAnchor, constant: margin + dy),
            ]
        }
        NSLayoutConstraint.activate(constraints)
    }
}
