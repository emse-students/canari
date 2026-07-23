plugins {
    id("com.android.application") apply false
    id("com.android.library") apply false
    id("org.jetbrains.kotlin.android") apply false
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
            extensions.configure<com.android.build.api.dsl.CommonExtension>("android") {
                compileSdk = 36
            }
        }
        // Upstream Tauri modules live read-only in the cargo registry; their Kotlin
        // deprecations and javac source/target 8 warnings are not actionable here, so
        // silence them for THOSE modules only (our app + local patches keep warnings).
        if (projectDir.path.replace('\\', '/').contains("/.cargo/registry/")) {
            tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
                compilerOptions.suppressWarnings.set(true)
            }
            tasks.withType<JavaCompile>().configureEach {
                options.compilerArgs.add("-Xlint:-options")
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

