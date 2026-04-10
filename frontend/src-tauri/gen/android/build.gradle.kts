plugins {
    // Google services Gradle plugin (apply false = activé uniquement dans les modules qui l'utilisent)
    id("com.google.gms.google-services") version "4.4.4" apply false
}

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.0.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }

    beforeEvaluate {
        // Create missing consumer-rules.pro for plugins (some versions don't include it)
        if (project.plugins.hasPlugin("com.android.library")) {
            val rulesFile = File(project.projectDir, "consumer-rules.pro")
            if (!rulesFile.exists()) {
                rulesFile.writeText("# Auto-generated: plugin is missing consumer rules\n")
            }
        }
    }
}

subprojects {
    afterEvaluate {
        if (pluginManager.hasPlugin("com.android.library") || pluginManager.hasPlugin("com.android.application")) {
            extensions.configure<com.android.build.gradle.BaseExtension>("android") {
                compileSdkVersion(36)
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

