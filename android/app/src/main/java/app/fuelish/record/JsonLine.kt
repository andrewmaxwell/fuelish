package app.fuelish.record

/**
 * Minimal allocation-light builder for one NDJSON record. Every record starts with
 * `"k"` (its kind). Non-finite numbers become null so lines always parse.
 */
class JsonLine(kind: String, capacity: Int = 160) {
    private val sb = StringBuilder(capacity).append("{\"k\":")
    private var stack = 0

    init {
        str(kind)
    }

    private fun key(k: String): JsonLine {
        val c = sb[sb.length - 1]
        if (c != '{' && c != '[') sb.append(',')
        str(k)
        sb.append(':')
        return this
    }

    private fun str(s: String) {
        sb.append('"')
        for (ch in s) {
            when {
                ch == '"' -> sb.append("\\\"")
                ch == '\\' -> sb.append("\\\\")
                ch == '\n' -> sb.append("\\n")
                ch == '\r' -> sb.append("\\r")
                ch == '\t' -> sb.append("\\t")
                ch < ' ' -> sb.append(String.format("\\u%04x", ch.code))
                else -> sb.append(ch)
            }
        }
        sb.append('"')
    }

    private fun num(d: Double) {
        if (d.isFinite()) {
            if (d == Math.rint(d) && kotlin.math.abs(d) < 1e15) sb.append(d.toLong()) else sb.append(d)
        } else sb.append("null")
    }

    private fun num(f: Float) {
        if (f.isFinite()) sb.append(f) else sb.append("null")
    }

    fun n(k: String, v: Long) = key(k).also { sb.append(v) }
    fun n(k: String, v: Int) = key(k).also { sb.append(v) }
    fun d(k: String, v: Double) = key(k).also { num(v) }
    fun f(k: String, v: Float) = key(k).also { num(v) }
    fun b(k: String, v: Boolean) = key(k).also { sb.append(v) }
    fun s(k: String, v: String?) = key(k).also { if (v == null) sb.append("null") else str(v) }

    /** Inserts pre-serialized JSON (object/array/value) verbatim. */
    fun raw(k: String, json: String) = key(k).also { sb.append(json) }

    fun floats(k: String, v: FloatArray, count: Int = v.size): JsonLine {
        key(k).sb.append('[')
        for (i in 0 until count) {
            if (i > 0) sb.append(',')
            num(v[i])
        }
        sb.append(']')
        return this
    }

    fun doubles(k: String, v: DoubleArray): JsonLine {
        key(k).sb.append('[')
        v.forEachIndexed { i, x ->
            if (i > 0) sb.append(',')
            num(x)
        }
        sb.append(']')
        return this
    }

    /** Nested object: `obj("x") { n("a", 1) }`. */
    inline fun obj(k: String, body: JsonLine.() -> Unit): JsonLine {
        beginObj(k)
        body()
        return endObj()
    }

    fun beginObj(k: String): JsonLine {
        key(k).sb.append('{')
        stack++
        return this
    }

    fun endObj(): JsonLine {
        sb.append('}')
        stack--
        return this
    }

    /** Array of objects: call [arrObj] inside for each element. */
    inline fun arr(k: String, body: JsonLine.() -> Unit): JsonLine {
        beginArr(k)
        body()
        return endArr()
    }

    fun beginArr(k: String): JsonLine {
        key(k).sb.append('[')
        return this
    }

    fun endArr(): JsonLine {
        sb.append(']')
        return this
    }

    inline fun arrObj(body: JsonLine.() -> Unit): JsonLine {
        beginElemObj()
        body()
        return endObj()
    }

    fun beginElemObj(): JsonLine {
        val c = sb[sb.length - 1]
        if (c != '[') sb.append(',')
        sb.append('{')
        stack++
        return this
    }

    fun build(): String {
        check(stack == 0) { "unbalanced JsonLine" }
        return sb.append('}').toString()
    }

    override fun toString() = build()
}
