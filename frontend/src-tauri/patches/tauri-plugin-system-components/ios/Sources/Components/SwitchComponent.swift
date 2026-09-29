//
//  SwitchComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// UISwitch — emits `change` with the new `on` state.
enum SwitchComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let control = UISwitch()
        control.isOn = props?.on ?? false
        if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
            control.onTintColor = tint
        }
        let id = args.id
        let emit = ctx.emit
        control.addAction(
            UIAction { [weak control] _ in emit(id, "change", control?.isOn, nil, nil) },
            for: .valueChanged)
        return control
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        if let toggle = control as? UISwitch, let on = props.on {
            toggle.setOn(on, animated: true)
        }
    }
}
