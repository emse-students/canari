# Tauri Plugin Keystore

[![semantic-release: angular](https://img.shields.io/badge/semantic--release-angular-e10079?logo=semantic-release)](https://github.com/semantic-release/semantic-release)
![Crates.io Version](https://img.shields.io/crates/v/tauri-plugin-keystore)
![NPM Version](https://img.shields.io/npm/v/%40impierce%2Ftauri-plugin-keystore)

---

Interact with the device-native key storage (Android Keystore, iOS Keychain).

> [!NOTE]  
> This plugin is scoped to interact with the device-specific keystore. It assumes that biometrics are set up on the user's device and performs no preflight check before trying to interact with the keystore. You should use the official [biometric plugin](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/biometric) to `checkStatus` before, if you want to make sure (see [Usage](#usage) below).

| Platform | Supported |
| -------- | :-------: |
| Linux    |    ❌     |
| Windows  |    ❌     |
| macOS    |    ❌     |
| Android  |    ✅     |
| iOS      |    ✅     |

## Installation

Add the following to your `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-keystore = "2"
```

Then install the JS guest bindings:

```shell
pnpm add @impierce/tauri-plugin-keystore
```

_This also works for `npm` and `yarn`._

## Requirements

- This plugin requires a **Rust version of 1.77.2 or higher**.
- The minimum supported Tauri version is **2.0.0**.
- Android 9 (**API level 28**) and higher are supported.

## Usage

First you need to register the plugin with your Tauri app:

`src-tauri/src/lib.rs`

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_keystore::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

> [!IMPORTANT]
> **This is Canari's fork, not upstream.** The upstream single-secret API (`store`/`retrieve`/`remove`
> and its npm guest bindings) has been deleted - it had no caller. What remains is the alias-addressed
> key-bytes API below, invoked directly rather than through JavaScript bindings, because the calls that
> matter originate in Rust. See `docs/wiki/frontend/modules/auth.md` for how Canari uses it.

| Command | Prompts? | Purpose |
| --- | :---: | --- |
| `store_key_bytes` | no | Write a raw 32-byte key (base64) under an alias. Runs during PIN login, where a second prompt would be disruptive |
| `get_key_bytes` | **yes** | Read it back. The only command that raises a biometric sheet; the request carries the sheet's localized text |
| `delete_key_bytes` | no | Remove the key. Idempotent |
| `has_key_bytes` | no | Existence check. Must never prompt - it is what decides whether offering biometric unlock makes sense |

On iOS `store_key_bytes` writes a **second** item, `mls_bg_key_<alias>`, with no access control and
`AfterFirstUnlockThisDeviceOnly`, shared through the App Group so the notification extension can
decrypt a push while the screen is locked.

`get_key_bytes` will fail if the device has no biometrics set up, so you should check the biometric status with the official `tauri-plugin-biometric` before using it:

```typescript
import { checkStatus, type Status } from '@tauri-apps/plugin-biometric';

const biometricsStatus: Status = await checkStatus();
assert(biometricsStatus.biometryType !== BiometryType.None);
```

## Release strategy

This plugin is semantically versioned, but there are some caveats:

- Versioning starts at `v2.0.0` to match the Tauri version it supports _(common practice for Tauri plugins)_.
- Breaking changes should be avoided as they would make the plugin go out-of-sync with the Tauri major version.

#### Conflicting release approaches

The next version is determined by `semantic-release` which does [not recommend making commits during the release process](https://semantic-release.gitbook.io/semantic-release/support/faq#making-commits-during-the-release-process-adds-significant-complexity).
When publishing a new npm package to **npmjs.com** this is circumvented by `semantic-release` by pushing the version in the release metadata, so the `version` field in `package.json` is ignored.
However, **crates.io** uses the `version` field from `Cargo.toml` to determine the version. There seems to be no easy way to replace the version number during the publish to **crates.io**.

#### Solution

This repository provides a workaround for this issue by using a **semi-automated** release process which decouples building a new release from pushing it to the package registries:

1. Run the **release --dry-run** Action to let `semantic-release` determine the next version. Take note of the version it produces.

2. Manually update the `version` fields in the `Cargo.toml` and `package.json` files (omit the `"v"`, so just `2.1.0` instead of `v2.1.0`).

3. Commit the changes using the following commit message _(replace the version)_:

```
build: release version v1.1.0-alpha.1
```

4. Open a pull request with the same title as the commit message.

5. After the PR is merged, the actual **release** Action will run which creates a new release on GitHub and adds a git tag.

6. The **publish** Action then publishes the packages to npm and crates.io.

<!-- TODO: possibly `semantic-release-cargo` can solve this problem: https://crates.io/crates/semantic-release-cargo -->
