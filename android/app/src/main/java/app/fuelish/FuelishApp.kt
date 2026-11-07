package app.fuelish

import android.app.Application
import app.fuelish.auto.CarBluetooth
import app.fuelish.upload.UploadWorker
import java.util.concurrent.Executors

class FuelishApp : Application() {
    override fun onCreate() {
        super.onCreate()
        RecorderService.createChannel(this)
        CarBluetooth.createChannel(this)
        app.fuelish.upload.TripReady.createChannel(this)
        Executors.newSingleThreadExecutor().execute {
            // A fresh process has no active recording, so anything still marked "recording"
            // was cut short by a crash or kill: finish it and queue it for upload.
            val store = Prefs.store(this)
            store.recover { RecorderService.activeId }
            RecorderState.upload.value = RecorderState.upload.value.copy(
                pending = store.pendingChunkCount(), unconfirmed = store.unconfirmed(RecorderService.activeId).size, attention = store.needsAttention(),
            )
            UploadWorker.schedulePeriodic(this)
            // Also runs when nothing is pending, so already-uploaded recordings get cleaned up. Replaces any
            // queued job: a fresh process may follow an update that changed when uploads may run.
            if (store.ids().isNotEmpty()) UploadWorker.enqueue(this, replace = true)
        }
    }
}
