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

  /// Request to delete a raw key by alias.
  class DeleteKeyBytesRequest: Decodable {
    let alias: String
  }

  /// Request asking whether a raw key exists for an alias.
  class HasKeyBytesRequest: Decodable {
    let alias: String
  }

  /// Stores a raw 32-byte key (base64-encoded) in the iOS Keychain under
  /// the given alias. The key is protected by `.userPresence` access control
  /// (Face ID / Touch ID or device passcode fallback).
  @objc public func storeKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StoreKeyBytesRequest.self)

    guard let keyData = Data(base64Encoded: args.keyBytes) else {
      throw NSError(
        domain: "KeyStoreError", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid base64 key bytes"])
    }

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

    // -- Primary item: biometric-gated (.userPresence), for the app process --
    let deleteQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    let addQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
      kSecValueData as String: keyData,
      kSecAttrAccessControl as String: accessControl,
    ]

    let status = SecItemAdd(addQuery as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }

    // -- WP-SEC-1: secondary item, background-accessible for the NSE --
    // No .userPresence (that is exactly what locks the NSE out),
    // AfterFirstUnlockThisDeviceOnly so it is available once the device
    // has been unlocked once (covers the "screen locked, push arrives"
    // case). Shared via the App Group keychain access group so the NSE
    // can read it from its own process.
    let bgDeleteQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_bg_key_\(args.alias)",
    ]
    SecItemDelete(bgDeleteQuery as CFDictionary)

    let bgAddQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_bg_key_\(args.alias)",
      kSecValueData as String: keyData,
      kSecAttrAccessGroup as String: "group.fr.emse.canari",
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      // NO kSecAttrAccessControl — that is exactly what blocks the NSE today
    ]

    let bgStatus = SecItemAdd(bgAddQuery as CFDictionary, nil)
    guard bgStatus == errSecSuccess else {
      // Hard failure, like the primary item above. The NSE has no JSON fallback to
      // read the key from any more, so a silently-skipped background item means every
      // push shows generic text with nothing in the logs to say why. The only known
      // cause - an access group missing from the profile - fails at codesign, not
      // here, so a status at this point is a real error worth surfacing.
      NSLog("[KeystorePlugin] storeKeyBytes: background keychain item failed (status=\(bgStatus))")
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(bgStatus), userInfo: nil)
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
  /// matching it needs no authentication. It is written and deleted in the same operations as
  /// the primary item, which makes its presence equivalent. The primary item is then tried with
  /// attributes only and `kSecUseAuthenticationUISkip`, which returns a match without decrypting
  /// - it covers a device enrolled before the background item existed.
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
