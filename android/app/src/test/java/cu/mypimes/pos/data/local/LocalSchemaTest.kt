package cu.mypimes.pos.data.local

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Guarda la migración 1 -> 2 sin dispositivo: compara los esquemas exportados con el SQL de la migración. */
class LocalSchemaTest {
    private fun schema(version: Int): JsonObject =
        Json.parseToJsonElement(File("schemas/cu.mypimes.pos.data.local.LocalDatabase/$version.json").readText())
            .jsonObject.getValue("database").jsonObject

    private fun JsonObject.entities() = getValue("entities").jsonArray.associate {
        val e = it.jsonObject
        e.getValue("tableName").jsonPrimitive.content to e
    }

    private fun JsonObject.columns() = getValue("fields").jsonArray.associate {
        val f = it.jsonObject
        f.getValue("columnName").jsonPrimitive.content to f
    }

    @Test fun versionTwoLosesNoTableColumnOrIndexOfVersionOne() {
        val v1 = schema(1).entities(); val v2 = schema(2).entities()
        assertEquals(2, schema(2).getValue("version").jsonPrimitive.content.toInt())
        for ((table, old) in v1) {
            val now = v2[table] ?: error("v2 perdió la tabla $table")
            old.columns().forEach { (column, field) ->
                assertEquals("$table.$column cambió", field, now.columns()[column])
            }
            assertEquals("$table cambió de llave primaria", old.getValue("primaryKey"), now.getValue("primaryKey"))
            val oldIndexes = (old["indices"] as? JsonArray).orEmpty().map { it.jsonObject.getValue("name") }
            val nowIndexes = (now["indices"] as? JsonArray).orEmpty().map { it.jsonObject.getValue("name") }
            assertTrue("$table perdió un índice", nowIndexes.containsAll(oldIndexes))
        }
    }

    @Test fun onlyTheQueueGainsColumnsAndTheyAreNullableOrHaveDefaults() {
        val v1 = schema(1).entities(); val v2 = schema(2).entities()
        for (table in v1.keys - "operation_queue") assertEquals(v1.getValue(table), v2.getValue(table))
        val added = v2.getValue("operation_queue").columns().filterKeys { it !in v1.getValue("operation_queue").columns() }
        assertEquals(setOf("dependsOn", "entityRef", "ownerRole"), added.keys)
        // Room omite "notNull" cuando la columna admite nulos.
        assertNull(added.getValue("dependsOn")["notNull"])
        assertNull(added.getValue("entityRef")["notNull"])
        assertEquals("true", added.getValue("ownerRole").getValue("notNull").jsonPrimitive.content)
        assertEquals("'cajero'", added.getValue("ownerRole").getValue("defaultValue").jsonPrimitive.content)
    }

    @Test fun migrationSqlIsExactlyWhatRoomExportedForTheNewTablesAndIndexes() {
        val v1 = schema(1).entities(); val v2 = schema(2).entities()
        val sql = LocalMigrations.V1_TO_V2.toSet()
        for ((table, entity) in v2.filterKeys { it !in v1 }) {
            val create = entity.getValue("createSql").jsonPrimitive.content.replace("\${TABLE_NAME}", table)
            assertTrue("falta CREATE de $table", create in sql)
            (entity["indices"] as? JsonArray).orEmpty().forEach {
                val index = it.jsonObject.getValue("createSql").jsonPrimitive.content.replace("\${TABLE_NAME}", table)
                assertTrue("falta el índice: $index", index in sql)
            }
        }
        // Y nada más: solo CREATE ... IF NOT EXISTS y ALTER ... ADD COLUMN, sin DROP, DELETE, UPDATE ni reescrituras.
        for (statement in LocalMigrations.V1_TO_V2) {
            assertTrue(statement, statement.startsWith("CREATE TABLE IF NOT EXISTS") || statement.startsWith("CREATE INDEX IF NOT EXISTS") ||
                Regex("^ALTER TABLE `operation_queue` ADD COLUMN `(dependsOn|entityRef|ownerRole)` ").containsMatchIn(statement))
        }
        val alter = LocalMigrations.V1_TO_V2.filter { it.startsWith("ALTER") }
        assertEquals(3, alter.size)
        assertTrue(alter.any { it.endsWith("`ownerRole` TEXT NOT NULL DEFAULT 'cajero'") })
    }
}
