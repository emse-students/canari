//
//  KeyboardViewportGuard.swift
//  tauri-plugin-system-components
//
//  Keeps the webview's layout viewport honest across keyboard transitions.
//
//  While a text field is focused, WebKit shrinks the webview's LAYOUT viewport
//  by the height of the input accessory bar (the "^ v … Done" toolbar) — not
//  just the visual viewport. `window.innerHeight`, `100dvh` and the containing
//  block of every `position: fixed` element all lose those points, which is
//  correct while the bar is on screen. What is not correct is that iOS
//  frequently never gives them back: dismissing the keyboard leaves the layout
//  viewport short (44pt with a hardware keyboard, 53pt with the software one),
//  and it stays short for the life of the web view — reloading the page does
//  not clear it, because the state lives in the native view, not the document.
//
//  Everything anchored to the bottom then floats that far above the screen: a
//  bottom nav bar hovers over a band of dead space, a `100dvh` pane strands the
//  composer pinned to its bottom, and no CSS can reach the gap, because content
//  below the layout viewport is clipped rather than drawn.
//
//  There is no web-facing API for any of this, so restore it from here: once
//  the keyboard has actually left, hand WebKit a size it has not seen and put
//  the real one straight back. That round trip is what makes it re-measure and
//  republish the full height to the web process.
//

import Foundation
import UIKit
import WebKit

final class KeyboardViewportGuard {
    private weak var webView: WKWebView?
    private var observers: [NSObjectProtocol] = []
    /// The queued restore, held so a keyboard that comes back can cancel it.
    private var queued: DispatchWorkItem?
    /// Whether a keyboard or accessory bar is currently on screen. The restore
    /// is only ever correct while this is false.
    private var keyboardUp = false

    init(webView: WKWebView) {
        self.webView = webView
        let center = NotificationCenter.default

        // A keyboard on its way back in: whatever we had queued is now wrong,
        // because the short viewport is about to be the truth again.
        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main
            ) { [weak self] _ in self?.keyboardUp = true; self?.cancelRestore() }
        )

        // `didHide`, not `willHide`: the shrink outlives the dismissal
        // animation, so nudging before it ends is simply undone by its end.
        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.keyboardUp = false
                self?.scheduleRestore()
            }
        )

        // With a hardware keyboard attached, only the accessory bar appears and
        // leaves — there is no show/hide pair, just frame changes. Restore only
        // when the end frame has parked off the bottom of the screen; a frame
        // change that leaves it on screen means the bar is still there and the
        // short viewport is, for now, the truth.
        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardDidChangeFrameNotification, object: nil, queue: .main
            ) { [weak self] note in
                guard let self else { return }
                guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
                    as? NSValue
                else { return }
                if self.isOffScreen(end.cgRectValue) {
                    self.keyboardUp = false
                    self.scheduleRestore()
                } else {
                    self.keyboardUp = true
                    self.cancelRestore()
                }
            }
        )
    }

    deinit {
        let center = NotificationCenter.default
        for observer in observers { center.removeObserver(observer) }
    }

    /// Is this keyboard frame parked below the bottom edge (i.e. gone)? The
    /// notification reports it in screen coordinates, so bring it into the
    /// window's before comparing.
    private func isOffScreen(_ frameInScreen: CGRect) -> Bool {
        if frameInScreen.isEmpty { return true }
        guard let window = webView?.window else { return false }
        return window.convert(frameInScreen, from: nil).minY >= window.bounds.maxY - 1
    }

    private func cancelRestore() {
        queued?.cancel()
        queued = nil
    }

    /// Coalesce the burst of notifications one dismissal emits, and let UIKit
    /// finish its own layout pass before we touch the geometry. The keyboard can
    /// come back inside that window — cancelled above when it does, and checked
    /// again here in case the work item was already dequeued, because resizing
    /// the webview under a keyboard that is up would republish a height the
    /// keyboard is covering.
    private func scheduleRestore() {
        guard queued == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.queued = nil
            guard !self.keyboardUp else { return }
            self.restore()
        }
        queued = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private func restore() {
        guard let webView, webView.window != nil else { return }
        let frame = webView.frame
        guard frame.height > 1 else { return }
        // A height WebKit has not seen, applied and reverted within one run-loop
        // turn so nothing paints in between. The `layoutIfNeeded` after each
        // assignment is what stops the two from coalescing into no change at all.
        webView.frame = frame.insetBy(dx: 0, dy: 0.5)
        webView.layoutIfNeeded()
        webView.frame = frame
        webView.layoutIfNeeded()
    }
}
