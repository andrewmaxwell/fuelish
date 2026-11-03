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
import app.fuelish.RecorderState
import java.util.concurrent.TimeUnit

class UploadWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val cfg = Prefs.config(applicationContext)
        if (!cfg.upload.optBoolean("enabled", true)) return Result.success()
        val store = Prefs.store(applicationContext)
        val up = RecorderState.upload
        up.value = up.value.copy(running = true, pending = store.pendingChunkCount())
        var total = 0
        var result: UploadResult
        // Loop so chunks that close while we upload are picked up in the same run.
        do {
            result = Uploader(store, cfg.serverUrl, cfg.deviceToken).uploadAll()
            if (result is UploadResult.Done) total += result.chunks
        } while (result is UploadResult.Done && result.chunks > 0 && !isStopped)
        val text = when (result) {
            is UploadResult.Done -> "ok ($total chunks)"
            is UploadResult.Retry -> "will retry: ${result.message}"
            is UploadResult.Fatal -> "failed: ${result.message}"
        }
        up.value = UploadStatus(running = false, lastResult = text, lastAtMs = System.currentTimeMillis(), pending = store.pendingChunkCount())
        return when (result) {
            is UploadResult.Done -> Result.success()
            is UploadResult.Retry -> Result.retry()
            is UploadResult.Fatal -> Result.failure()
        }
    }

    companion object {
        private fun constraints(c: Context): Constraints {
            val unmetered = Prefs.config(c).upload.optBoolean("unmeteredOnly", false)
            return Constraints.Builder()
                .setRequiredNetworkType(if (unmetered) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .build()
        }

        fun enqueue(c: Context) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(constraints(c))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(c).enqueueUniqueWork("upload", ExistingWorkPolicy.KEEP, req)
        }

        fun schedulePeriodic(c: Context) {
            val req = PeriodicWorkRequestBuilder<UploadWorker>(1, TimeUnit.HOURS).setConstraints(constraints(c)).build()
            WorkManager.getInstance(c).enqueueUniquePeriodicWork("upload-periodic", ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}

private typealias UploadStatus = app.fuelish.UploadStatus
