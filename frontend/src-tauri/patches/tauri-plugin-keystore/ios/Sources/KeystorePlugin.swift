import SwiftRs
import Tauri
import UIKit
import WebKit

import LocalAuthentication

class StoreRequest: Decodable {
  let value: String
}

/// iOS keychain identifiers for the biometric-protected secret.
///
/// The JS layer (`biometric.ts`) passes `service = "fr.emse.canari"` and
/// `user = "canari_biometric_user"`, but this plugin - like its Android twin -
/// ignores the incoming args and pins a single hardcoded item instead. These
/// constants mirror that JS contract so the native item stays aligned with what
/// the frontend believes it enrolled. (They replace the upstream UniMe sample's
/// `com.impierce.identity-wallet.unime-dev` account, which was copied verbatim.)
private let kKeychainService = "fr.emse.canari"
private let kKeychainAccount = "canari_biometric_user"

/// Fallback reason for the Face ID / Touch ID sheet, used only when the caller supplies none.
///
/// This process has no access to the app's Paraglide catalogue, so the localized reason travels
/// down with the request (JS -> `initialiser_mls` -> `GetKeyBytesRequest`). French because that is
/// what shipped: a missing translation must degrade to the previous wording, never to an unlock
/// that cannot happen.
private let kBiometricReason = "Confirmez votre identité pour déverrouiller Canari."

class KeystorePlugin: Plugin {
  /// Base keychain query shared by store/retrieve/remove so the class/service/account
  /// triple is defined once (zero duplication - a mismatch would silently split the
  /// stored item from the one we try to read back).
  private func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: kKeychainAccount,
    ]
  }

  /// Encrypts and stores `value` in the keychain behind a user-presence access
  /// control (Face ID / Touch ID, or device passcode fallback). Accessible only
  /// while the device is unlocked and never migrated off this device.
  @objc public func store(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StoreRequest.self)

    guard let secretData = args.value.data(using: .utf8) else {
      throw NSError(
        domain: "StoreErrorDomain", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid secret string"])
    }

    // Access control requires user presence (biometrics or device passcode) and
    // makes the item readable only when the device is unlocked.
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

    var query = baseQuery()
    query[kSecAttrAccessControl as String] = accessControl
    query[kSecValueData as String] = secretData

    // Replace any existing item for this service/account.
    SecItemDelete(query as CFDictionary)

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }

    invoke.resolve()
  }

  /// Reads the secret back, forcing a fresh biometric evaluation. An explicit
  /// `LAContext` carries the localized reason and - because the stored item was
  /// created with `.userPresence` - `SecItemCopyMatching` triggers the Face ID /
  /// Touch ID prompt through that context. Setting `interactionNotAllowed = false`
  /// makes the interactive prompt intent explicit rather than relying on defaults.
  @objc public func retrieve(_ invoke: Invoke) throws {
    let context = LAContext()
    context.localizedReason = kBiometricReason
    context.interactionNotAllowed = false

    var query = baseQuery()
    query[kSecReturnData as String] = true
    // kSecUseOperationPrompt is deprecated since iOS 14 in favour of exactly this:
    // the reason travels on the LAContext above.
    query[kSecUseAuthenticationContext as String] = context

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }

    guard let data = item as? Data,
      let secret = String(data: data, encoding: .utf8)
    else {
      throw NSError(
        domain: kKeychainService, code: -1,
        userInfo: [NSLocalizedDescriptionKey: "Unable to decode secret"])
    }

    invoke.resolve(["value": secret])
  }

  /// Deletes the stored secret. Treats "not found" as success so disabling
  /// biometrics is idempotent.
  @objc public func remove(_ invoke: Invoke) throws {
    let status = SecItemDelete(baseQuery() as CFDictionary)

    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }

    invoke.resolve()
  }

  // MARK: - Key-bytes commands (MLS device key storage)

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
