/* THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!! */

// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

package fr.emse.canari

import android.net.Uri
import android.webkit.*
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import androidx.webkit.WebViewAssetLoader

class RustWebViewClient(context: Context): WebViewClient() {
    private val interceptedState = mutableMapOf<String, Boolean>()
    var currentUrl: String = "about:blank"
    private var lastInterceptedUrl: Uri? = null
    private var pendingUrlRedirect: String? = null

    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain(assetLoaderDomain())
        .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        pendingUrlRedirect?.let {
            Handler(Looper.getMainLooper()).post {
              view.loadUrl(it)
            }
            pendingUrlRedirect = null
            return null
        }

        lastInterceptedUrl = request.url
        return if (withAssetLoader()) {
            assetLoader.shouldInterceptRequest(request.url)
        } else {
            val rustWebview = view as RustWebView;
            val response = handleRequest(rustWebview.id, request, rustWebview.isDocumentStartScriptEnabled)
            interceptedState[request.url.toString()] = response != null
            return response
        }
    }

    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest
    ): Boolean {
        return shouldOverride(request.url.toString())
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        currentUrl = url
        if (interceptedState[url] == false) {
            val webView = view as RustWebView
            for (script in webView.initScripts) {
                view.evaluateJavascript(script, null)
            }
        }
        return onPageLoading(url)
    }

    override fun onPageFinished(view: WebView, url: String) {
        onPageLoaded(url)
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        // shouldInterceptRequest is not called on server-side redirects from external pages,
        // so if the redirect target is tauri.localhost the WebView fails with a network error.
        // We force-retry with loadUrl() so shouldInterceptRequest fires for the target URL.
        if (request.isForMainFrame && request.url != lastInterceptedUrl) {
            when (error.errorCode) {
                ERROR_CONNECT -> {
                    // ERR_CONNECTION_REFUSED — external URL redirects to custom protocol (physical device)
                    view.stopLoading()
                    view.loadUrl(request.url.toString())
                    // pendingUrlRedirect guards against a race condition specific to ERROR_CONNECT
                    pendingUrlRedirect = request.url.toString()
                }
                ERROR_HOST_LOOKUP -> {
                    // ERR_NAME_NOT_RESOLVED — emulator can't DNS-resolve tauri.localhost from an
                    // external HTTPS redirect. A simple loadUrl() is enough; setting pendingUrlRedirect
                    // here would schedule a second load of the same URL (e.g. /auth/callback?code=X),
                    // consuming the OAuth code twice and causing invalid_grant on the second attempt.
                    view.stopLoading()
                    view.loadUrl(request.url.toString())
                }
                else -> super.onReceivedError(view, request, error)
            }
        } else {
            super.onReceivedError(view, request, error)
        }
    }

    companion object {
        init {
            System.loadLibrary("mines_app_lib")
        }
    }

    private external fun assetLoaderDomain(): String
    private external fun withAssetLoader(): Boolean
    private external fun handleRequest(webviewId: String, request: WebResourceRequest, isDocumentStartScriptEnabled: Boolean): WebResourceResponse?
    private external fun shouldOverride(url: String): Boolean
    private external fun onPageLoading(url: String)
    private external fun onPageLoaded(url: String)

    
}
