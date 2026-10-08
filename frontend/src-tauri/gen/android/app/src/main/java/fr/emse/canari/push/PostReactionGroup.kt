package fr.emse.canari.push

/**
 * WHO HAS REACTED TO ONE POST, AND HOW THAT READS - as pure functions (user, 2026-10-08).
 *
 * Six reactions to one post used to be six notifications, each alone and each faceless. They are now
 * ONE notification per post that is updated in place, and this is the part of it that needs nothing
 * from Android: the ledger of actors, the shape of the sentence ("A", "A and B", "A, B and C",
 * "A, B and N others") and which faces to draw.
 *
 * **THE LEDGER IS DURABLE STATE, NEVER A CLOCK.** Whether a new reaction joins the group or starts a
 * new one is decided by the caller from the SHADE (is the notification still posted?), which is the
 * one fact that survives a swipe, a tap and a process death. Nothing here asks what time it is.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object PostReactionGroup {

    /** One reacting person: the id the avatar route needs, and the name the sentence uses. */
    data class Actor(val id: String, val name: String) {
        /** Who this is for the purpose of "has this person already reacted" - never blank. */
        val identity: String get() = id.ifEmpty { name }
    }

    /**
     * How many actors a ledger keeps. The sentence names two and counts the rest, so the cap only
     * bounds the stored string; 50 is far past anything a post draws in a day.
     */
    const val MAX_ACTORS = 50

    /** How many faces the large icon shows at most. */
    const val MAX_FACES = 3

    /**
     * The ledger with [actor] added as the NEWEST.
     *
     * A person who reacts again (they removed the reaction and put another) is moved to the end
     * rather than listed twice: "A, A and 2 others" would be a sentence about one person.
     */
    fun add(actors: List<Actor>, actor: Actor): List<Actor> {
        val next = actors.filter { it.identity != actor.identity } + actor
        return if (next.size > MAX_ACTORS) next.takeLast(MAX_ACTORS) else next
    }

    /** The sentence's shape, newest reactor first. */
    sealed class Shape {
        data class One(val a: Actor) : Shape()
        data class Two(val a: Actor, val b: Actor) : Shape()
        data class Three(val a: Actor, val b: Actor, val c: Actor) : Shape()

        /** [others] is at least 2: three people are named in full, so "and 1 other" never occurs. */
        data class Many(val a: Actor, val b: Actor, val others: Int) : Shape()
    }

    /** What the ledger says, or null for an empty one - which is a caller's bug, and says so. */
    fun shape(actors: List<Actor>): Shape? {
        val newest = actors.asReversed()
        return when (newest.size) {
            0 -> null
            1 -> Shape.One(newest[0])
            2 -> Shape.Two(newest[0], newest[1])
            3 -> Shape.Three(newest[0], newest[1], newest[2])
            else -> Shape.Many(newest[0], newest[1], newest.size - 2)
        }
    }

    /** The people whose faces are drawn: the newest [MAX_FACES], newest first. */
    fun faces(actors: List<Actor>): List<Actor> = actors.asReversed().take(MAX_FACES)

    /** One `id<TAB>name` line per actor, oldest first. Tabs and newlines cannot occur in either. */
    fun encode(actors: List<Actor>): String =
        actors.joinToString("\n") { "${clean(it.id)}\t${clean(it.name)}" }

    /** The inverse of [encode]; a malformed line is dropped, never guessed at. */
    fun decode(raw: String?): List<Actor> =
        raw.orEmpty().split('\n').mapNotNull { line ->
            val parts = line.split('\t')
            if (parts.size == 2 && (parts[0].isNotEmpty() || parts[1].isNotEmpty())) {
                Actor(parts[0], parts[1])
            } else {
                null
            }
        }

    private fun clean(s: String): String = s.replace('\t', ' ').replace('\n', ' ')
}
