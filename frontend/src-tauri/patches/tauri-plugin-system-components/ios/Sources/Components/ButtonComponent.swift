//
//  ButtonComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// UIButton — glass configuration on iOS 26, filled/gray on iOS 15, plain
/// UIButton on iOS 14. Emits `click`.
enum ButtonComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let id = args.id
        let emit = ctx.emit

        // A circular bitmap (an avatar) renders full-bleed, edge to edge — not
        // as a padded configuration image.
        if (props?.circular ?? false), let b64 = props?.image, let decoded = ImageUtil.decode(b64) {
            let control = UIButton(type: .custom)
            control.clipsToBounds = true
            let side = CGFloat(props?.width ?? props?.height ?? 50)
            control.layer.cornerRadius = side / 2
            control.setImage(decoded, for: .normal)
            control.imageView?.contentMode = .scaleAspectFill
            control.contentHorizontalAlignment = .fill
            control.contentVerticalAlignment = .fill
            control.addAction(
                UIAction { _ in emit(id, "click", nil, nil, nil) }, for: .touchUpInside)
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
                config.image = ImageUtil.icon(decoded, side: 20, circular: props?.circular ?? false)
                config.imagePadding = 6
            } else if let symbol = props?.sfSymbol {
                config.image = UIImage(systemName: symbol)
                config.imagePadding = 6
            }
            if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
                config.baseBackgroundColor = tint
            }
            let control = UIButton(configuration: config)
            control.addAction(
                UIAction { _ in emit(id, "click", nil, nil, nil) }, for: .touchUpInside)
            return control
        } else {
            let control = UIButton(type: .system)
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
            return control
        }
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        guard let button = control as? UIButton else { return }
        if #available(iOS 15.0, *) {
            var config = button.configuration
            if let label = props.label { config?.title = label }
            if let b64 = props.image, let decoded = ImageUtil.decode(b64) {
                config?.image = ImageUtil.icon(decoded, side: 20, circular: props.circular ?? false)
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
    }
}
