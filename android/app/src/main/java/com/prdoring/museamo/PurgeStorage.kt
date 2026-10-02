package com.prdoring.museamo

/** Logical content clearing also removes old SQLite pages and committed WAL frames. */
object PurgeStorage {
    private const val PENDING = "purge.storage.pending"
    fun configure(repo: Repository) {
        repo.db.runInTransaction {
            repo.db.openHelper.writableDatabase.query("PRAGMA secure_delete=ON").use { cursor -> check(cursor.moveToFirst() && cursor.getInt(0) == 1) { "Could not enable SQLite content clearing" } }
        }
        finish(repo)
    }
    fun pending(repo: Repository) { repo.rawDao.putSyncMetadata(SyncMetadataRow(PENDING, "1")) }
    fun finish(repo: Repository) {
        if (repo.db.inTransaction() || repo.rawDao.syncMetadata(PENDING) == null) return
        // An open reader may hold the WAL. Keep the durable marker and retry after cleanup/open.
        val complete = repo.db.openHelper.writableDatabase.query("PRAGMA wal_checkpoint(TRUNCATE)").use { cursor -> cursor.moveToFirst() && cursor.getInt(0) == 0 }
        if (complete) repo.rawDao.deleteSyncMetadata(PENDING)
    }
}
