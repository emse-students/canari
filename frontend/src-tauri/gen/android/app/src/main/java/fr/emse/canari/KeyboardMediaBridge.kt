package fr.emse.canari

import android.util.Base64
import android.util.Log
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat
import org.json.JSONObject

/**
 * Bridges rich content committed by the soft keyboard (e.g. a Gboard GIF) into the web layer.
 *
 * Android delivers keyboard media through the focused editor's [InputConnection.commitContent].
 * A plain WebView does not advertise image MIME types, so the keyboard never offers a GIF and the
 * commit is dropped. We wrap the WebView's input connection to (1) declare the accepted MIME types
 * and (2) read the committed content URI, then hand the bytes to the frontend as a
 * `canari-keyboard-media` DOM event so it can send them through the normal media pipeline
 * (encrypted upload for DMs/groups and channels alike).
 *
 * All work lives here (a non-generated file); the generated `RustWebView` only delegates one call,
 * so re-applying the patch after a Tauri Android regeneration is a single line.
 */
object KeyboardMediaBridge {
    private const val TAG = "KeyboardMedia"

    /** MIME types offered to the keyboard. Gboard uses these to enable its GIF/sticker commit. */
    private val MIME_TYPES = arrayOf("image/gif", "image/png", "image/jpeg", "image/webp")

    /** Skip payloads too large to bridge as a JS string (Gboard GIFs are far smaller). */
    private const val MAX_BYTES = 12 * 1024 * 1024

    /**
     * Wraps [ic] so the keyboard can commit rich content into [webView]. Returns [ic] unchanged when
     * it is null (no editable focus).
     */
    fun wrapInputConnection(
        webView: WebView,
        ic: InputConnection?,
        editorInfo: EditorInfo,
    ): InputConnection? {
        if (ic == null) return null
        EditorInfoCompat.setContentMimeTypes(editorInfo, MIME_TYPES)
        return InputConnectionCompat.createWrapper(ic, editorInfo) { info, flags, _ ->
            handleCommit(webView, info, flags)
        }
    }

    /**
     * Reads the committed content off the UI thread and dispatches it to the web layer. Returns true
     * so the keyboard treats the content as consumed (we never let it fall back to the editor).
     */
    private fun handleCommit(
        webView: WebView,
        info: InputContentInfoCompat,
        flags: Int,
    ): Boolean {
        if ((flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
            try {
                info.requestPermission()
            } catch (e: Exception) {
                Log.w(TAG, "requestPermission failed: ${e.message}")
                return false
            }
        }

        Thread({
            try {
                val uri = info.contentUri
                val resolver = webView.context.contentResolver
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                if (bytes == null || bytes.isEmpty()) {
                    Log.w(TAG, "empty content for $uri")
                    return@Thread
                }
                if (bytes.size > MAX_BYTES) {
                    Log.w(TAG, "content too large (${bytes.size} bytes) - skipped")
                    return@Thread
                }
                val mime = resolver.getType(uri)
                    ?: info.description.getMimeType(0)
                    ?: "image/gif"
                val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
                    ?: "keyboard-${System.currentTimeMillis()}.${mime.substringAfterLast('/')}"
                val dataB64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                dispatchToWeb(webView, mime, name, dataB64)
            } catch (e: Exception) {
                Log.e(TAG, "handleCommit failed: ${e.message}")
            } finally {
                try {
                    info.releasePermission()
                } catch (_: Exception) {
                }
            }
        }, "canari-keyboard-media").start()

        return true
    }

    /** Dispatches the committed media to the frontend as a `canari-keyboard-media` DOM event. */
    private fun dispatchToWeb(webView: WebView, mime: String, name: String, dataB64: String) {
        // JSONObject.toString() is valid JS; base64 contains no characters needing extra escaping.
        val detail = JSONObject()
            .put("mime", mime)
            .put("name", name)
            .put("data", dataB64)
            .toString()
        val script =
            "window.dispatchEvent(new CustomEvent('canari-keyboard-media',{detail:$detail}))"
        webView.post {
            webView.evaluateJavascript(script, null)
        }
    }
}
