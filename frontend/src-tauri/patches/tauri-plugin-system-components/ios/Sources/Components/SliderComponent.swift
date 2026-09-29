//
//  SliderComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// UISlider — emits `change` with the new `value`.
enum SliderComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let control = UISlider()
        control.minimumValue = Float(props?.min ?? 0)
        control.maximumValue = Float(props?.max ?? 1)
        control.value = Float(props?.value ?? 0)
        if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
            control.tintColor = tint
        }
        let id = args.id
        let emit = ctx.emit
        control.addAction(
            UIAction { [weak control] _ in emit(id, "change", nil, control.map { Double($0.value) }, nil) },
            for: .valueChanged)
        if props?.width == nil {
            // UISlider has no intrinsic width.
            control.widthAnchor.constraint(equalToConstant: 160).isActive = true
        }
        return control
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        if let slider = control as? UISlider, let value = props.value {
            slider.setValue(Float(value), animated: true)
        }
    }
}
