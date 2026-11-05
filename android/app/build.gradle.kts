import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release key lives outside the repo (~/.android/fuelish-release.{jks,properties}). Google sign-in
// is registered against its SHA-1, and every phone's install must keep the same key to update, so
// back both files up. Without them (another machine), release builds fall back to the debug key.
val releaseProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".android/fuelish-release.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Versions count commits, so every committed build is newer than the last one (in-app updates compare
// versionCode). tools/publish-apk.sh only publishes from a clean checkout, so the number means one build.
val gitCommits: Int = runCatching {
    providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }.standardOutput.asText.get().trim().toInt()
}.getOrDefault(1)

android {
    namespace = "app.fuelish"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "app.fuelish"
        minSdk = 31
        targetSdk = 36
        versionCode = gitCommits
        versionName = "0.1.$gitCommits"
    }

    signingConfigs {
        if (releaseProps.isNotEmpty()) create("release") {
            storeFile = file(releaseProps.getProperty("storeFile"))
            storePassword = releaseProps.getProperty("storePassword")
            keyAlias = releaseProps.getProperty("keyAlias")
            keyPassword = releaseProps.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    buildFeatures { compose = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    // Google sign-in (Android's own account picker; Google doesn't allow its sign-in page in a WebView).
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814") // real org.json for JVM tests (Android's is stubbed)
}
