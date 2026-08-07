package app.tauri.customtabs

import android.app.Activity
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

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
    @Command
    fun openCustomTab(invoke: Invoke) {
        val args = invoke.parseArgs(OpenCustomTabArgs::class.java)
        try {
            val customTabsIntent = CustomTabsIntent.Builder().build()
            customTabsIntent.launchUrl(activity, Uri.parse(args.url))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("openCustomTab failed: ${e.message}")
        }
    }
}
