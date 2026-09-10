// THE ANDROID UNIT TESTS THAT NEED NOTHING FROM ANDROID.
//
// See `settings.gradle.kts` beside this file for why they are not in the app module any more.
// This is a plain Kotlin/JVM project on purpose: a JDK and this directory are the whole of what
// running it requires, which is what lets CI run it on every pull request that touches Android.
//
// THE TWO VERSIONS ARE PINNED TOGETHER AND MUST MOVE TOGETHER. The wrapper is Gradle 9.1.0, the
// same one `gen/android` uses, so a developer needs one Gradle in their cache rather than two -
// and the Kotlin plugin must be a release that supports it. Measured on 2026-09-10: Kotlin 2.0.21
// on a Gradle 9.3 daemon spends two minutes and then fails `:compileTestKotlin` with a bare
// "Internal compiler error", which names neither the version pair nor the file.

plugins {
    kotlin("jvm") version "2.2.0"
}

repositories {
    mavenCentral()
}

dependencies {
    // JUnit 4, because that is what the suite imports (`org.junit.Test`, `org.junit.Assert`) and
    // what the Android module it came from provided. Nothing here needs anything else.
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnit()
    testLogging {
        events("passed", "failed", "skipped")
    }
}
