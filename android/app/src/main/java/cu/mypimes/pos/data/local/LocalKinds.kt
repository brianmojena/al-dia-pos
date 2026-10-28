package cu.mypimes.pos.data.local

/** `kind` de `cache_records` para lo que baja la caja centralizada del dueño (los de ventas viven en `PosRepository`). */
object LocalKinds {
    const val WAREHOUSE = "warehouse_items"
    const val WAREHOUSE_TRANSFERS = "warehouse_transfers"
    const val STOCK_ENTRIES = "stock_entries"
    /** Última respuesta de `/products/day-stock`: se reconstruye en el servidor, aquí solo se guarda. */
    const val DAY_STOCK = "day_stock"
}
