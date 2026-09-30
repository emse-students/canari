//
//  ButtonComponent.swift
//  tauri-plugin-system-components
//

import UIKit

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
            control.install(props, id: id, emit: emit)
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
            control.install(props, id: id, emit: emit)
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
            control.install(props, id: id, emit: emit)
            return control
        }
    }

    /// CANARI PATCH: the side of a button's bitmap, 20 pt unless asked.
    static func imageSide(_ props: ComponentPropsArgs?) -> CGFloat {
        CGFloat(props?.imageSide ?? 20)
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

    /// Wires the `menu` event and applies the patched props, at creation.
    func install(
        _ props: ComponentPropsArgs?, id: String,
        emit: @escaping (String, String, Bool?, Double?, String?) -> Void
    ) {
        onMenuPick = { picked in emit(id, "menu", nil, nil, picked) }
        if #available(iOS 16.0, *) { preferredMenuElementOrder = .fixed }
        apply(props)
    }

    /// The accessible name and the menu. An EMPTY menu turns the button back
    /// into a plain one that reports `click`.
    func apply(_ props: ComponentPropsArgs?) {
        if let label = props?.accessibilityLabel { accessibilityLabel = label }
        if let items = props?.menu {
            menu = items.isEmpty
                ? nil
                : ButtonComponent.menu(items) { [weak self] picked in self?.onMenuPick?(picked) }
            showsMenuAsPrimaryAction = !items.isEmpty
        }
    }
}
