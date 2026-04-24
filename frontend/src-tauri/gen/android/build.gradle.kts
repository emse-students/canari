plugins {
    id("com.android.application") version "9.0.1" apply false
    id("com.android.library") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
    // Google services Gradle plugin (apply false = activé uniquement dans les modules qui l'utilisent)
    id("com.google.gms.google-services") version "4.4.4" apply false
}

// Pre-create missing consumer-rules.pro files before any plugin evaluation
run {
    val cargoRegistryPath = System.getenv("USERPROFILE") ?: System.getenv("HOME") ?: return@run
    val registryBase = File(cargoRegistryPath).let { 
        if (it.path.contains("USERPROFILE")) File(it, ".cargo/registry/src/index.crates.io-1949cf8c6b5b557f")
        else File(it, ".cargo/registry/src/index.crates.io-1949cf8c6b5b557f")
    }
    
    if (registryBase.exists()) {
        registryBase.listFiles { dir -> dir.isDirectory && dir.name.startsWith("tauri-plugin-") }?.forEach { pluginDir ->
            val androidDir = File(pluginDir, "android")
            if (androidDir.exists()) {
                val rulesFile = File(androidDir, "consumer-rules.pro")
                if (!rulesFile.exists()) {
                    rulesFile.writeText("# Auto-generated: ${pluginDir.name}\n")
                }
            }
        }
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
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

