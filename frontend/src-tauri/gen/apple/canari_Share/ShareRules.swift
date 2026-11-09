import Foundation

/// The rules a share INTO Canari is copied under - Android's `share/ShareRules.kt`, the same numbers.
///
/// Two languages, one contract: `frontend/src/lib/mobile/iosShareExtension.test.ts` reads both
/// sources and fails when a constant here drifts from the Kotlin one. The page applies the server's
/// own upload ceiling afterwards (`refusedBeforePreparation`), so these are bounds on DISK and on
/// what the page will read whole when it stages a share, not the upload limit.
enum ShareRules {
    /// At most this many files are kept from one share; the rest are counted as refused.
    static let maxFiles = 10

    /// Per-file ceiling on disk. Above the server's own, because a video is re-encoded on the phone
    /// before upload; bounded, because the page reads a kept file whole when it stages it.
    static let maxFileBytes: Int64 = 200 * 1024 * 1024

    /// Ceiling for the whole share, for the same reason.
    static let maxTotalBytes: Int64 = 300 * 1024 * 1024

    /// Ceiling for the TEXT of one share (typed comment, text and links together, UTF-8 bytes). The
    /// text travels inside the manifest, which the app and the page read whole; Android has the same
    /// bound without naming it, because an intent extra past about 1 MB fails its binder transaction.
    /// A part that would pass it is refused and counted like a file refused over its ceiling.
    static let maxTextBytes = 1024 * 1024

    /// How many bytes the next file may take, given what the share has already kept: the smaller of
    /// the per-file ceiling and what is left of the total. Zero or less means it is refused unread.
    static func nextFileCeiling(keptSoFar: Int64) -> Int64 {
        return min(maxFileBytes, maxTotalBytes - keptSoFar)
    }

    /// The conversation suggestion the member picked in the share sheet (sharing lot S5), as the
    /// `conversationIdentifier` the app donated (`c:<conversation id>`), or nil - Android's
    /// `IncomingShare.suggestedTarget`, the same shape and bound. Only a HINT: the page preselects
    /// it only if the signed-in account holds that conversation.
    static func suggestedTarget(_ conversationIdentifier: String?) -> String? {
        guard let id = conversationIdentifier else { return nil }
        if id.hasPrefix("c:") && (3...200).contains(id.count) { return id }
        return nil
    }
}

/// The file name a shared item is stored and offered under - Android's `share/SharedFileName.kt`.
///
/// The name comes from the SENDER and is untrusted: reduced to its last path segment (no `../` can
/// climb out of the share's directory), every Unicode scalar outside a conservative set replaced by
/// `_` (the Kotlin regex `[^A-Za-z0-9._ -]` replaces one code point at a time, and a scalar is one
/// code point), leading and trailing dots and spaces trimmed, cut to 100 characters. When nothing is
/// left, a generic name is made from the mime type.
enum SharedFileName {
    /// The longest name kept.
    static let maxLength = 100

    /// The scalars a name keeps; every other one becomes `_`.
    static let safeScalars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._ -")

    static func sanitise(_ raw: String?, mime: String) -> String {
        var base = raw ?? ""
        if let slash = base.lastIndex(of: "/") {
            base = String(base[base.index(after: slash)...])
        }
        if let backslash = base.lastIndex(of: "\\") {
            base = String(base[base.index(after: backslash)...])
        }
        var scalars = String.UnicodeScalarView()
        for scalar in base.unicodeScalars {
            scalars.append(safeScalars.contains(scalar) ? scalar : "_")
        }
        let trimmed = String(scalars).trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        let cut = String(trimmed.prefix(maxLength))
        if !cut.isEmpty {
            return cut
        }
        var subtype = ""
        if let slash = mime.firstIndex(of: "/") {
            subtype = String(mime[mime.index(after: slash)...])
        }
        var ext = String(subtype.prefix(while: { $0.isLetter || $0.isNumber }))
        if ext.isEmpty {
            ext = "bin"
        }
        return "shared.\(ext)"
    }
}
