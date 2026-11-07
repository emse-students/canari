package app.tauri.customtabs

import android.app.Activity
import android.net.Uri
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "CustomTabsPlugin"

@TauriPlugin
class CustomTabsPlugin(private val activity: Activity) : Plugin(activity) {
    @InvokeArg
    class OpenCustomTabArgs {
        lateinit var url: String
    }

    /// Opens `url` in a Chrome Custom Tab bound to this Activity's task (WP-OIDC-TAB-1).
    ///
    /// Unlike the plain ACTION_VIEW launch tauri-plugin-opener performs, a Custom Tab is closed
    /// by the OS automatically once the launching Activity returns to the foreground - which is
    /// exactly what happens when the OIDC deep-link callback (`fr.emse.canari://callback`) brings
    /// this app back. Nothing on our side has to track or dismiss the tab.
    ///
    /// Answers `{ outcome: "handedOff" }` - the same typed contract as the iOS session
    /// (`CustomTabOutcome` in `src/models.rs`). The tab is another activity the OS owns, so its
    /// end is not this plugin's to see: it IS the app's foreground edge, which the login page
    /// already observes, whether the user signed in or closed the tab.
    @Command
    fun openCustomTab(invoke: Invoke) {
        val args = invoke.parseArgs(OpenCustomTabArgs::class.java)
        // The URL is never logged: it carries the OIDC state and the PKCE challenge.
        try {
            val customTabsIntent = CustomTabsIntent.Builder().build()
            customTabsIntent.launchUrl(activity, Uri.parse(args.url))
            Log.d(TAG, "openCustomTab: tab launched, handed off to the OS")
            val result = JSObject()
            result.put("outcome", "handedOff")
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.w(TAG, "openCustomTab failed: ${e.javaClass.simpleName}")
            invoke.reject("openCustomTab failed: ${e.message}")
        }
    }
}
