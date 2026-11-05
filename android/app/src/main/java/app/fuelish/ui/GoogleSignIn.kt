package app.fuelish.ui

import android.app.Activity
import android.os.Build
import android.webkit.CookieManager
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import app.fuelish.Prefs
import app.fuelish.record.UploadTarget
import app.fuelish.upload.UploadWorker
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Signs in with Google natively, for the trips page shown inside the app (Google refuses its
 * sign-in page in a WebView). One sign-in does two things:
 *  - the server's session cookie goes into the WebView, so the trips page is signed in;
 *  - the server makes an upload key for this phone, which replaces the device token in Settings,
 *    so this phone's recordings count as this person's.
 */
object GoogleSignIn {
    /** The "Fuelish web" OAuth client: Google issues the ID token for it, and the server checks that. */
    const val WEB_CLIENT_ID = "1033825280710-td79ais1l0e1bq8m1sq9a5uf6ccvfmfo.apps.googleusercontent.com"

    sealed class Result {
        data object Ok : Result()
        data object Cancelled : Result()
        data class Failed(val message: String) : Result()
    }

    /**
     * [invite]: the invite code when joining. [legacyToken]: the page's original web token, if it has
     * one, which lets the owner's first sign-in claim the server.
     */
    suspend fun signIn(activity: Activity, serverUrl: String, invite: String, legacyToken: String): Result {
        val idToken = try {
            val request = GetCredentialRequest.Builder()
                .addCredentialOption(GetSignInWithGoogleOption.Builder(WEB_CLIENT_ID).build())
                .build()
            val cred = CredentialManager.create(activity).getCredential(activity, request).credential
            if (cred !is CustomCredential || cred.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                return Result.Failed("Google didn't return a sign-in.")
            }
            GoogleIdTokenCredential.createFrom(cred.data).idToken
        } catch (_: GetCredentialCancellationException) {
            return Result.Cancelled
        } catch (_: NoCredentialException) {
            return Result.Failed("No Google account on this phone. Add one in Android settings, then try again.")
        } catch (e: GetCredentialException) {
            return Result.Failed("Google sign-in didn't work (${e.type.substringAfterLast('.')}).")
        }

        return withContext(Dispatchers.IO) {
            try {
                val c = URL("$serverUrl/api/v1/auth/google").openConnection() as HttpURLConnection
                try {
                    c.requestMethod = "POST"
                    c.connectTimeout = 15_000
                    c.readTimeout = 15_000
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", "application/json")
                    c.setRequestProperty("X-Fuelish", "1")
                    if (legacyToken.isNotBlank()) c.setRequestProperty("Authorization", "Bearer $legacyToken")
                    val body = JSONObject()
                        .put("credential", idToken)
                        .put("device", JSONObject().put("name", Build.MODEL))
                    if (invite.isNotBlank()) body.put("invite", invite)
                    c.outputStream.use { it.write(body.toString().toByteArray()) }
                    val code = c.responseCode
                    val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText().orEmpty()
                    val json = runCatching { JSONObject(text) }.getOrNull()
                    if (code != 200) return@withContext Result.Failed(json?.optString("error")?.ifBlank { null } ?: "The server answered HTTP $code.")

                    // The session cookie, for the trips page.
                    val cookies = CookieManager.getInstance()
                    c.headerFields["Set-Cookie"]?.forEach { cookies.setCookie(serverUrl, it) }
                    cookies.flush()

                    // This phone's own upload key replaces the shared device token.
                    json?.optString("deviceToken")?.takeIf { it.isNotBlank() }?.let { token ->
                        val cfg = JSONObject(Prefs.config(activity).json.toString()).put("deviceToken", token)
                        Prefs.saveConfig(activity, cfg.toString())
                        // Whose trips this phone now records: new recordings upload as this person.
                        json.optJSONObject("user")?.let { u ->
                            Prefs.rememberUploadTarget(activity, UploadTarget.of(serverUrl, token, u.optString("id").ifEmpty { null }, u.optString("name").ifEmpty { null }))
                        }
                        UploadWorker.enqueue(activity)
                    }
                    Result.Ok
                } finally {
                    c.disconnect()
                }
            } catch (e: Exception) {
                Result.Failed("Couldn't reach the server (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }
}
