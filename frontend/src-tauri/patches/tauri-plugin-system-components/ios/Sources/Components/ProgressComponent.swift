//
//  ProgressComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// UIProgressView — display only.
enum ProgressComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let control = UIProgressView(progressViewStyle: .default)
        control.progress = Float(props?.value ?? 0)
        if let tint = props?.tint.flatMap(ColorUtil.from(hex:)) {
            control.progressTintColor = tint
        }
        return control
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        if let progress = control as? UIProgressView, let value = props.value {
            progress.setProgress(Float(value), animated: true)
        }
    }
}
