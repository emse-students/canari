import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "fr.emse.canari"
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
            // Without this, R8 keeps EVERY resource, and therefore every class reachable from one -
            // which is how an unused UI library stayed in the DEX. `gradle.properties` already sets
            // `android.r8.optimizedResourceShrinking=true`, which did nothing at all while the
            // shrinker itself was off. Safe mode is the default: a resource named through
            // `Resources.getIdentifier` would still be kept, and this app has no such lookup
            // anywhere (nor any `R.layout` reference - `activity_main.xml` says so itself).
            isShrinkResources = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        buildConfig = true
    }
    lint {
        // Disable the vital-lint release gate to work around a crash in the Kotlin
        // lint analyzer (KotlinScriptUClass / findFirCompiledSymbol) that is a bug
        // in the Android Gradle Plugin, not in our code.
        checkReleaseBuilds = false
        abortOnError = false
    }
}

rust {
    rootDirRel = "../../../"
}

/**
 * `com.google.android.material` is dead weight, and excluding it is an assertion, not a workaround.
 *
 * Eight modules declare it - six Tauri plugins from the cargo registry plus the two local patched
 * ones - all from the plugin template, and NOT ONE Kotlin file in any of them, or in this app,
 * names a class from it. Its only real use here was the `Theme.MaterialComponents` parent in
 * `res/values/themes.xml`, now `Theme.AppCompat`. So dropping our own `implementation` line alone
 * would not have removed the library: Gradle would simply have resolved the plugins' 1.7.0 and
 * kept it, `MaterialDatePicker` included - the class Google Play reports a deprecated
 * `Window.setStatusBarColor` call from. The exclusion is what actually takes it out of the APK.
 */
configurations.configureEach {
    exclude(group = "com.google.android.material", module = "material")
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("com.google.firebase:firebase-messaging-ktx:24.1.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")