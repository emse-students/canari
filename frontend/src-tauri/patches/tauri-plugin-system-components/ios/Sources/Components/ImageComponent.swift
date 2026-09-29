//
//  ImageComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// UIImageView — display only (avatars, thumbnails). Optionally circular.
enum ImageComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let side = CGFloat(props?.width ?? props?.height ?? 48)
        let control = UIImageView()
        control.contentMode = .scaleAspectFill
        control.clipsToBounds = true
        if props?.circular ?? false {
            control.layer.cornerRadius = side / 2
        }
        if let b64 = props?.image, let decoded = ImageUtil.decode(b64) {
            control.image = decoded
        }
        return control
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        if let imageView = control as? UIImageView, let b64 = props.image,
            let decoded = ImageUtil.decode(b64)
        {
            imageView.image = decoded
        }
    }
}
