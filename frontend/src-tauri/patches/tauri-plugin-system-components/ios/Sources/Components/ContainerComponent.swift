//
//  ContainerComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// A UIStackView arranging its `children` along `props.axis` — the building
/// block consumers compose a nav (bar or sidebar) from. Imposes no layout of
/// its own beyond what the props ask for.
enum ContainerComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let stack = UIStackView()
        stack.axis = (props?.axis == "vertical") ? .vertical : .horizontal
        stack.alignment = alignment(props?.align)
        stack.distribution = .fill
        stack.spacing = CGFloat(props?.spacing ?? 0)
        for childArgs in args.children ?? [] {
            guard let child = ctx.makeChild(childArgs) else { continue }
            stack.addArrangedSubview(child)
            // The stack owns positioning; explicit child sizes (e.g. a 50pt
            // avatar) come from the child's own props.
            if let w = childArgs.props?.width {
                child.widthAnchor.constraint(equalToConstant: CGFloat(w)).isActive = true
            }
            if let h = childArgs.props?.height {
                child.heightAnchor.constraint(equalToConstant: CGFloat(h)).isActive = true
            }
        }
        return stack
    }

    private static func alignment(_ s: String?) -> UIStackView.Alignment {
        switch s {
        case "leading": return .leading
        case "trailing": return .trailing
        case "fill": return .fill
        default: return .center
        }
    }
}
