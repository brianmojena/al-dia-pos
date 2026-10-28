package cu.mypimes.pos.data.local

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Necesita un dispositivo o emulador (`connectedAndroidTest`). Usa los esquemas exportados en `app/schemas`. */
@RunWith(AndroidJUnit4::class)
class LocalMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), LocalDatabase::class.java)

    private val name = "migration-test.db"

    @Test fun migrationKeepsQueueAndCacheRowsAndAddsDefaults() {
        helper.createDatabase(name, 1).apply {
            execSQL("INSERT INTO operation_queue (clientOperationId, accountKey, operationType, path, method, payload, status, createdAt, attempts, lastError) VALUES ('op-1', 'u1', 'sale', '/api/sales', 'POST', '{\"a\":1}', 'pending', 10, 2, 'sin red')")
            execSQL("INSERT INTO cache_records (accountKey, kind, recordKey, payload, updatedAt) VALUES ('u1', 'pos_sales', 's-1', '{\"x\":2}', 5)")
            execSQL("INSERT INTO sync_cursors (accountKey, cursorName, value) VALUES ('u1', 'sale', 77)")
            close()
        }
        val db = helper.runMigrationsAndValidate(name, 2, true, LocalMigrations.MIGRATION_1_2)

        db.query("SELECT clientOperationId, payload, status, attempts, lastError, dependsOn, entityRef, ownerRole FROM operation_queue").use {
            assertEquals(1, it.count); it.moveToFirst()
            assertEquals("op-1", it.getString(0)); assertEquals("{\"a\":1}", it.getString(1))
            assertEquals("pending", it.getString(2)); assertEquals(2, it.getInt(3)); assertEquals("sin red", it.getString(4))
            assertEquals(true, it.isNull(5)); assertEquals(true, it.isNull(6)); assertEquals("cajero", it.getString(7))
        }
        db.query("SELECT payload FROM cache_records WHERE recordKey = 's-1'").use { it.moveToFirst(); assertEquals("{\"x\":2}", it.getString(0)) }
        db.query("SELECT value FROM sync_cursors WHERE cursorName = 'sale'").use { it.moveToFirst(); assertEquals(77L, it.getLong(0)) }
        for (table in listOf("sale", "sale_line", "outbox_dependency", "id_map")) {
            db.query("SELECT COUNT(*) FROM $table").use { it.moveToFirst(); assertEquals(0, it.getInt(0)) }
        }
    }
}
