import java.util.Properties
import java.nio.file.Files
import java.nio.file.StandardCopyOption

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    id("com.google.gms.google-services")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    ndkVersion = "29.0.13846066"
    namespace = "fr.emse.canari"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "fr.emse.canari"
        minSdk = 28
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }

    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (keystorePropertiesFile.exists()) {
                keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
            }

            keyAlias = keystoreProperties["keyAlias"] as String?
            keyPassword = (keystoreProperties["keyPassword"] ?: keystoreProperties["password"]) as String?
            storeFile = if (keystoreProperties["storeFile"] != null) rootProject.file(keystoreProperties["storeFile"] as String) else null
            storePassword = (keystoreProperties["storePassword"] ?: keystoreProperties["password"]) as String?
        }
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            val releaseSigning = signingConfigs.getByName("release")
            signingConfig = if (releaseSigning.storeFile != null) {
                releaseSigning
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
        }
    }
    buildFeatures {
        buildConfig = true
    }
    lint {
        // Disable release lint check — known AGP/Kotlin-FIR bug with Kotlin 2.x
        checkReleaseBuilds = false
        abortOnError = false
    }
}

rust {
    rootDirRel = "../../../"
}

// Gradle 9.1 on Windows cannot hash symlinked .so files from Tauri's Rust build.
// Replace symlinks with real copies before the JNI merge task runs.
// Each task is scoped to its own ABI subdirectory to prevent concurrent file-lock
// conflicts when Gradle runs multiple JniLibFolders tasks in parallel.
tasks.whenTaskAdded {
    if (!name.contains("JniLibFolders")) return@whenTaskAdded
    val abiSubdir = when {
        name.startsWith("mergeArm64")  -> "arm64-v8a"
        name.startsWith("mergeArm")    -> "armeabi-v7a"
        name.startsWith("mergeX86_64") -> "x86_64"
        name.startsWith("mergeX86")    -> "x86"
        // Universal: per-ABI tasks already resolved symlinks; nothing to do.
        else -> return@whenTaskAdded
    }
    doFirst {
        fileTree("src/main/jniLibs/$abiSubdir").matching { include("**/*.so") }.forEach { soFile ->
            val path = soFile.toPath()
            if (Files.isSymbolicLink(path)) {
                val link = Files.readSymbolicLink(path)
                val resolved = if (link.isAbsolute) link else path.parent.resolve(link).normalize()
                if (Files.exists(resolved)) {
                    Files.delete(path)
                    Files.copy(resolved, path, StandardCopyOption.REPLACE_EXISTING)
                }
            }
        }
    }
}

// signUniversalDebugBundle reads each per-ABI .aab, so it must wait for them all to be
// fully written. AGP doesn't always add these cross-flavor ordering constraints on Windows.
afterEvaluate {
    val abis = listOf("Arm64", "Arm", "X86", "X86_64")
    for (profile in listOf("Debug", "Release")) {
        val universalSign = tasks.findByName("signUniversal${profile}Bundle") ?: continue
        abis.forEach { abi ->
            tasks.findByName("sign${abi}${profile}Bundle")?.let { universalSign.mustRunAfter(it) }
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation(platform("com.google.firebase:firebase-bom:34.12.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.firebase:firebase-analytics")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")