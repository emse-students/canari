package fr.emse.canari.push

/**
 * Where [e] was thrown, for a log line: its class and the app's own frame that threw it (the first
 * frame when none is the app's), NEVER its message.
 *
 * A catch-all over a body that parses - a push payload, a file of names, the outbox - cannot vouch
 * for what an exception's message quotes: `org.json` quotes its WHOLE input. So such a catch says
 * WHERE, which is what finds the defect, and does not hand the throwable to `Log` either, whose
 * stack trace starts with the message (`nativeLogContent.test.ts`, docs/wiki/frontend/mobile.md
 * "What a native log line may carry").
 */
fun throwableSite(e: Throwable): String {
    val frame = e.stackTrace.firstOrNull { it.className.startsWith("fr.emse.canari") }
        ?: e.stackTrace.firstOrNull()
        ?: return e.javaClass.simpleName
    val cause = e.cause?.let { " (cause ${it.javaClass.simpleName})" } ?: ""
    return "${e.javaClass.simpleName} at ${frame.className.substringAfterLast('.')}.${frame.methodName}:${frame.lineNumber}$cause"
}
