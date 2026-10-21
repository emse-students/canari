package fr.emse.canari.share

/**
 * The rules a share INTO Canari is copied under, kept apart from `IncomingShare` so the JVM suite
 * (`android-tests`) pins them. No Android import: that suite compiles this package.
 */
object ShareRules {
    /** At most this many files are kept from one share; the rest are counted as refused. */
    const val MAX_FILES = 10

    /**
     * Per-file ceiling. Above the server's own, because a video is re-encoded on the phone before
     * upload, so its shared size is not its sent size; bounded, because the page reads each kept
     * file WHOLE into memory when it stages it, exactly as a picked file is read.
     */
    const val MAX_FILE_BYTES = 200L * 1024 * 1024

    /** Ceiling for the whole share, for the same reason: everything kept is read at staging. */
    const val MAX_TOTAL_BYTES = 300L * 1024 * 1024

    /**
     * How many bytes the next file may take, given what the share has already kept: the smaller of
     * the per-file ceiling and what is left of the total. Zero or less means it is refused unread.
     */
    fun nextFileCeiling(keptSoFar: Long): Long = minOf(MAX_FILE_BYTES, MAX_TOTAL_BYTES - keptSoFar)

    /**
     * Whether a shared `content://` authority is one of THIS app's own providers.
     *
     * A sender may name any URI, including one of ours - our FileProvider exposes parts of our
     * cache, where decrypted media is staged. Reading it back would copy our own private file into
     * a share on the sender's say-so (a confused deputy), so our own authorities are refused: the
     * package name itself, or anything under it (`<package>.fileprovider`).
     */
    fun isOwnAuthority(authority: String?, packageName: String): Boolean {
        if (authority.isNullOrEmpty()) return true
        return authority.split(';').any { it == packageName || it.startsWith("$packageName.") }
    }

    /**
     * Whether `uri` falls under a grant this app HOLDS (a persisted URI permission): the sender would
     * otherwise read, through us, a document the member gave to Canari and not to it. Compared as
     * strings, a granted tree covering everything beneath it.
     */
    fun coveredByHeldGrant(uri: String, heldGrants: List<String>): Boolean =
        heldGrants.any { granted -> uri == granted || uri.startsWith("$granted/") || uri.startsWith("$granted%2F") }
}
