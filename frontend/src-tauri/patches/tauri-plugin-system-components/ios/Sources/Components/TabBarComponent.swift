//
//  TabBarComponent.swift
//  tauri-plugin-system-components
//

import UIKit

/// A UITabBar that is its own delegate (so it stays retained inside the view
/// tree without an external owner) and reports selection through a closure.
final class ComponentTabBar: UITabBar, UITabBarDelegate {
    private var ids: [String] = []
    private var onSelectId: ((String) -> Void)?

    /// Side of bitmap tab icons (avatars), in points.
    private static let imageSide: CGFloat = 26
    /// Approximate width of one tab slot (icon + label), in points — used only
    /// to derive an intrinsic width (see below).
    private static let itemWidth: CGFloat = 76

    /// A standalone `UITabBar` reports *no intrinsic width* — it expects a
    /// `UITabBarController` to size it — so dropped into a self-sizing container
    /// (a `UIStackView`) it collapses to nothing, which is the squish. Derive a
    /// width from the item count so the bar sizes itself to a proper pill in
    /// *any* container; the stack then lays it out and aligns siblings (the
    /// account button) on its own, with no caller-supplied dimensions.
    override var intrinsicContentSize: CGSize {
        guard let count = items?.count, count > 0 else { return super.intrinsicContentSize }
        let width = CGFloat(count) * Self.itemWidth
        let fitted = sizeThatFits(CGSize(width: width, height: 0)).height
        return CGSize(width: width, height: fitted > 0 ? fitted : super.intrinsicContentSize.height)
    }

    func configure(
        items: [TabItemArgs], selectedId: String?, tint: UIColor?,
        itemPositioning: String?, onSelect: @escaping (String) -> Void
    ) {
        onSelectId = onSelect
        delegate = self
        switch itemPositioning {
        case "fill": self.itemPositioning = .fill
        case "centered": self.itemPositioning = .centered
        default: self.itemPositioning = .automatic
        }
        ids = items.map { $0.id }
        let barItems = items.enumerated().map { index, item -> UITabBarItem in
            var image: UIImage?
            if let b64 = item.image, let decoded = ImageUtil.decode(b64) {
                image = ImageUtil.icon(decoded, side: Self.imageSide, circular: item.circular ?? false)
            } else if let symbol = item.sfSymbol {
                image = UIImage(systemName: symbol)
            }
            let barItem = UITabBarItem(title: item.title, image: image, tag: index)
            barItem.badgeValue = item.badge
            return barItem
        }
        setItems(barItems, animated: false)
        // Item count drives the derived intrinsic width — recompute it. Hug
        // loosely so the bar fills a wider container while a fixed-size sibling
        // (the account button) keeps its size; the intrinsic width is just the
        // floor for when the container instead sizes itself to content.
        invalidateIntrinsicContentSize()
        setContentHuggingPriority(.defaultLow, for: .horizontal)
        // An explicit `selectedId` (even "") selects the match or clears the
        // selection when there is none — so a page that isn't a tab (e.g.
        // Settings) shows no highlighted tab. Only a *missing* id defaults to the
        // first tab.
        if let selectedId {
            selectedItem = ids.firstIndex(of: selectedId).flatMap {
                $0 < barItems.count ? barItems[$0] : nil
            }
        } else {
            selectedItem = barItems.first
        }
        applyTint(tint)
    }

    /// Highlight a tab by id without emitting a selection event. An unknown or
    /// empty id clears the selection (no tab highlighted) — used when the user
    /// is on a page that isn't one of the tabs.
    func selectTab(_ id: String) {
        guard let idx = ids.firstIndex(of: id), let items, idx < items.count else {
            selectedItem = nil
            return
        }
        selectedItem = items[idx]
    }

    /// Tint the selected item via the bar's appearance (so the iOS 26 glass
    /// selection pill honors the accent — plain `tintColor` alone does not).
    private func applyTint(_ color: UIColor?) {
        tintColor = color
        guard let color else { return }
        let appearance = standardAppearance
        for layout in [
            appearance.stackedLayoutAppearance,
            appearance.inlineLayoutAppearance,
            appearance.compactInlineLayoutAppearance,
        ] {
            layout.selected.iconColor = color
            layout.selected.titleTextAttributes = [.foregroundColor: color]
        }
        standardAppearance = appearance
        if #available(iOS 15.0, *) { scrollEdgeAppearance = appearance }
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard item.tag >= 0, item.tag < ids.count else { return }
        onSelectId?(ids[item.tag])
    }

    /// Height of the visible glass pill: the tallest subview inset within the
    /// bar (over half the bar height but shorter than the full frame). The iOS
    /// 26 bar's full frame is taller than this — it reserves space below the
    /// glass that a `UITabBarController`'s home-indicator inset would occupy —
    /// so a composed layout should size to the glass, not the frame. `0` until
    /// the bar has laid out its platter.
    func glassHeight() -> CGFloat {
        guard bounds.height > 1 else { return 0 }
        var best: CGFloat = 0
        func scan(_ v: UIView) {
            for sub in v.subviews {
                let h = sub.bounds.height
                if h > bounds.height * 0.5, h < bounds.height - 0.5 { best = max(best, h) }
                scan(sub)
            }
        }
        scan(self)
        return best
    }
}

/// Wraps a `ComponentTabBar` so a composing container lays it out at the height
/// of its visible glass pill, not the taller frame the bar reports. The bar
/// still renders its full frame (glass at top); only the empty bottom reserve
/// hangs below this wrapper. This keeps the pill at a normal height and lets a
/// sibling control (e.g. an account button) centre on the glass via the
/// container's own alignment — no per-view positioning.
final class GlassSizedTabBar: UIView {
    let bar: ComponentTabBar
    private var heightC: NSLayoutConstraint!
    /// iOS 26 glass-pill height (FabBar's measured value), used until the live
    /// platter height is measured.
    private static let defaultGlassHeight: CGFloat = 62

    init(bar: ComponentTabBar) {
        self.bar = bar
        super.init(frame: .zero)
        bar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(bar)
        heightC = heightAnchor.constraint(equalToConstant: Self.defaultGlassHeight)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: topAnchor),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
            heightC,
        ])
        // Fill a wider container while a fixed-size sibling keeps its size.
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: CGSize {
        CGSize(width: bar.intrinsicContentSize.width, height: heightC.constant)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let glass = bar.glassHeight()
        if glass > 0, abs(heightC.constant - glass) > 0.5 {
            heightC.constant = glass
            invalidateIntrinsicContentSize()
            superview?.setNeedsLayout()
        }
    }
}

/// The system tab bar as a component. `props.items` are the tabs; selection
/// emits a `select` event whose `detail` is the chosen tab id. `props.selectedId`
/// (via update) re-highlights without emitting.
enum TabBarComponent: ComponentBuilder {
    static func make(_ args: CreateComponentArgs, _ ctx: ComponentContext) -> UIView? {
        let props = args.props
        let bar = ComponentTabBar()
        let id = args.id
        let emit = ctx.emit
        bar.configure(
            items: props?.items ?? [],
            selectedId: props?.selectedId,
            tint: props?.tint.flatMap(ColorUtil.from(hex:)),
            itemPositioning: props?.itemPositioning
        ) { tabId in emit(id, "select", nil, nil, tabId) }
        // Compose at the glass-pill height so siblings align to the pill.
        return GlassSizedTabBar(bar: bar)
    }

    static func update(_ control: UIView, _ props: ComponentPropsArgs) {
        let bar = (control as? GlassSizedTabBar)?.bar ?? (control as? ComponentTabBar)
        if let bar, let selectedId = props.selectedId {
            bar.selectTab(selectedId)
        }
    }
}
