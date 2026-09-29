//
//  SheetOverlay.swift
//  tauri-plugin-system-components
//
//  A native bottom sheet (UISheetPresentationController — real detents,
//  grabber, drag-to-dismiss) whose rows are rendered NATIVELY from data the
//  web app passes. On iOS 26 it sits on a Liquid Glass background; on older
//  systems a material blur. Beyond simple tappable rows, rows can be form
//  controls (text field, toggle, date picker, select, submit) so whole screens
//  — menus AND forms — render natively. Interaction reports back to JS:
//    • tappable row  → `sheetRow`     {sheetId, rowId}
//    • field change  → `sheetField`   {sheetId, rowId, value}
//    • submit button → `sheetSubmit`  {sheetId, rowId, values(JSON)}
//    • user dismiss  → `sheetDismissed`{sheetId}
//

import UIKit

enum SheetRowKind: String {
    case header  // non-tappable identity (avatar + name + email)
    case action  // tappable row → sheetRow
    case text  // multi-line paragraph, display only
    case textfield  // single-line text input
    case toggle  // UISwitch
    case datetime  // UIDatePicker (.dateAndTime)
    case select  // value chosen from `options` via a menu
    case submit  // prominent button → sheetSubmit(values)
}

struct SheetOption {
    let value: String
    let label: String
}

struct SheetRow {
    let id: String
    let kind: SheetRowKind
    let label: String
    let detail: String?
    let image: UIImage?
    let sfSymbol: String?
    let badge: String?
    let destructive: Bool
    let value: String?  // textfield text / datetime ISO-8601 / select value
    let on: Bool  // toggle
    let placeholder: String?
    let options: [SheetOption]  // select
}

final class SheetController: UIViewController, UITableViewDataSource, UITableViewDelegate,
    UIAdaptivePresentationControllerDelegate
{
    var rows: [SheetRow] = []
    var tint: UIColor?
    var onSelect: ((String) -> Void)?  // action row tapped
    var onField: ((String, String) -> Void)?  // (rowId, value) field changed
    var onSubmit: ((String, [String: String]) -> Void)?  // (rowId, all field values)
    var onDismissed: (() -> Void)?

    private let table = UITableView(frame: .zero, style: .insetGrouped)
    /// Live field values keyed by rowId, seeded from the rows' initial values.
    private var values: [String: String] = [:]
    private static let iso = ISO8601DateFormatter()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let effect: UIVisualEffect = {
            // UIGlassEffect ships in the iOS 26 SDK (Xcode 26 / Swift 6.2);
            // compile it out on older SDKs that lack the symbol.
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) { return UIGlassEffect() }
            #endif
            return UIBlurEffect(style: .systemThickMaterial)
        }()
        let glass = UIVisualEffectView(effect: effect)
        glass.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(glass)

        table.translatesAutoresizingMaskIntoConstraints = false
        table.backgroundColor = .clear
        table.dataSource = self
        table.delegate = self
        table.keyboardDismissMode = .interactive
        if let tint { table.tintColor = tint }
        view.addSubview(table)

        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: view.topAnchor),
            glass.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.topAnchor.constraint(equalTo: view.topAnchor),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        seedValues(rows)
    }

    /// Seed field values from rows' initial state — only for keys not already
    /// held, so a live update never clobbers what the user has typed.
    private func seedValues(_ rows: [SheetRow]) {
        for r in rows where values[r.id] == nil {
            switch r.kind {
            case .toggle: values[r.id] = r.on ? "true" : "false"
            case .textfield, .datetime, .select: if let v = r.value { values[r.id] = v }
            default: break
            }
        }
    }

    /// Re-present in place: swap rows/tint and reload WITHOUT a dismiss→present
    /// cycle (which races and flickers). Used when the same sheet id is
    /// presented again with new content (e.g. a list row was removed).
    func update(rows newRows: [SheetRow], tint newTint: UIColor?) {
        rows = newRows
        tint = newTint
        seedValues(newRows)
        if isViewLoaded {
            if let newTint { table.tintColor = newTint }
            table.reloadData()
        }
    }

    // MARK: data source

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = rows[indexPath.row]
        // Fresh cell each time (forms are short) so reused controls never leak.
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.4)
        cell.selectionStyle = .none

        var config = cell.defaultContentConfiguration()
        config.text = row.label
        config.secondaryText = row.detail
        if let image = row.image {
            config.image = image
        } else if let symbol = row.sfSymbol {
            config.image = UIImage(systemName: symbol)
        }
        config.imageProperties.maximumSize = CGSize(
            width: row.kind == .header ? 40 : 24, height: row.kind == .header ? 40 : 24)
        config.imageProperties.tintColor =
            row.destructive ? .systemRed : (row.kind == .header ? .label : .secondaryLabel)

        switch row.kind {
        case .header:
            config.textProperties.font = .preferredFont(forTextStyle: .headline)
            config.secondaryTextProperties.color = .secondaryLabel
            cell.contentConfiguration = config

        case .text:
            config.textProperties.numberOfLines = 0
            config.textProperties.color = .label
            config.secondaryTextProperties.numberOfLines = 0
            cell.contentConfiguration = config

        case .action:
            if row.destructive { config.textProperties.color = .systemRed }
            cell.contentConfiguration = config
            cell.selectionStyle = .default
            if let badge = row.badge {
                cell.accessoryView = makeBadge(badge)
            } else {
                cell.accessoryType = .disclosureIndicator
            }

        case .submit:
            config.text = nil
            cell.contentConfiguration = config
            let button = UIButton(type: .system)
            button.setTitle(row.label, for: .normal)
            button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
            button.translatesAutoresizingMaskIntoConstraints = false
            let id = row.id
            button.addAction(
                UIAction { [weak self] _ in
                    guard let self else { return }
                    self.view.endEditing(true)
                    self.onSubmit?(id, self.values)
                }, for: .touchUpInside)
            cell.contentView.addSubview(button)
            NSLayoutConstraint.activate([
                button.topAnchor.constraint(equalTo: cell.contentView.topAnchor, constant: 8),
                button.bottomAnchor.constraint(equalTo: cell.contentView.bottomAnchor, constant: -8),
                button.leadingAnchor.constraint(equalTo: cell.contentView.leadingAnchor),
                button.trailingAnchor.constraint(equalTo: cell.contentView.trailingAnchor),
            ])

        case .toggle:
            cell.contentConfiguration = config
            let sw = UISwitch()
            sw.isOn = (values[row.id] ?? "false") == "true"
            if let tint { sw.onTintColor = tint }
            let id = row.id
            sw.addAction(
                UIAction { [weak self, weak sw] _ in
                    let v = (sw?.isOn ?? false) ? "true" : "false"
                    self?.values[id] = v
                    self?.onField?(id, v)
                }, for: .valueChanged)
            cell.accessoryView = sw

        case .textfield:
            // Custom row layout: a caption that hugs its text + a field that fills
            // the remaining width. An input field in `accessoryView` mis-sizes for
            // long values/placeholders — it grows past the cell and shoves the
            // label off the leading edge (the reported overflow).
            let caption = UILabel()
            caption.text = row.label
            caption.font = .preferredFont(forTextStyle: .body)
            caption.textColor = .label
            caption.setContentHuggingPriority(.required, for: .horizontal)
            caption.setContentCompressionResistancePriority(.required, for: .horizontal)
            let field = UITextField()
            field.text = values[row.id]
            field.placeholder = row.placeholder
            field.textAlignment = .right
            field.clearButtonMode = .whileEditing
            // The field yields width to the caption and scrolls its own text, so
            // neither one overflows the cell.
            field.setContentHuggingPriority(.defaultLow, for: .horizontal)
            field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let id = row.id
            field.addAction(
                UIAction { [weak self, weak field] _ in
                    let v = field?.text ?? ""
                    self?.values[id] = v
                    self?.onField?(id, v)
                }, for: .editingChanged)
            let stack = UIStackView(arrangedSubviews: [caption, field])
            stack.axis = .horizontal
            stack.spacing = 12
            stack.alignment = .center
            stack.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.addSubview(stack)
            let margins = cell.contentView.layoutMarginsGuide
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: margins.topAnchor),
                stack.bottomAnchor.constraint(equalTo: margins.bottomAnchor),
                stack.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
            ])

        case .datetime:
            cell.contentConfiguration = config
            let picker = UIDatePicker()
            picker.datePickerMode = .dateAndTime
            if #available(iOS 14.0, *) { picker.preferredDatePickerStyle = .compact }
            if let v = values[row.id], let d = Self.iso.date(from: v) {
                picker.date = d
            } else {
                values[row.id] = Self.iso.string(from: picker.date)
            }
            let id = row.id
            picker.addAction(
                UIAction { [weak self, weak picker] _ in
                    let v = Self.iso.string(from: picker?.date ?? Date())
                    self?.values[id] = v
                    self?.onField?(id, v)
                }, for: .valueChanged)
            cell.accessoryView = picker

        case .select:
            cell.contentConfiguration = config
            let button = UIButton(type: .system)
            let current = values[row.id]
            button.setTitle(
                row.options.first { $0.value == current }?.label ?? (row.placeholder ?? "Select"),
                for: .normal)
            let id = row.id
            button.menu = UIMenu(
                children: row.options.map { opt in
                    UIAction(title: opt.label, state: opt.value == current ? .on : .off) {
                        [weak self, weak button] _ in
                        self?.values[id] = opt.value
                        self?.onField?(id, opt.value)
                        button?.setTitle(opt.label, for: .normal)
                    }
                })
            button.showsMenuAsPrimaryAction = true
            cell.accessoryView = button
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let row = rows[indexPath.row]
        if row.kind == .action { onSelect?(row.id) }
    }

    private func makeBadge(_ text: String) -> UIView {
        let label = PaddedLabel()
        label.text = text
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = tint ?? .systemBlue
        label.layer.cornerRadius = 10
        label.clipsToBounds = true
        label.sizeToFit()
        return label
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismissed?()
    }
}

/// A small pill label for row badges (intrinsic size padded horizontally).
private final class PaddedLabel: UILabel {
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + 14, height: 20)
    }
    override func sizeThatFits(_ size: CGSize) -> CGSize { intrinsicContentSize }
}
