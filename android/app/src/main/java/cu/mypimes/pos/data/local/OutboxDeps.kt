package cu.mypimes.pos.data.local

import cu.mypimes.pos.domain.outbox.Outbox

/** A5: dependencias de la cola contra Room. Las reglas puras viven en `domain/outbox/Outbox`. */
fun shopPrefix(accountKey: String) = accountKey.substringBefore(':') + ":%"

/** Altas pendientes de las que depende una operación que usa ids temporales; vacío si no usa ninguno. */
suspend fun dependenciesFor(dao: LocalDao, accountKey: String, path: String, payload: String): List<String> =
    Outbox.tempRefs(path, payload).mapNotNull { (entity, id) ->
        dao.creatorOf(shopPrefix(accountKey), entity.createType, id.toString())?.clientOperationId
    }.distinct()

/** Aplica la cascada de bloqueos de `Outbox.settle` a toda la tienda. Solo cambia estados; no borra nada. */
suspend fun settleDependencies(dao: LocalDao, accountKey: String) {
    val prefix = shopPrefix(accountKey)
    val queue = dao.shopQueue(prefix)
    val deps = dao.shopDependencies(prefix).groupBy({ it.clientOperationId }, { it.dependsOnClientOperationId })
    val plan = Outbox.settle(queue, deps)
    val byId = queue.associateBy { it.clientOperationId }
    plan.block.forEach { (id, reason) ->
        val op = byId.getValue(id)
        dao.setQueueState(id, op.accountKey, Outbox.STATUS_BLOCKED, op.attempts, reason)
    }
    plan.unblock.forEach { id ->
        val op = byId.getValue(id)
        dao.setQueueState(id, op.accountKey, QueuedOperationEntity.STATUS_PENDING, op.attempts, null)
    }
}

/** Resultado de mirar si una operación puede subir ahora (otra cuenta de la misma tienda puede ser su dependencia). */
suspend fun gateOf(dao: LocalDao, operation: QueuedOperationEntity): Outbox.Gate {
    val ids = dao.dependenciesOf(operation.clientOperationId)
    val found = ids.associateWith { dao.operationById(it) }
    return Outbox.gate(ids) { found[it] }
}

/** Rol con el que se sube la operación: el del token de quien la crea. */
fun ownerRoleOf(token: String): String =
    if (cu.mypimes.pos.domain.shared.SharedLogic.claims(token)?.role == Outbox.ROLE_OWNER) Outbox.ROLE_OWNER else Outbox.ROLE_CASHIER
