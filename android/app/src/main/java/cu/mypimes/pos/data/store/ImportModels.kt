package cu.mypimes.pos.data.store

import kotlinx.serialization.Serializable

/** Respuesta de POST products/import y warehouse/import. */
@Serializable
data class ImportResultDto(val created: Int = 0, val updated: Int = 0, val total: Int = 0, @kotlinx.serialization.Transient val queued: Boolean = false)
