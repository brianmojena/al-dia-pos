package cu.mypimes.pos.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [
        CacheRecordEntity::class, SyncCursorEntity::class, QueuedOperationEntity::class,
        SaleEntity::class, SaleLineEntity::class, OutboxDependencyEntity::class, IdMapEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class LocalDatabase : RoomDatabase() {
    abstract fun localDao(): LocalDao
}
