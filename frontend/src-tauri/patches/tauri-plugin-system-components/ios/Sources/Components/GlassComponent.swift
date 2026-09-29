//
//  GlassComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// A bare glass panel — real UIGlassEffect on iOS 26, material blur before
/// that. Pair with `below` + `absolute` placement to back DOM cards.
enum GlassComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let effect: UIVisualEffect
        // The Liquid Glass APIs only exist in the iOS 26 SDK (Xcode 26 / Swift
        // 6.2). A runtime `#available` isn't enough — building against an older
        // SDK can't even see the symbol — so gate it at compile time too.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            let glassEffect = UIGlassEffect()
            if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
                glassEffect.tintColor = tint
            }
            effect = glassEffect
        } else {
            effect = UIBlurEffect(style: .systemMaterial)
        }
        #else
        effect = UIBlurEffect(style: .systemMaterial)
        #endif
        let control = UIVisualEffectView(effect: effect)
        control.clipsToBounds = true
        control.layer.cornerRadius = CGFloat(props?.cornerRadius ?? 18)
        return control
    }
}
