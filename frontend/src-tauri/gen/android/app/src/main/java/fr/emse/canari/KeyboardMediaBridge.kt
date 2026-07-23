package fr.emse.canari

import android.net.Uri
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import org.json.JSONObject

/**
 * Bridges rich content committed by the soft keyboard (e.g. a Gboard GIF) into the web layer.
 *
 * Android delivers keyboard media through the focused editor's [InputConnection.commitContent].
 * A plain WebView does not advertise image MIME types, so the keyboard never offers a GIF and the
 * commit is dropped. We use the modern receive-content pipeline: an [ViewCompat.setOnReceiveContentListener]
 * on the WebView plus the view-based [InputConnectionCompat.createWrapper] overload, which routes
 * keyboard commits (with URI permissions already requested by the compat layer) to the listener.
 * The listener reads the committed content URI and hands the bytes to the frontend as a
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
     * it is null (no editable focus). Re-registering the listener on every call is idempotent.
     */
    fun wrapInputConnection(
        webView: WebView,
        ic: InputConnection?,
        editorInfo: EditorInfo,
    ): InputConnection? {
        if (ic == null) return null
        EditorInfoCompat.setContentMimeTypes(editorInfo, MIME_TYPES)
        ViewCompat.setOnReceiveContentListener(webView, MIME_TYPES) { view, payload ->
            handleReceive(view, payload)
        }
        return InputConnectionCompat.createWrapper(webView, ic, editorInfo)
    }

    /**
     * Receives content routed by the compat wrapper. Only keyboard commits are handled (drag & drop
     * and other sources pass through untouched, preserving the WebView default behavior). Returns
     * null for consumed payloads per the [androidx.core.view.OnReceiveContentListener] contract.
     */
    private fun handleReceive(view: View, payload: ContentInfoCompat): ContentInfoCompat? {
        if (payload.source != ContentInfoCompat.SOURCE_INPUT_METHOD) return payload
        val webView = view as? WebView ?: return payload
        val clip = payload.clip
        val mimeHint = if (clip.description.mimeTypeCount > 0) clip.description.getMimeType(0) else null
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri ?: continue
            readAndDispatch(webView, uri, mimeHint)
        }
        return null
    }

    /**
     * Reads the committed content off the UI thread and dispatches it to the web layer. URI read
     * permission was already requested by the compat layer before the listener fired.
     */
    private fun readAndDispatch(webView: WebView, uri: Uri, mimeHint: String?) {
        Thread({
            try {
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
                val mime = resolver.getType(uri) ?: mimeHint ?: "image/gif"
                val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
                    ?: "keyboard-${System.currentTimeMillis()}.${mime.substringAfterLast('/')}"
                val dataB64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                dispatchToWeb(webView, mime, name, dataB64)
            } catch (e: Exception) {
                Log.e(TAG, "readAndDispatch failed: ${e.message}")
            }
        }, "canari-keyboard-media").start()
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
