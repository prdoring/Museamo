package com.prdoring.museamo

object LocationPolicy {
    fun askOnOpen(enabled: Boolean, permitted: Boolean, asked: Boolean, servicesOn: Boolean) = enabled && !permitted && !asked && servicesOn
    // A recent OS fix is useful even when it predates opening the composer by a few seconds.
    fun recent(fixNanos: Long, nowNanos: Long) = fixNanos > 0 && fixNanos <= nowNanos && nowNanos - fixNanos <= 60_000_000_000L
}
