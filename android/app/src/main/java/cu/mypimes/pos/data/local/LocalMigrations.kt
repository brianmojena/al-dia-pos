package cu.mypimes.pos.data.local

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * v1 -> v2: solo CREA tablas e índices y AÑADE columnas con valor por defecto. No reescribe ni borra filas:
 * `operation_queue` y `cache_records` se conservan tal cual. El SQL es el que Room exportó en `2.json`
 * (una prueba JVM comprueba que coinciden).
 */
object LocalMigrations {
    val V1_TO_V2: List<String> = listOf(
        "ALTER TABLE `operation_queue` ADD COLUMN `dependsOn` TEXT",
        "ALTER TABLE `operation_queue` ADD COLUMN `entityRef` TEXT",
        "ALTER TABLE `operation_queue` ADD COLUMN `ownerRole` TEXT NOT NULL DEFAULT 'cajero'",
        "CREATE TABLE IF NOT EXISTS `sale` (`accountKey` TEXT NOT NULL, `clientSaleId` TEXT NOT NULL, `serverId` INTEGER, `businessDate` TEXT NOT NULL, `createdAt` TEXT NOT NULL, `total` REAL NOT NULL, `profit` REAL, `paymentMethod` TEXT NOT NULL, `cashCloseId` INTEGER, `registerId` TEXT NOT NULL, `status` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, PRIMARY KEY(`accountKey`, `clientSaleId`))",
        "CREATE INDEX IF NOT EXISTS `index_sale_accountKey_businessDate` ON `sale` (`accountKey`, `businessDate`)",
        "CREATE INDEX IF NOT EXISTS `index_sale_accountKey_cashCloseId` ON `sale` (`accountKey`, `cashCloseId`)",
        "CREATE TABLE IF NOT EXISTS `sale_line` (`accountKey` TEXT NOT NULL, `clientSaleId` TEXT NOT NULL, `idx` INTEGER NOT NULL, `productId` INTEGER NOT NULL, `name` TEXT NOT NULL, `qty` REAL NOT NULL, `unitPrice` REAL NOT NULL, `unitCost` REAL, `packSize` INTEGER, PRIMARY KEY(`accountKey`, `clientSaleId`, `idx`))",
        "CREATE TABLE IF NOT EXISTS `outbox_dependency` (`clientOperationId` TEXT NOT NULL, `dependsOnClientOperationId` TEXT NOT NULL, PRIMARY KEY(`clientOperationId`, `dependsOnClientOperationId`))",
        "CREATE TABLE IF NOT EXISTS `id_map` (`accountKey` TEXT NOT NULL, `entity` TEXT NOT NULL, `localId` INTEGER NOT NULL, `serverId` INTEGER NOT NULL, PRIMARY KEY(`accountKey`, `entity`, `localId`))",
    )

    val MIGRATION_1_2 = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) = V1_TO_V2.forEach(db::execSQL)
    }
}
