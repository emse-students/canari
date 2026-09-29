package com.sosweetham.systemcomponents

import android.app.Activity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
internal class SheetOptionArg {
    lateinit var value: String
    lateinit var label: String
}

@InvokeArg
internal class SheetRowArg {
    lateinit var id: String
    var kind: String? = null
    var label: String = ""
    var detail: String? = null
    var image: String? = null
    var sfSymbol: String? = null
    var badge: String? = null
    var destructive: Boolean? = null
    var header: Boolean? = null
    var value: String? = null
    var on: Boolean? = null
    var placeholder: String? = null
    var options: List<SheetOptionArg>? = null
}

@InvokeArg
internal class PresentSheetArgs {
    lateinit var id: String
    var tint: String? = null
    var rows: List<SheetRowArg> = emptyList()
}

@InvokeArg
internal class DismissSheetArgs {
    lateinit var id: String
}

/**
 * Android implementation of the system-components plugin. Only the **sheet**
 * surface is native here (a Material `BottomSheetDialog`, see [SheetController]);
 * the tab-bar / floating-component commands are iOS-only and never reach
 * Android — the Rust layer rejects them with `Unsupported`, so the web app keeps
 * its HTML pill there.
 *
 * Events mirror iOS exactly so the shared guest-js listeners work unchanged:
 *   `sheetRow {sheetId,rowId}` · `sheetField {sheetId,rowId,value}` ·
 *   `sheetSubmit {sheetId,rowId,values}` · `sheetDismissed {sheetId}`.
 */
@TauriPlugin
class SystemComponentsPlugin(private val activity: Activity) : Plugin(activity) {
    private val sheets = HashMap<String, SheetController>()
    private var cleanupHooked = false

    /**
     * Dismiss any open sheets when the host activity is destroyed — otherwise the
     * dialogs leak their window and the controllers dangle. Registered once,
     * lazily, the first time a sheet is presented. Clearing `sheets` before
     * dismissing avoids the dismiss listener mutating the map mid-iteration.
     */
    private fun ensureCleanup() {
        if (cleanupHooked) return
        val owner = activity as? LifecycleOwner ?: return
        cleanupHooked = true
        owner.lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onDestroy(owner: LifecycleOwner) {
                    val open = sheets.values.toList()
                    sheets.clear()
                    for (controller in open) runCatching { controller.dismiss() }
                }
            },
        )
    }

    @Command
    fun presentSheet(invoke: Invoke) {
        val args = invoke.parseArgs(PresentSheetArgs::class.java)
        activity.runOnUiThread {
            ensureCleanup()
            try {
                val existing = sheets[args.id]
                if (existing != null && existing.isShowing) {
                    // Already up — refresh the rows in place (matches iOS).
                    existing.update(args.rows)
                    invoke.resolve()
                    return@runOnUiThread
                }
                val controller =
                    SheetController(
                        activity,
                        args.tint,
                        args.rows,
                        SheetCallbacks(
                            onRow = { rowId ->
                                emit("sheetRow", payload(args.id).put("rowId", rowId))
                            },
                            onField = { rowId, value ->
                                emit(
                                    "sheetField",
                                    payload(args.id).put("rowId", rowId).put("value", value),
                                )
                            },
                            onSubmit = { rowId, values ->
                                emit(
                                    "sheetSubmit",
                                    payload(args.id).put("rowId", rowId).put("values", values),
                                )
                            },
                            onDismissed = {
                                sheets.remove(args.id)
                                emit("sheetDismissed", payload(args.id))
                            },
                        ),
                    )
                sheets[args.id] = controller
                controller.show()
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: "presentSheet failed")
            }
        }
    }

    @Command
    fun dismissSheet(invoke: Invoke) {
        val args = invoke.parseArgs(DismissSheetArgs::class.java)
        activity.runOnUiThread {
            sheets.remove(args.id)?.dismiss()
            invoke.resolve()
        }
    }

    private fun payload(sheetId: String): JSObject = JSObject().put("sheetId", sheetId)

    private fun emit(event: String, data: JSObject) = trigger(event, data)
}
