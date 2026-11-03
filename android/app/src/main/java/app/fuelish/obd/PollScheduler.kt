package app.fuelish.obd

class PollItem(val pid: Int, var intervalNs: Long, val tier: String, val knownLength: Boolean) {
    var lastNs = Long.MIN_VALUE / 2
    var polls = 0L
    var answered = 0L
    var consecutiveMisses = 0
    val dueNs get() = lastNs + intervalNs
}

/**
 * Earliest-deadline-first polling. Items with interval 0 ("fast") are always due, so they
 * get all spare bus time; slower items preempt them only when their own deadline passes,
 * which bounds how much they can take. When the ECU accepts multi-PID requests, due items
 * are batched and remaining slots are filled with fast items, so slow PIDs ride along
 * nearly for free.
 */
class PollScheduler(val items: List<PollItem>, var maxBatch: Int) {
    fun next(nowNs: Long): List<PollItem> {
        val due = items.filter { it.dueNs <= nowNs }.sortedBy { it.dueNs }
        if (due.isEmpty()) return emptyList()
        val head = due.first()
        if (maxBatch <= 1 || !head.knownLength) return listOf(head)
        val batch = mutableListOf(head)
        for (it in due) {
            if (batch.size >= maxBatch) break
            if (it !== head && it.knownLength) batch += it
        }
        if (batch.size < maxBatch) {
            for (it in items.filter { it.tier == FAST && it.knownLength && it !in batch }.sortedBy { it.dueNs }) {
                if (batch.size >= maxBatch) break
                batch += it
            }
        }
        return batch
    }

    /** Earliest time anything becomes due (for sleeping when nothing is due now). */
    fun nextDueNs(): Long = items.minOfOrNull { it.dueNs } ?: Long.MAX_VALUE

    fun completed(batch: List<PollItem>, answeredPids: Set<Int>, nowNs: Long) {
        for (it in batch) {
            it.lastNs = nowNs
            it.polls++
            if (it.pid in answeredPids) {
                it.answered++
                it.consecutiveMisses = 0
            } else it.consecutiveMisses++
        }
    }

    companion object {
        const val FAST = "fast"
    }
}
