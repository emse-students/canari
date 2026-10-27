import Photos
import SwiftRs
import Tauri
import UIKit
import WebKit

/// The phone's gallery for CanaReels (C6): a saved reel is added to the Photos library.
///
/// ADD-ONLY ACCESS, never the library: `PHPhotoLibrary.requestAuthorization(for: .addOnly)` asks the
/// member once whether Canari may ADD photos and videos (`NSPhotoLibraryAddUsageDescription`), and it
/// can read nothing back. A refusal is an OUTCOME the screen draws (`status: denied`, with the way
/// to Settings), not a failure. The file must be a container Photos accepts - the reel is the
/// fragmented H.264/AAC MP4 `prepareVideoForUpload` produced, which it does.
class GalleryPlugin: Plugin {
  class SaveVideoArgs: Decodable {
    let path: String
    let name: String
  }

  @objc public func saveVideo(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SaveVideoArgs.self)
    let url = URL(fileURLWithPath: args.path)
    NSLog("[GalleryPlugin] saveVideo %@", args.name)

    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
      guard status == .authorized || status == .limited else {
        NSLog("[GalleryPlugin] saveVideo: add-only access refused (%d)", status.rawValue)
        invoke.resolve(["status": "denied"])
        return
      }
      PHPhotoLibrary.shared().performChanges({
        PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url)
      }) { ok, error in
        if ok {
          NSLog("[GalleryPlugin] saveVideo: saved")
          invoke.resolve(["status": "saved"])
        } else {
          NSLog("[GalleryPlugin] saveVideo failed: %@", error?.localizedDescription ?? "unknown")
          invoke.reject("saveVideo failed: \(error?.localizedDescription ?? "unknown")")
        }
      }
    }
  }

  class ShareTextArgs: Decodable {
    let text: String
  }

  class ShareFileArgs: Decodable {
    let path: String
    let mime: String
  }

  /// The system share sheet on a text: a message, a link.
  @objc public func shareText(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareTextArgs.self)
    NSLog("[GalleryPlugin] shareText: %d chars", args.text.count)
    presentShareSheet(invoke, items: [args.text])
  }

  /// The system share sheet on a file in the cache's `share_out/`. A file URL is shared, so the
  /// receiving app (or Photos, for "Enregistrer l'image") reads the file itself; the type is taken
  /// from its extension.
  @objc public func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFileArgs.self)
    NSLog("[GalleryPlugin] shareFile: %@", args.mime)
    presentShareSheet(invoke, items: [URL(fileURLWithPath: args.path)])
  }

  /// Presents `UIActivityViewController` over the app; resolved once it is shown. On an iPad it is a
  /// popover, which must be anchored or UIKit throws: it is anchored at the centre, with no arrow.
  private func presentShareSheet(_ invoke: Invoke, items: [Any]) {
    DispatchQueue.main.async {
      guard let presenter = self.manager.viewController else {
        NSLog("[GalleryPlugin] share: no view controller to present from")
        invoke.reject("share: no view controller", code: "noPresenter")
        return
      }
      // UIKit refuses to present over a controller that is already presenting, and then never calls
      // the completion: the promise would hang. Refused at once instead, with a code saying why.
      if presenter.presentedViewController != nil {
        NSLog("[GalleryPlugin] share: another sheet is already presented")
        invoke.reject("share: another sheet is already presented", code: "busy")
        return
      }
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
          x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      presenter.present(sheet, animated: true) { invoke.resolve() }
    }
  }

  class ShareTargetArg: Decodable {
    let id: String
    let label: String
    let link: String
  }

  class PublishShareTargetsArgs: Decodable {
    let targets: [ShareTargetArg]
  }

  /// Replaces the conversations the share sheet suggests (`ShareSuggestions.publish`, sharing lot
  /// S5). The labels are conversation names: only their count is logged.
  @objc public func publishShareTargets(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PublishShareTargetsArgs.self)
    NSLog("[GalleryPlugin] publishShareTargets: %d target(s)", args.targets.count)
    let targets = args.targets.map { ShareSuggestions.Target(id: $0.id, label: $0.label) }
    ShareSuggestions.publish(targets) { outcome in
      switch outcome {
      case .success(let published):
        invoke.resolve(["present": published.present, "leftover": published.leftover])
      case .failure(.deleteFailed(let code)):
        invoke.reject("publishShareTargets: the previous suggestions were not deleted", code: "deleteFailed\(code)")
      }
    }
  }

  /// Removes every conversation this app suggested to the share sheet (`ShareSuggestions.clear`).
  @objc public func clearShareTargets(_ invoke: Invoke) {
    NSLog("[GalleryPlugin] clearShareTargets")
    ShareSuggestions.clear { outcome in
      switch outcome {
      case .success(let removed):
        invoke.resolve(["removed": removed])
      case .failure(.deleteFailed(let code)):
        invoke.reject("clearShareTargets: the suggestions were not deleted", code: "deleteFailed\(code)")
      }
    }
  }

  /// This app's page in Settings, where a refused camera, microphone or photo access is given back.
  @objc public func openAppSettings(_ invoke: Invoke) {
    NSLog("[GalleryPlugin] openAppSettings")
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        invoke.reject("openAppSettings: no settings URL")
        return
      }
      UIApplication.shared.open(url, options: [:]) { opened in
        if opened {
          invoke.resolve()
        } else {
          invoke.reject("openAppSettings: the settings page did not open")
        }
      }
    }
  }
}

@_cdecl("init_plugin_gallery")
func initPlugin() -> Plugin {
  return GalleryPlugin()
}
