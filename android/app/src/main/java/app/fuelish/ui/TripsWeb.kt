package app.fuelish.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The web page (trips, maps, insights) shown inside the app, so the recorder and the trips are one
 * app instead of an APK plus a browser shortcut. One WebView lives as long as the activity; it keeps
 * its own sign-in (the web token in its localStorage), so you sign in once, here.
 *
 * Only the configured server's pages load inside it. Anything else (map attribution links, raw data
 * downloads, a shared link opened elsewhere) goes to the browser.
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
class TripsWeb(ctx: Context, private val onSignIn: (invite: String, legacyToken: String) -> Unit) {
    val view = WebView(ctx).apply {
        // Debug builds: inspect the page from chrome://inspect on the computer.
        if (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        // Fill the space it's given. Compose's default (wrap content) makes the page's vh/dvh units 0,
        // which collapsed the trip map to nothing.
        layoutParams = android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
        // No white flash before the page paints in dark mode; the page sets its own background.
        setBackgroundColor(Color.TRANSPARENT)
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(v: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                loadFailed = false
            }

            // The page itself didn't load (no signal, server down). A failed map tile doesn't count.
            override fun onReceivedError(v: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) loadFailed = true
            }

            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                if (isOurs(req.url)) return false
                openOutside(v.context, req.url)
                return true
            }
        }
        setDownloadListener { url, _, _, _, _ -> openOutside(context, Uri.parse(url)) }
        addJavascriptInterface(Bridge(), "FuelishApp")
    }

    /**
     * What the page can ask of the app: `FuelishApp.signIn(invite, legacyToken)`. Runs only for our
     * own server's page (links to other sites open in the browser, but check anyway).
     */
    private inner class Bridge {
        @JavascriptInterface
        fun signIn(invite: String?, legacyToken: String?) {
            view.post {
                if (view.url?.let { isOurs(Uri.parse(it)) } == true) onSignIn(invite.orEmpty(), legacyToken.orEmpty())
            }
        }

        /** The page signed out. The phone keeps its upload key: recording isn't tied to the page's sign-in. */
        @JavascriptInterface
        fun signedOut() {}
    }

    /** Tells the page how the native sign-in went. */
    fun signInDone(ok: Boolean, message: String = "") {
        view.evaluateJavascript("window.Account && Account.nativeDone($ok, ${org.json.JSONObject.quote(message)})", null)
    }

    /** True when the page couldn't load; the app shows its own message over the WebView's error page. */
    var loadFailed by mutableStateOf(false)
        private set

    /** The server the page was loaded from; null until [show] with a server URL. */
    private var base: String? = null

    private fun isOurs(u: Uri): Boolean {
        val b = base?.let(Uri::parse) ?: return false
        return u.scheme == b.scheme && u.host == b.host && u.port == b.port
    }

    /**
     * Loads [serverUrl] if it isn't loaded yet (or the server changed). With [hash] (e.g. "#/r/<id>"),
     * goes to that page; the web page routes on the hash, so this doesn't reload it.
     */
    fun show(serverUrl: String, hash: String? = null) {
        if (serverUrl.isBlank()) return
        if (serverUrl != base) {
            base = serverUrl
            view.loadUrl("$serverUrl/" + (hash ?: ""))
        } else if (hash != null) {
            view.evaluateJavascript("location.hash = ${org.json.JSONObject.quote(hash)}", null)
        }
    }

    /** Back inside the page (trip → list). False when there's nowhere to go back to. */
    fun back(): Boolean {
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    fun retry() {
        loadFailed = false
        view.reload()
    }

    private fun openOutside(c: Context, u: Uri) {
        try {
            c.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
        }
    }
}
