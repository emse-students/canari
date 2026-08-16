package fr.emse.canari

import android.content.Context
import android.util.Log

private const val TAG = "CanariLocale"

/**
 * A [Context] whose resources resolve in the language CHOSEN IN THE APP.
 *
 * EVERY user-visible string this app shows from native code must go through here. The Français /
 * English toggle in Canari's settings and the phone's system language are two different settings,
 * and only one of them is the user telling THIS app what to speak - so `context.getString(...)`
 * called directly answers the wrong question, silently, and only for the users whose two settings
 * disagree. The choice is mirrored into `push_context.json` by the WebView while the app is open;
 * it is unavailable to a background process otherwise, which is precisely why it is written down.
 *
 * Falls back to [context] - i.e. the OS locale - when nothing has been mirrored yet, which is the
 * state of every device that has not opened the app since this shipped. That is a degraded answer
 * rather than a wrong one, and it corrects itself at the next login.
 *
 * One `push_context.json` read per call, so resolve it ONCE per notification and pass the result
 * down rather than calling it per string.
 */
internal fun appLocaleContext(context: Context): Context {
    val tag = MlsContextLoader.loadPushContext(context)?.locale?.takeIf { it.isNotBlank() }
        ?: return context
    return try {
        val config = android.content.res.Configuration(context.resources.configuration)
        config.setLocale(java.util.Locale.forLanguageTag(tag))
        context.createConfigurationContext(config)
    } catch (e: Exception) {
        Log.w(TAG, "appLocaleContext: cannot apply locale '$tag' - falling back to the system one: ${e.message}")
        context
    }
}
