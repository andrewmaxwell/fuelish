package app.fuelish.obd

class PollItem(val pid: Int, var intervalNs: Long, val tier: String, val knownLength: Boolean) {
    /** The tier's interval; [intervalNs] is longer while the PID is demoted. */
    val baseIntervalNs = intervalNs
    val demoted get() = intervalNs > baseIntervalNs
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
 *
 * [pinned] PIDs (airflow and the commanded air-fuel ratio: what the fuel estimate needs) go in every
 * multi-PID request. When the Bluetooth link stalls and a request takes 0.5 s instead of 50 ms,
 * every medium PID is overdue on every turn and would otherwise fill whole requests, leaving seconds
 * with no airflow and so no fuel. Pinned only with room for at least one other PID, and not while
 * demoted (the car has stopped answering it).
 */
class PollScheduler(val items: List<PollItem>, var maxBatch: Int, val pinned: Set<Int> = emptySet()) {
    fun next(nowNs: Long): List<PollItem> {
        val due = items.filter { it.dueNs <= nowNs }.sortedWith(fairOrder)
        if (due.isEmpty()) return emptyList()
        val head = due.first()
        if (maxBatch <= 1 || !head.knownLength) return listOf(head)
        val pins = items.filter { it.pid in pinned && it.knownLength && !it.demoted }
        val batch = (if (pins.size < maxBatch) pins else emptyList()).toMutableList()
        if (head !in batch) batch += head
        for (it in due) {
            if (batch.size >= maxBatch) break
            if (it !in batch && it.knownLength) batch += it
        }
        if (batch.size < maxBatch) {
            for (it in items.filter { it.tier == FAST && it.knownLength && it !in batch }.sortedWith(fairOrder)) {
                if (batch.size >= maxBatch) break
                batch += it
            }
        }
        return batch
    }

    /** Earliest time anything becomes due (for sleeping when nothing is due now). */
    fun nextDueNs(): Long = items.minOfOrNull { it.dueNs } ?: Long.MAX_VALUE

    /**
     * Records a finished request. Returns the demoted items that were answered again, which are
     * back on their own interval. When a multi-PID request gets nothing answered at all, the car
     * as a whole went quiet (ignition off), not these PIDs, so that isn't a miss toward demotion.
     * A single-PID request going unanswered still is.
     */
    fun completed(batch: List<PollItem>, answeredPids: Set<Int>, nowNs: Long): List<PollItem> {
        val restored = mutableListOf<PollItem>()
        val carSilent = answeredPids.isEmpty() && batch.size > 1
        for (it in batch) {
            it.lastNs = nowNs
            it.polls++
            if (it.pid in answeredPids) {
                it.answered++
                it.consecutiveMisses = 0
                if (it.demoted) {
                    it.intervalNs = it.baseIntervalNs
                    restored += it
                }
            } else if (!carSilent) it.consecutiveMisses++
        }
        return restored
    }

    companion object {
        const val FAST = "fast"
        /**
         * Oldest deadline first; among items polled in the same request (equal deadlines), the one
         * polled least so far. Without that tie-break the lowest PIDs in list order always won and
         * got ~60% more polls than the last fast PIDs.
         */
        private val fairOrder = compareBy<PollItem>({ it.dueNs }, { it.polls })
    }
}
