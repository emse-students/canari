package fr.emse.canari.share

/**
 * The file name a shared stream is stored and offered under, made from the name the SENDER chose.
 *
 * That name is untrusted input: it is reduced to its last path segment (no `../` can climb out of
 * the share's directory), to a conservative character set, and to 100 characters; leading and
 * trailing dots and spaces go, so no hidden or empty name remains. When nothing is left, a generic
 * name is made from the mime type. No Android import: `android-tests` compiles this package.
 */
object SharedFileName {
    private val UNSAFE = Regex("[^A-Za-z0-9._ -]")

    fun sanitise(raw: String?, mime: String): String {
        val base = raw.orEmpty()
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace(UNSAFE, "_")
            .trim('.', ' ')
            .take(100)
        if (base.isNotEmpty()) return base
        val extension = mime.substringAfter('/', "").takeWhile { it.isLetterOrDigit() }.ifEmpty { "bin" }
        return "shared.$extension"
    }
}
