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

/// Reason shown in the Face ID / Touch ID system sheet on retrieve. French to
/// match the app's French-first copy and the Android prompt strings; a per-locale
/// pass is tracked as a follow-up (see CLAUDE.md iOS WP-iOS-10).
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
    query[kSecUseAuthenticationContext as String] = context
    query[kSecUseOperationPrompt as String] = kBiometricReason

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
}

  // MARK: - Key-bytes commands (MLS device key storage)

  /// Request to store a raw 32-byte key in the Keychain.
  class StoreKeyBytesRequest: Decodable {
    let alias: String
    let keyBytes: String  // base64-encoded
  }

  /// Request to retrieve a raw key by alias.
  class GetKeyBytesRequest: Decodable {
    let alias: String
  }

  /// Request to delete a raw key by alias.
  class DeleteKeyBytesRequest: Decodable {
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

    // Delete any existing entry for this alias.
    let deleteQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    // Add the new entry.
    var addQuery: [String: Any] = [
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
    invoke.resolve()
  }

  /// Retrieves a raw key by alias. Triggers a Face ID / Touch ID prompt.
  /// Returns `{"keyBytes": "<base64>"}` on success, or
  /// `{"keyBytes": null}` if the key is not found.
  @objc public func getKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GetKeyBytesRequest.self)

    let context = LAContext()
    context.localizedReason = kBiometricReason
    context.interactionNotAllowed = false

    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: kKeychainService,
      kSecAttrAccount as String: "mls_key_\(args.alias)",
      kSecReturnData as String: true,
      kSecUseAuthenticationContext as String: context,
      kSecUseOperationPrompt as String: kBiometricReason,
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

    invoke.resolve()
  }
}

@_cdecl("init_plugin_keystore")
func initPlugin() -> Plugin {
  return KeystorePlugin()
}
