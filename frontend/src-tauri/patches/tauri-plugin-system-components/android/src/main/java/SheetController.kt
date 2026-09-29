package com.sosweetham.systemcomponents

import android.app.Activity
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Base64
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetDialog
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONObject

/** Interaction callbacks the plugin maps 1:1 to Tauri `trigger(...)` events. */
internal class SheetCallbacks(
    val onRow: (rowId: String) -> Unit,
    val onField: (rowId: String, value: String) -> Unit,
    val onSubmit: (rowId: String, valuesJson: String) -> Unit,
    val onDismissed: () -> Unit,
)

/**
 * A native Material bottom sheet that renders the same row vocabulary as the iOS
 * `SheetController` (header / action / text / textfield / toggle / datetime /
 * select / submit). Single responsibility: present rows + track form state +
 * report interactions via [SheetCallbacks]. The plugin owns the Tauri bridge.
 */
internal class SheetController(
    activity: Activity,
    tint: String?,
    rows: List<SheetRowArg>,
    private val callbacks: SheetCallbacks,
) {
    private val ctx = ContextThemeWrapper(activity, MATERIAL_THEME)
    private val accent: Int = parseHexColor(tint) ?: DEFAULT_ACCENT
    /** Live form state by row id — seeded from initial values, emitted on submit. */
    private val values = LinkedHashMap<String, String>()
    private val dialog = BottomSheetDialog(ctx)
    private val container =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(20))
        }

    init {
        dialog.setContentView(ScrollView(ctx).apply { addView(container) })
        dialog.setOnDismissListener { callbacks.onDismissed() }
        render(rows)
    }

    val isShowing: Boolean
        get() = dialog.isShowing

    fun show() = dialog.show()

    fun dismiss() = dialog.dismiss()

    /** Re-render in place (e.g. a badge count changed) without reopening. */
    fun update(rows: List<SheetRowArg>) = render(rows)

    // ── Rendering ────────────────────────────────────────────────────────────

    private fun render(rows: List<SheetRowArg>) {
        seedValues(rows)
        container.removeAllViews()
        for (r in rows) {
            val view =
                when (kindOf(r)) {
                    "header" -> headerRow(r)
                    "text" -> textRow(r)
                    "textfield" -> textFieldRow(r)
                    "toggle" -> toggleRow(r)
                    "datetime" -> dateTimeRow(r)
                    "select" -> selectRow(r)
                    "submit" -> submitRow(r)
                    else -> actionRow(r) // "action"
                }
            container.addView(view)
        }
    }

    private fun kindOf(r: SheetRowArg): String =
        r.kind ?: if (r.header == true) "header" else "action"

    private fun seedValues(rows: List<SheetRowArg>) {
        for (r in rows) {
            if (values.containsKey(r.id)) continue
            when (kindOf(r)) {
                "toggle" -> values[r.id] = if (r.on == true) "true" else "false"
                "textfield", "datetime" -> r.value?.let { values[r.id] = it }
                // The button shows the first option when nothing is chosen, so seed
                // that value too — otherwise submit misses the field until the user
                // re-selects it manually.
                "select" ->
                    (r.value ?: r.options?.firstOrNull()?.value)?.let { values[r.id] = it }
            }
        }
    }

    private fun headerRow(r: SheetRowArg): View {
        val row = rowBase(clickable = false)
        val bmp = decodeImage(r.image)
        if (bmp != null) {
            row.addView(
                ImageView(ctx).apply {
                    setImageBitmap(bmp)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    layoutParams =
                        LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(12) }
                },
            )
        } else {
            leadingGlyph(r.sfSymbol, 22f)?.let { row.addView(it) }
        }
        val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        col.addView(
            TextView(ctx).apply {
                text = r.label
                textSize = 17f
                setTypeface(typeface, Typeface.BOLD)
            },
        )
        r.detail?.let { col.addView(mutedText(it, 13f)) }
        row.addView(col)
        return row
    }

    private fun actionRow(r: SheetRowArg): View {
        val row = rowBase(clickable = true)
        leadingGlyph(r.sfSymbol)?.let { row.addView(it) }
        row.addView(
            TextView(ctx).apply {
                text = r.label
                textSize = 16f
                layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
                if (r.destructive == true) setTextColor(DESTRUCTIVE)
            },
        )
        r.badge?.let { row.addView(badgeView(it)) }
        row.setOnClickListener { callbacks.onRow(r.id) }
        return row
    }

    private fun textRow(r: SheetRowArg): View {
        val col = columnBase()
        col.addView(mutedText(r.label, 14f, 0.85f))
        r.detail?.let { col.addView(mutedText(it, 12f, 0.55f)) }
        return col
    }

    private fun textFieldRow(r: SheetRowArg): View {
        val col = columnBase()
        col.addView(mutedText(r.label, 13f, 0.7f))
        val et =
            EditText(ctx).apply {
                setText(values[r.id] ?: "")
                hint = r.placeholder ?: ""
                inputType = InputType.TYPE_CLASS_TEXT
                setSingleLine(true)
            }
        et.addTextChangedListener(
            object : TextWatcher {
                override fun afterTextChanged(s: Editable?) {
                    val v = s?.toString() ?: ""
                    values[r.id] = v
                    callbacks.onField(r.id, v)
                }

                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}

                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            },
        )
        col.addView(et)
        return col
    }

    private fun toggleRow(r: SheetRowArg): View {
        val row = rowBase(clickable = false)
        row.addView(flexLabel(r.label))
        val sw = Switch(ctx).apply { isChecked = values[r.id] == "true" }
        sw.setOnCheckedChangeListener { _, checked ->
            val v = checked.toString()
            values[r.id] = v
            callbacks.onField(r.id, v)
        }
        row.addView(sw)
        return row
    }

    private fun dateTimeRow(r: SheetRowArg): View {
        val row = rowBase(clickable = false)
        row.addView(flexLabel(r.label))
        val btn = Button(ctx).apply { isAllCaps = false }
        fun refresh() {
            btn.text = values[r.id]?.let { localLabel(it) } ?: "Choose…"
        }
        refresh()
        btn.setOnClickListener {
            pickDateTime(values[r.id]) { iso ->
                values[r.id] = iso
                callbacks.onField(r.id, iso)
                refresh()
            }
        }
        row.addView(btn)
        return row
    }

    private fun selectRow(r: SheetRowArg): View {
        val row = rowBase(clickable = false)
        row.addView(flexLabel(r.label))
        val opts = r.options ?: emptyList()
        val btn = Button(ctx).apply { isAllCaps = false }
        fun labelFor(value: String?): String =
            opts.firstOrNull { it.value == value }?.label ?: opts.firstOrNull()?.label ?: ""
        btn.text = labelFor(values[r.id])
        btn.setOnClickListener {
            val pm = PopupMenu(ctx, btn)
            opts.forEachIndexed { i, o -> pm.menu.add(0, i, i, o.label) }
            pm.setOnMenuItemClickListener { mi ->
                val o = opts[mi.itemId]
                values[r.id] = o.value
                callbacks.onField(r.id, o.value)
                btn.text = o.label
                true
            }
            pm.show()
        }
        row.addView(btn)
        return row
    }

    private fun submitRow(r: SheetRowArg): View {
        val btn =
            Button(ctx).apply {
                text = r.label
                isAllCaps = false
                setTextColor(Color.WHITE)
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(14).toFloat()
                        setColor(accent)
                    }
                layoutParams =
                    LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                        setMargins(dp(16), dp(10), dp(16), dp(6))
                    }
            }
        btn.setOnClickListener { callbacks.onSubmit(r.id, valuesJson()) }
        return btn
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    private fun rowBase(clickable: Boolean): LinearLayout =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            if (clickable) {
                isClickable = true
                isFocusable = true
                val tv = TypedValue()
                context.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
                if (tv.resourceId != 0) setBackgroundResource(tv.resourceId)
            }
        }

    private fun columnBase(): LinearLayout =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(8))
        }

    private fun flexLabel(text: String): TextView =
        TextView(ctx).apply {
            this.text = text
            textSize = 16f
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        }

    /** A leading icon for an SF Symbol name (Android has no SF Symbols, so we map
     *  the small set the app uses to glyphs). Returns null for unmapped names. */
    private fun leadingGlyph(sfSymbol: String?, size: Float = 17f): TextView? {
        val glyph = glyphFor(sfSymbol) ?: return null
        return TextView(ctx).apply {
            text = glyph
            textSize = size
            gravity = Gravity.CENTER
            layoutParams =
                LinearLayout.LayoutParams(dp(28), WRAP_CONTENT).apply { marginEnd = dp(10) }
        }
    }

    private fun mutedText(text: String, size: Float, alphaValue: Float = 0.6f): TextView =
        TextView(ctx).apply {
            this.text = text
            textSize = size
            alpha = alphaValue
        }

    private fun badgeView(text: String): TextView =
        TextView(ctx).apply {
            this.text = text
            textSize = 11f
            setTextColor(Color.WHITE)
            setPadding(dp(7), dp(2), dp(7), dp(2))
            background =
                GradientDrawable().apply {
                    cornerRadius = dp(10).toFloat()
                    setColor(accent)
                }
        }

    private fun valuesJson(): String {
        val obj = JSONObject()
        for ((k, v) in values) obj.put(k, v)
        return obj.toString()
    }

    private fun pickDateTime(currentIso: String?, onPicked: (String) -> Unit) {
        val cal = Calendar.getInstance()
        currentIso?.let { parseIso(it)?.let { d -> cal.time = d } }
        DatePickerDialog(
            ctx,
            { _, year, month, day ->
                TimePickerDialog(
                    ctx,
                    { _, hour, minute ->
                        val picked = Calendar.getInstance()
                        picked.set(year, month, day, hour, minute, 0)
                        picked.set(Calendar.MILLISECOND, 0)
                        onPicked(isoUtc(picked.time))
                    },
                    cal.get(Calendar.HOUR_OF_DAY),
                    cal.get(Calendar.MINUTE),
                    false,
                )
                    .show()
            },
            cal.get(Calendar.YEAR),
            cal.get(Calendar.MONTH),
            cal.get(Calendar.DAY_OF_MONTH),
        )
            .show()
    }

    private fun dp(value: Int): Int = (value * ctx.resources.displayMetrics.density).toInt()

    private fun localLabel(iso: String): String {
        val d = parseIso(iso) ?: return iso
        return SimpleDateFormat("EEE, MMM d · h:mm a", Locale.getDefault()).format(d)
    }

    companion object {
        private val DEFAULT_ACCENT = 0xFFE8743B.toInt() // Pendi clementine fallback
        private val DESTRUCTIVE = 0xFFE5484D.toInt()
        private val MATERIAL_THEME = com.google.android.material.R.style.Theme_Material3_DayNight
        private const val MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4 MB — row icons are small

        /** SF Symbol name → a glyph for the row's leading icon (the app's set). */
        private fun glyphFor(sf: String?): String? =
            when (sf) {
                "plus" -> "＋"
                "bell", "bell.fill" -> "🔔"
                "newspaper", "newspaper.fill" -> "📰"
                "gearshape" -> "⚙"
                "heart" -> "❤"
                "arrow.clockwise" -> "↻"
                "rectangle.portrait.and.arrow.right" -> "⎋"
                "calendar.badge.clock" -> "🗓"
                "person.crop.circle.fill" -> "👤"
                else -> null
            }

        private fun isoUtc(d: Date): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            return fmt.format(d)
        }

        private fun parseIso(s: String): Date? =
            try {
                val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                fmt.timeZone = TimeZone.getTimeZone("UTC")
                fmt.parse(s)
            } catch (e: Exception) {
                null
            }

        /** `#RRGGBB` / `#RRGGBBAA` → Android ARGB int (it wants `#AARRGGBB`). */
        private fun parseHexColor(hex: String?): Int? {
            if (hex.isNullOrBlank()) return null
            return try {
                var s = hex.trim()
                if (!s.startsWith("#")) s = "#$s"
                if (s.length == 9) {
                    val rgb = s.substring(1, 7)
                    val a = s.substring(7, 9)
                    s = "#$a$rgb"
                }
                Color.parseColor(s)
            } catch (e: Exception) {
                null
            }
        }

        private fun decodeImage(src: String?): Bitmap? {
            if (src.isNullOrBlank()) return null
            return try {
                val base64 = if (src.contains(",")) src.substringAfter(",") else src
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                // Guard against an oversized payload OOMing the decode (row icons
                // are tiny; anything bigger is malformed/hostile).
                if (bytes.size > MAX_IMAGE_BYTES) return null
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } catch (e: Exception) {
                null
            }
        }
    }
}
