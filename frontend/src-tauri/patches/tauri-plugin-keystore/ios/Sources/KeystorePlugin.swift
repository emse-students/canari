import SwiftRs
import Tauri
import UIKit
import WebKit

import LocalAuthentication

/// Keychain service namespacing every item this plugin writes. Each key-bytes item is then
/// addressed by an account built from the caller's alias (`mls_key_<alias>` for the app process,
/// `mls_bg_key_<alias>` for the notification extension).
private let kKeychainService = "fr.emse.canari"

/// Fallback reason for the Face ID / Touch ID sheet, used only when the caller supplies none.
///
/// This process has no access to the app's Paraglide catalogue, so the localized reason travels
/// down with the request (JS -> `initialiser_mls` -> `GetKeyBytesRequest`). French because that is
/// what shipped: a missing translation must degrade to the previous wording, never to an unlock
/// that cannot happen.
private let kBiometricReason = "Confirmez votre identité pour déverrouiller Canari."

class KeystorePlugin: Plugin {
  /// Request to store a raw 32-byte key in the Keychain.
  class StoreKeyBytesRequest: Decodable {
    let alias: String
    let keyBytes: String  // base64-encoded
  }

  /// Request to retrieve a raw key by alias, plus the localized text for the sheet it raises.
  ///
  /// `title` and `subtitle` are Android-only (`BiometricPrompt` has both; `LAContext` has neither)
  /// but are decoded here so one wire shape serves both platforms.
  class GetKeyBytesRequest: Decodable {
    let alias: String
    let title: String?
    let subtitle: String?
    let cancelTitle: String?
    let reason: String?
  }

  /// Request to read a raw key with no sheet - so, unlike `GetKeyBytesRequest`, no text to carry.
  class GetKeyBytesUnattendedRequest: Decodable {
    let alias: String
  }

  /// Request to delete a raw key by alias.
  class DeleteKeyBytesRequest: Decodable {
    let alias: String
  }

  /// Request asking whether a raw key exists for an alias.
  class HasKeyBytesRequest: Decodable {
    let alias: String
  }

  /// Whether this device can hold a `.userPresence` item at all, read from the FACT rather than
  /// learned from a refused write: such an item needs a device passcode, and on a phone with none
  /// `SecItemAdd` answers `errSecAuthFailed` (-25293, LocalAuthentication -5 "Passcode not set").
  /// Any other answer (biometry locked out, not enrolled) still leaves the passcode, so the item can
  /// be written.
  private func devicePasscodeIsSet() -> Bool {
    var error: NSError?
    if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) { return true }
    return (error as? LAError)?.code != .passcodeNotSet
  }

  /// Stores a raw 32-byte key (base64-encoded) in the iOS Keychain under the given alias: the
  /// primary item, protected by `.userPresence` (Face ID / Touch ID or the device passcode), for
  /// biometric unlock, and the background copy the notification extension reads.
  ///
  /// THE BACKGROUND COPY IS UPDATED IN PLACE, AND FIRST (2026-10-22). On a phone whose at-rest key is
  /// hardware-held, that item is the only copy of the key every store is sealed under: a delete
  /// followed by an add left a window - a kill, a refused add - in which no copy existed at all. It is
  /// now `SecItemUpdate`d (added only when absent), so at every instant it holds the old key or the
  /// new one. The primary item, bound to `.userPresence`, cannot be updated without a Face ID sheet,
  /// so it is still deleted then added - AFTER the background copy holds the new key, so its window
  /// costs nothing but biometric unlock until the add. A refusal from here up leaves both items on
  /// the old key and is returned: the key change awaiting it (`pointUnattendedUnlockAt`) moves no data.
  /// The Rust bridge reads the background copy back before it counts the write, and asks this write
  /// only when the entry does not already hold the key (`PluginDeviceKeyStore::store_guarded`).
  ///
  /// ON A DEVICE WITH NO PASSCODE THERE IS NO PRIMARY ITEM. It cannot exist there (see
  /// `devicePasscodeIsSet`), and biometric unlock, its only reader, cannot be enabled without a
  /// passcode either. Writing it anyway threw on every call: every PIN unlock's push context failed
  /// and every PIN change stopped here after the server had already rotated (iPhone 12 bench,
  /// 2026-10-15). The background copy is written in both cases.
  @objc public func storeKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StoreKeyBytesRequest.self)

    guard let keyData = Data(base64Encoded: args.keyBytes) else {
      throw NSError(
        domain: "KeyStoreError", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid base64 key bytes"])
    }

    // -- WP-SEC-1: background item, readable by the NSE - UPDATED IN PLACE, FIRST --
    // No .userPresence (that is exactly what locks the NSE out), AfterFirstUnlockThisDeviceOnly so it
    // is available once the device has been unlocked once (covers the "screen locked, push arrives"
    // case), shared via the App Group keychain access group so the NSE can read it.
    let bgMatch: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_bg_key_\(args.alias)",
      kSecAttrAccessGroup as String: "group.fr.emse.canari",
    ]
    var bgStatus = SecItemUpdate(
      bgMatch as CFDictionary, [kSecValueData as String: keyData] as CFDictionary)
    if bgStatus == errSecItemNotFound {
      var bgAddQuery = bgMatch
      bgAddQuery[kSecValueData as String] = keyData
      bgAddQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      bgStatus = SecItemAdd(bgAddQuery as CFDictionary, nil)
    }
    guard bgStatus == errSecSuccess else {
      // Hard failure: the NSE has no JSON fallback to read the key from any more, so a silently
      // skipped background item means every push shows generic text with nothing in the logs.
      NSLog("[KeystorePlugin] storeKeyBytes: background keychain item failed (status=\(bgStatus))")
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(bgStatus), userInfo: nil)
    }

    // -- Primary item: biometric-gated (.userPresence), for the app process --
    // Deleted then added: an access-controlled item cannot be updated without a sheet. The
    // background copy above already holds the new key, so this window loses nothing.
    let deleteQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
    ]
    SecItemDelete(deleteQuery as CFDictionary)
    if devicePasscodeIsSet() {
      var error: Unmanaged<CFError>?
      guard
        let accessControl = SecAccessControlCreateWithFlags(
          nil,
          kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
          .userPresence,
          &error
        )
      else {
        throw error!.takeRetainedValue() as Error
      }

      let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: kKeychainService,
        kSecAttrAccount as String: "mls_key_\(args.alias)",
        kSecValueData as String: keyData,
        kSecAttrAccessControl as String: accessControl,
      ]

      let status = SecItemAdd(addQuery as CFDictionary, nil)
      guard status == errSecSuccess else {
        NSLog("[KeystorePlugin] storeKeyBytes: primary keychain item failed (status=\(status))")
        throw NSError(
          domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
      }
    } else {
      NSLog(
        "[KeystorePlugin] storeKeyBytes: no device passcode - no biometric item, background copy only")
    }

    invoke.resolve()
  }

  /// Retrieves a raw key by alias. Triggers a Face ID / Touch ID prompt.
  /// Returns `{"keyBytes": "<base64>"}` on success, or
  /// `{"keyBytes": null}` if the key is not found.
  @objc public func getKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GetKeyBytesRequest.self)

    let context = LAContext()
    context.localizedReason = args.reason ?? kBiometricReason
    context.interactionNotAllowed = false
    // Left untouched when the caller sends nothing: assigning nil here would not restore the
    // system default, it would blank the button.
    if let cancelTitle = args.cancelTitle {
      context.localizedCancelTitle = cancelTitle
    }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
      kSecReturnData as String: true,
      // No kSecUseOperationPrompt: deprecated since iOS 14, the reason is on the LAContext.
      kSecUseAuthenticationContext as String: context,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    guard status == errSecSuccess,
      let data = item as? Data
    else {
      // Key not found or user cancelled — return null, don't error.
      invoke.resolve(["keyBytes": NSNull()])
      return
    }

    invoke.resolve(["keyBytes": data.base64EncodedString()])
  }

  /// Retrieves a raw key by alias WITHOUT a Face ID / Touch ID sheet, from the background item
  /// (`mls_bg_key_`) the notification extension already reads.
  ///
  /// Reached only from Rust (`initialiser_mls` with `unattendedKeyRead`), never from JS - it is not
  /// in the plugin's command ACL. It serves the "every 12h" unlock cadence, and it is the one place
  /// that cadence costs something on iOS: the primary item is bound to `.userPresence` by the
  /// Secure Enclave, and Apple caps any reuse of that proof at 5 minutes, so a 12h window can only
  /// be honoured by reading the copy that carries no access control. The user chose that trade-off
  /// knowingly; picking "every time" in Settings keeps every read on `getKeyBytes` above.
  /// Returns `{"keyBytes": null}` ONLY when the item is absent (`errSecItemNotFound`). Every other
  /// non-success status - `errSecInteractionNotAllowed` before the first unlock, `-34018` on an
  /// entitlement hiccup - THROWS with its OSStatus (2026-10-22): the at-rest key's settle, prepare
  /// and read treat "absent" as a fact that reverts a marker or writes a new key, so a transient
  /// failure read as "absent" would destroy the only copy of a hardware-held key.
  @objc public func getKeyBytesUnattended(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GetKeyBytesUnattendedRequest.self)

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_bg_key_\(args.alias)",
      kSecAttrAccessGroup as String: "group.fr.emse.canari",
      kSecReturnData as String: true,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      invoke.resolve(["keyBytes": NSNull()])
      return
    }
    guard status == errSecSuccess, let data = item as? Data else {
      NSLog("[KeystorePlugin] getKeyBytesUnattended: ERROR bg item read failed (status=\(status))")
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }
    invoke.resolve(["keyBytes": data.base64EncodedString()])
  }

  /// Deletes a raw key by alias. Treats "not found" as success so the
  /// operation is idempotent.
  @objc public func deleteKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DeleteKeyBytesRequest.self)

    // Delete the primary (biometric-gated) item.
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }

    // WP-SEC-1: also delete the background-accessible item so revoking a
    // device cleans up both copies.
    let bgQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_bg_key_\(args.alias)",
    ]
    let bgStatus = SecItemDelete(bgQuery as CFDictionary)
    if bgStatus != errSecSuccess && bgStatus != errSecItemNotFound {
      NSLog("[KeystorePlugin] deleteKeyBytes: bg item delete failed (status=\(bgStatus))")
    }

    invoke.resolve()
  }

  /// Reports whether a raw key exists for an alias, WITHOUT reading it and WITHOUT ever
  /// showing a Face ID / Touch ID sheet. It is the pre-check that decides whether offering
  /// biometric unlock makes sense at all, so prompting here would defeat its purpose.
  ///
  /// The background item (`mls_bg_key_`) is tested first: it carries no access control, so
  /// matching it needs no authentication. Its presence is NOT the primary item's: on a device with
  /// no passcode `storeKeyBytes` writes the background item alone. That still answers "present"
  /// only where biometric unlock cannot be enabled (it needs the passcode too), so the answer
  /// offers nothing it should not. The primary item is then tried with attributes only and
  /// `kSecUseAuthenticationUISkip`, which returns a match without decrypting - it covers a device
  /// enrolled before the background item existed.
  @objc public func hasKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HasKeyBytesRequest.self)

    let bgQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_bg_key_\(args.alias)",
      kSecAttrAccessGroup as String: "group.fr.emse.canari",
      kSecReturnAttributes as String: true,
    ]
    if SecItemCopyMatching(bgQuery as CFDictionary, nil) == errSecSuccess {
      invoke.resolve(["present": true])
      return
    }

    let primaryQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
      kSecReturnAttributes as String: true,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
    ]
    let status = SecItemCopyMatching(primaryQuery as CFDictionary, nil)

    // errSecInteractionNotAllowed means the item IS there but would need a prompt to be read.
    // For an existence check that is a positive answer, not a failure.
    let present = status == errSecSuccess || status == errSecInteractionNotAllowed
    invoke.resolve(["present": present])
  }
}

@_cdecl("init_plugin_keystore")
func initPlugin() -> Plugin {
  return KeystorePlugin()
}
