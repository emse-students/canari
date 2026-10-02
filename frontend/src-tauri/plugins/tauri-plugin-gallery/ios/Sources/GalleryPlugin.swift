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
