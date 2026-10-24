plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tauri.restore"
    // androidx.credentials 1.6 is compiled against API 36; the app's root build forces 36 on every
    // library module anyway (gen/android/build.gradle.kts), this says it where the reason is.
    compileSdk = 36

    defaultConfig {
        minSdk = 28

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // The Restore Credentials API (WP-RESTORE-1, docs/wiki/account-restore.md). The second artifact
    // is the Google Play services provider the API delegates to - without it every call answers
    // "no provider", which is not a fallback this plugin could notice.
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation(project(":tauri-android"))
}
