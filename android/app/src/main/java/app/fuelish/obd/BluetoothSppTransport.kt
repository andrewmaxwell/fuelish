package app.fuelish.obd

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import java.io.IOException
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Classic Bluetooth serial (SPP/RFCOMM) link, which is how the OBDLink MX+ talks to
 * Android. The adapter must already be paired in Android's Bluetooth settings.
 */
@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT is checked before OBD is started
class BluetoothSppTransport private constructor(private val socket: BluetoothSocket) : ObdTransport {
    private val incoming = LinkedBlockingQueue<ByteArray>()
    @Volatile private var failure: IOException? = null
    private val reader = Thread({
        val buf = ByteArray(1024)
        try {
            val input = socket.inputStream
            while (true) {
                val n = input.read(buf)
                if (n < 0) throw IOException("adapter closed the connection")
                incoming.put(buf.copyOf(n))
            }
        } catch (e: IOException) {
            failure = e
            incoming.put(EOF)
        }
    }, "fuelish-bt-reader").apply { isDaemon = true; start() }

    override fun write(bytes: ByteArray) {
        failure?.let { throw ObdDisconnected("link lost", it) }
        socket.outputStream.write(bytes)
        socket.outputStream.flush()
    }

    override fun read(timeoutMs: Long): ByteArray? {
        val b = incoming.poll(timeoutMs, TimeUnit.MILLISECONDS) ?: return null
        if (b === EOF) {
            incoming.put(EOF)
            throw ObdDisconnected("link lost", failure)
        }
        return b
    }

    override fun close() {
        runCatching { socket.close() }
    }

    companion object {
        private val SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private val EOF = ByteArray(0)

        fun connect(context: Context, address: String): BluetoothSppTransport {
            val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
                ?: throw IOException("no Bluetooth adapter")
            if (!adapter.isEnabled) throw IOException("Bluetooth is off")
            if (address.isBlank()) throw IOException("no OBD adapter selected in settings")
            val device = adapter.getRemoteDevice(address)
            // No cancelDiscovery() here: the app never scans, and on Android 12+ that call needs
            // BLUETOOTH_SCAN, which we don't hold, so it threw before every connection attempt.
            val socket = try {
                device.createRfcommSocketToServiceRecord(SPP).also { it.connect() }
            } catch (e: IOException) {
                // Some adapters/stacks only accept insecure RFCOMM.
                device.createInsecureRfcommSocketToServiceRecord(SPP).also { it.connect() }
            }
            return BluetoothSppTransport(socket)
        }
    }
}
