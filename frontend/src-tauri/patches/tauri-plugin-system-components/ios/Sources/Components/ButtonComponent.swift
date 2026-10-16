//
//  ButtonComponent.swift
//  tauri-plugin-system-components
//

import UIKit
import WebKit

/// UIButton — glass configuration on iOS 26, filled/gray on iOS 15, plain
/// UIButton on iOS 14. Emits `click`, and `menu` (CANARI PATCH) when it
/// carries entries.
enum ButtonComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let id = args.id
        let emit = ctx.emit

        // A circular bitmap (an avatar) renders full-bleed, edge to edge — not
        // as a padded configuration image.
        // CANARI PATCH: only WITHOUT a title. An avatar with a title is a pill (a
        // conversation's name), drawn by the configuration below with the avatar
        // as its round icon.
        if (props?.circular ?? false), props?.label == nil, let b64 = props?.image,
            let decoded = ImageUtil.decode(b64)
        {
            let control = CanariButton(type: .custom)
            control.clipsToBounds = true
            let side = CGFloat(props?.width ?? props?.height ?? 50)
            control.layer.cornerRadius = side / 2
            control.setImage(decoded, for: .normal)
            control.imageView?.contentMode = .scaleAspectFill
            control.contentHorizontalAlignment = .fill
            control.contentVerticalAlignment = .fill
            control.addAction(
                UIAction { _ in emit(id, "click", nil, nil, nil) }, for: .touchUpInside)
            control.install(props, id: id, emit: emit, webView: ctx.webView)
            return control
        }

        // UIButton.Configuration (and the glass styles) are iOS 15 / 26; iOS 14
        // gets a plain UIButton with the same title/icon/tint.
        if #available(iOS 15.0, *) {
            var config: UIButton.Configuration
            // The glass button configurations only exist in the iOS 26 SDK
            // (Xcode 26 / Swift 6.2); compile the filled/gray fallback when
            // building against an older SDK that can't see those symbols.
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                config = (props?.prominent ?? false)
                    ? UIButton.Configuration.prominentGlass()
                    : UIButton.Configuration.glass()
            } else {
                config = (props?.prominent ?? false)
                    ? UIButton.Configuration.filled()
                    : UIButton.Configuration.gray()
            }
            #else
            config = (props?.prominent ?? false)
                ? UIButton.Configuration.filled()
                : UIButton.Configuration.gray()
            #endif
            config.title = props?.label
            applyTitleSize(&config, props)
            if let b64 = props?.image, let decoded = ImageUtil.decode(b64) {
                config.image = ImageUtil.icon(
                    decoded, side: imageSide(props), circular: props?.circular ?? false)
                config.imagePadding = 6
            } else if let symbol = props?.sfSymbol {
                config.image = UIImage(systemName: symbol)
                config.imagePadding = 6
            }
            if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
                config.baseBackgroundColor = tint
            }
            // CANARI PATCH: the title's colour. A glass button otherwise draws it
            // in the system tint, which is blue.
            if let foreground = props?.foreground.flatMap(ColorUtil.from(hex:)) {
                config.baseForegroundColor = foreground
            }
            let control = CanariButton(configuration: config)
            control.addAction(
                UIAction { _ in emit(id, "click", nil, nil, nil) }, for: .touchUpInside)
            control.install(props, id: id, emit: emit, webView: ctx.webView)
            return control
        } else {
            let control = CanariButton(type: .system)
            control.setTitle(props?.label, for: .normal)
            if let b64 = props?.image, let decoded = ImageUtil.decode(b64) {
                control.setImage(
                    ImageUtil.icon(decoded, side: 20, circular: props?.circular ?? false),
                    for: .normal)
            } else if let symbol = props?.sfSymbol {
                control.setImage(UIImage(systemName: symbol), for: .normal)
            }
            if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
                control.backgroundColor = tint
            }
            control.addAction(
                UIAction { _ in emit(id, "click", nil, nil, nil) }, for: .touchUpInside)
            control.install(props, id: id, emit: emit, webView: ctx.webView)
            return control
        }
    }

    /// CANARI PATCH: the side of a button's bitmap, 20 pt unless asked.
    static func imageSide(_ props: ComponentPropsArgs?) -> CGFloat {
        CGFloat(props?.imageSide ?? 20)
    }

    /// CANARI PATCH: a title at the web's size, bold, on ONE line truncated at its tail. The
    /// configuration's own font is 17 pt and its title wraps, so the conversation pill broke
    /// "Canari Test Beta" onto two lines in a 178 pt button whose web twin draws 14 pt bold on one
    /// (iPhone 12, 2026-10-01). Unset `titleSize` leaves the configuration's font alone.
    @available(iOS 15.0, *)
    static func applyTitleSize(_ config: inout UIButton.Configuration, _ props: ComponentPropsArgs?) {
        guard let size = props?.titleSize else { return }
        let font = UIFont.systemFont(ofSize: CGFloat(size), weight: .bold)
        config.titleLineBreakMode = .byTruncatingTail
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = font
            return outgoing
        }
    }

    /// CANARI PATCH: a button's `menu` as a UIMenu, in the order given (the web
    /// menu's order, wherever the button sits). Each glyph is a TEMPLATE, so the
    /// menu draws it in its own text colour, light or dark.
    static func menu(_ items: [MenuItemArgs], onPick: @escaping (String) -> Void) -> UIMenu {
        let actions = items.map { item -> UIAction in
            let image = item.image.flatMap(ImageUtil.decode).map {
                ImageUtil.icon($0, side: 20, circular: false).withRenderingMode(.alwaysTemplate)
            }
            let action = UIAction(title: item.title, image: image) { _ in onPick(item.id) }
            if let on = item.on { action.state = on ? .on : .off }
            return action
        }
        return UIMenu(children: actions)
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        guard let button = control as? UIButton else { return }
        if #available(iOS 15.0, *) {
            var config = button.configuration
            if let label = props.label { config?.title = label }
            if config != nil { applyTitleSize(&config!, props) }
            if let b64 = props.image, let decoded = ImageUtil.decode(b64) {
                config?.image = ImageUtil.icon(
                    decoded, side: imageSide(props), circular: props.circular ?? false)
            }
            if let foreground = props.foreground.flatMap(ColorUtil.from(hex:)) {
                config?.baseForegroundColor = foreground
            }
            button.configuration = config
        } else {
            if let label = props.label { button.setTitle(label, for: .normal) }
            if let b64 = props.image, let decoded = ImageUtil.decode(b64) {
                button.setImage(
                    ImageUtil.icon(decoded, side: 20, circular: props.circular ?? false),
                    for: .normal)
            }
        }
        (button as? CanariButton)?.apply(props)
    }
}

/// CANARI PATCH: a UIButton that keeps what a live update needs to rebuild its
/// menu - `update` receives no context, so the reporting closure lives here.
final class CanariButton: UIButton {
    private var onMenuPick: ((String) -> Void)?
    /// The webview under the button, held out of touch while the button's menu is up.
    private weak var webView: WKWebView?
    /// The `didBecomeActive` observation that releases a hold the system tore down (see `install`).
    private var activeObserver: NSObjectProtocol?

    /// Wires the `menu` event and applies the patched props, at creation.
    func install(
        _ props: ComponentPropsArgs?, id: String,
        emit: @escaping (String, String, Bool?, Double?, String?) -> Void,
        webView: WKWebView?
    ) {
        onMenuPick = { picked in emit(id, "menu", nil, nil, picked) }
        self.webView = webView
        // A call, the app switcher or a lock takes the app inactive and tears an open menu down,
        // with no `willEnd` promised: the page gets its touch back the moment the app is active
        // again. Block-based and weak, so the observation never keeps the button alive.
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.holdPage(false, why: "the app became active")
        }
        if #available(iOS 16.0, *) { preferredMenuElementOrder = .fixed }
        apply(props)
    }

    deinit {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        holdPage(false, why: "the button was released")
    }

    /// CANARI PATCH: A TOUCH THAT DISMISSES THE MENU IS THE MENU'S, NEVER THE PAGE'S.
    ///
    /// The menu is a native UIMenu the web knows nothing of, and the touch that dismisses it
    /// went on into the webview: with the composer's "+" menu open, ONE edge swipe closed the
    /// menu (UIKit) AND the conversation (the page's own swipe, which saw nothing open over the
    /// conversation) - iPhone 12, v1.2.9-alpha.4, 12 of 12, read in the in-app log as one
    /// `gesture Back closes overlay N, 0 left open` per swipe with N growing by ONE per round,
    /// the conversation's entry: the "+" never pushed one. A tap outside the menu reached the web
    /// button under it the same way.
    ///
    /// So the webview takes no touch while the menu is displayed. The dismissing touch is hit-tested
    /// while the webview is still out of reach, so it never becomes the page's, whatever order
    /// `willEnd` and the touch arrive in. A WEBVIEW LEFT HELD IS A DEAD APP, so every way a menu can
    /// end releases it: `willEnd`, `apply` clearing the menu, the button leaving the window or being
    /// released, and the app becoming active again. No timer: each release is a fact.
    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willDisplayMenuFor configuration: UIContextMenuConfiguration,
        animator: UIContextMenuInteractionAnimating?
    ) {
        super.contextMenuInteraction(
            interaction, willDisplayMenuFor: configuration, animator: animator)
        holdPage(true, why: "its menu is shown")
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willEndFor configuration: UIContextMenuConfiguration,
        animator: UIContextMenuInteractionAnimating?
    ) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        holdPage(false, why: "its menu ended")
    }

    /// A button that leaves the window while its menu is up (its conversation closed under it, its
    /// glass capsule removed) gives the page its touch back: no `willEnd` is promised then.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { holdPage(false, why: "it left the window") }
    }

    /// THE BUTTONS WHOSE MENU HOLDS THE PAGE, BY IDENTITY - every button shares the one webview, so
    /// a per-button flag let one button's release give touch back under another's open menu. A SET,
    /// not a count: a release by a button that holds nothing changes nothing, so it can neither go
    /// negative nor stay stuck above zero. Main thread only, as every UIKit call here.
    private static var holders = Set<ObjectIdentifier>()

    private func holdPage(_ hold: Bool, why: String) {
        let me = ObjectIdentifier(self)
        let changed =
            hold
            ? CanariButton.holders.insert(me).inserted
            : CanariButton.holders.remove(me) != nil
        guard changed else { return }
        let free = CanariButton.holders.isEmpty
        webView?.isUserInteractionEnabled = free
        NSLog(
            "[CanariButton] %@: the page %@ touch (%ld menu(s) holding it)",
            why, free ? "takes" : "takes no", CanariButton.holders.count)
    }

    /// The accessible name and the menu. An EMPTY menu turns the button back
    /// into a plain one that reports `click` - and a menu cleared while it was up gives the page
    /// its touch back, since UIKit promises no `willEnd` for a menu taken away.
    func apply(_ props: ComponentPropsArgs?) {
        if let label = props?.accessibilityLabel { accessibilityLabel = label }
        if let items = props?.menu {
            menu = items.isEmpty
                ? nil
                : ButtonComponent.menu(items) { [weak self] picked in self?.onMenuPick?(picked) }
            showsMenuAsPrimaryAction = !items.isEmpty
            if items.isEmpty { holdPage(false, why: "its menu was cleared") }
        }
    }
}
