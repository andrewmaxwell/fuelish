package app.fuelish.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import app.fuelish.Prefs
import app.fuelish.RecorderService
import app.fuelish.RecorderState
import app.fuelish.VehicleNaming
import java.util.concurrent.TimeUnit

class UploadWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val cfg = Prefs.config(applicationContext)
        if (!cfg.upload.optBoolean("enabled", true)) return Result.success()
        val store = Prefs.store(applicationContext)
        val up = RecorderState.upload
        up.value = up.value.copy(running = true, pending = store.pendingChunkCount(), unconfirmed = store.unconfirmed(RecorderService.activeId).size)
        var total = 0
        var result: UploadResult
        var held = up.value.held
        // Loop so chunks that close while we upload are picked up in the same run.
        do {
            val uploader = Uploader(store, cfg.serverUrl, cfg.deviceToken, cfg.upload.optBoolean("deleteAfterUpload", true), { isStopped }) { id ->
                TripReady.notify(applicationContext, id, store.readMeta(id))
            }
            result = uploader.uploadAll()
            uploader.current?.let { Prefs.rememberUploadTarget(applicationContext, it) }
            if (uploader.current != null) held = uploader.held.toList()
            if (result is UploadResult.Done) total += result.chunks
            if (result is UploadResult.Incomplete) total += result.chunks
        } while (result is UploadResult.Done && result.chunks > 0 && !isStopped)
        val text = when (result) {
            is UploadResult.Done -> "ok ($total chunks)"
            is UploadResult.Incomplete -> "the server is missing parts of ${result.missing.size} recording${if (result.missing.size == 1) "" else "s"} this phone no longer has"
            is UploadResult.Retry -> "will retry: ${result.message}"
            is UploadResult.Fatal -> if (result.signInNeeded) "signed out: sign in again to resume uploads" else "failed: ${result.message}"
        }
        // A rejected key means signing in again; anything that got through means the key works.
        when {
            result is UploadResult.Fatal && result.signInNeeded -> Prefs.setSignInNeeded(applicationContext, true)
            result is UploadResult.Done || result is UploadResult.Incomplete -> Prefs.setSignInNeeded(applicationContext, false)
        }
        VehicleNaming.retry(applicationContext)
        up.value = UploadStatus(
            running = false, lastResult = text, lastAtMs = System.currentTimeMillis(), pending = store.pendingChunkCount(),
            unconfirmed = store.unconfirmed(RecorderService.activeId).size, attention = store.needsAttention(),
            held = held.filter { store.dir(it).exists() },
        )
        return when (result) {
            is UploadResult.Done, is UploadResult.Incomplete -> Result.success()
            is UploadResult.Retry -> Result.retry()
            is UploadResult.Fatal -> Result.failure()
        }
    }

    companion object {
        // Uploads wait for Wi-Fi (any unmetered network) unless the user taps "Upload now"
        // or sets upload.allowCellular. Recordings are ~100 MB/hour, too much for mobile data by default.
        private fun constraints(c: Context, cellular: Boolean = false): Constraints {
            val anyNetwork = cellular || Prefs.config(c).upload.optBoolean("allowCellular", false)
            return Constraints.Builder()
                .setRequiredNetworkType(if (anyNetwork) NetworkType.CONNECTED else NetworkType.UNMETERED)
                .build()
        }

        /** Queues an upload. [cellular] = the user asked for it now, so any network will do. */
        fun enqueue(c: Context, cellular: Boolean = false) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(constraints(c, cellular))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // A manual request replaces one still waiting for Wi-Fi. Uploads are idempotent, a
            // replaced job stops at its next safe point, and Uploader lets only one run at a time
            // (this queue and the periodic one are separate WorkManager names).
            WorkManager.getInstance(c).enqueueUniqueWork("upload", if (cellular) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, req)
        }

        fun schedulePeriodic(c: Context) {
            val req = PeriodicWorkRequestBuilder<UploadWorker>(1, TimeUnit.HOURS).setConstraints(constraints(c)).build()
            WorkManager.getInstance(c).enqueueUniquePeriodicWork("upload-periodic", ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}

private typealias UploadStatus = app.fuelish.UploadStatus
