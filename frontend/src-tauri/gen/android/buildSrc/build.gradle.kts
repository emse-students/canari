plugins {
    `kotlin-dsl`
}

// Pin buildSrc to Java 21 (LTS) — avoids the compileJava (25) vs compileKotlin (24)
// warning when JDK 25 is active. jvmToolchain is scoped to buildSrc only.
kotlin {
    jvmToolchain(21)
}

gradlePlugin {
    plugins {
        create("pluginsForCoolKids") {
            id = "rust"
            implementationClass = "RustPlugin"
        }
    }
}

repositories {
    google()
    mavenCentral()
}

dependencies {
    compileOnly(gradleApi())
    implementation("com.android.tools.build:gradle:9.0.1")
}

