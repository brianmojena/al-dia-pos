package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.MeResponse
import kotlinx.serialization.json.JsonObject
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Url

/** Caja, divisas, inicio y productos (escrituras). Separado de PosApi para no alterar sus pruebas. */
interface StoreApi {
    @GET("cash-closes/current")
    suspend fun currentPeriod(
        @Header("Authorization") authorization: String,
        @Query("register_id") registerId: String,
    ): Response<CurrentPeriodDto>

    @GET("cash-closes")
    suspend fun closes(@Header("Authorization") authorization: String): Response<List<CashCloseDto>>

    @GET("cash-closes/summary")
    suspend fun closeSummary(@Header("Authorization") authorization: String): Response<List<CashCloseSummaryDto>>

    @GET("cash-closes/{id}")
    suspend fun closeDetail(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
    ): Response<CashCloseDto>

    @POST("cash-closes")
    suspend fun createClose(
        @Header("Authorization") authorization: String,
        @Body request: CreateCloseRequest,
    ): Response<CashCloseDto>

    @GET("cash-withdrawals")
    suspend fun withdrawals(
        @Header("Authorization") authorization: String,
        @Query("date") date: String? = null,
        @Query("open") open: Int? = null,
    ): Response<List<WithdrawalDto>>

    @POST("cash-withdrawals")
    suspend fun createWithdrawal(
        @Header("Authorization") authorization: String,
        @Body request: CreateWithdrawalRequest,
    ): Response<WithdrawalDto>

    @POST("cash-withdrawals/{id}/void")
    suspend fun voidWithdrawal(
        @Header("Authorization") authorization: String,
        @Path("id") clientWithdrawalId: String,
    ): Response<WithdrawalDto>

    @GET("currency-purchases")
    suspend fun purchases(
        @Header("Authorization") authorization: String,
        @Query("date") date: String? = null,
    ): Response<List<CurrencyPurchaseDto>>

    @POST("currency-purchases")
    suspend fun createPurchase(
        @Header("Authorization") authorization: String,
        @Body request: CreatePurchaseRequest,
    ): Response<CurrencyPurchaseDto>

    // Cola del dueño (A6): se reenvía EXACTAMENTE el cuerpo guardado (el servidor hashea el cuerpo de `operation_id`).
    @POST
    suspend fun rawPost(
        @Header("Authorization") authorization: String,
        @Url url: String,
        @Body body: RequestBody,
    ): Response<ResponseBody>

    @PUT
    suspend fun rawPut(
        @Header("Authorization") authorization: String,
        @Url url: String,
        @Body body: RequestBody,
    ): Response<ResponseBody>

    @DELETE
    suspend fun rawDelete(
        @Header("Authorization") authorization: String,
        @Url url: String,
    ): Response<ResponseBody>

    // Tasas de la tienda (solo dueño). JsonObject para que un null llegue como null y borre la tasa.
    @PUT("auth/settings")
    suspend fun saveShopRates(
        @Header("Authorization") authorization: String,
        @Body request: JsonObject,
    ): Response<MeResponse>

    // Productos: el alta la puede hacer cualquier cuenta; editar y borrar, según rol (lo valida el servidor).
    @POST("products")
    suspend fun createProduct(
        @Header("Authorization") authorization: String,
        @Body request: JsonObject,
    ): Response<ProductSaveDto>

    @PUT("products/{id}")
    suspend fun updateProduct(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
        @Body request: JsonObject,
    ): Response<ProductSaveDto>

    @DELETE("products/{id}")
    suspend fun deleteProduct(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
    ): Response<ResponseBody>

    // Inventario: contar lo puede hacer cualquier cuenta; historial, detalle, corrección y stock del día, solo dueño.
    @GET("inventory-counts")
    suspend fun counts(@Header("Authorization") authorization: String): Response<List<InventoryCountDto>>

    @GET("inventory-counts/{id}")
    suspend fun countDetail(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
    ): Response<InventoryCountDto>

    @POST("inventory-counts")
    suspend fun createCount(
        @Header("Authorization") authorization: String,
        @Body request: CreateInventoryCountRequest,
    ): Response<InventoryCountDto>

    @PUT("inventory-counts/{id}")
    suspend fun correctCount(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
        @Body request: UpdateInventoryCountRequest,
    ): Response<InventoryCountDto>

    // Importación masiva: productos solo dueño; almacén, cualquier cuenta. Todo o nada (lo valida el servidor).
    @POST("products/import")
    suspend fun importProducts(
        @Header("Authorization") authorization: String,
        @Body request: JsonObject,
    ): Response<ImportResultDto>

    @POST("warehouse/import")
    suspend fun importWarehouse(
        @Header("Authorization") authorization: String,
        @Body request: JsonObject,
    ): Response<ImportResultDto>

    @GET("products/day-stock")
    suspend fun dayStock(@Header("Authorization") authorization: String): Response<DayStockDto>

    @GET("dashboard")
    suspend fun dashboard(@Header("Authorization") authorization: String): Response<DashboardDto>

    @GET("dashboard/day")
    suspend fun activityDay(
        @Header("Authorization") authorization: String,
        @Query("date") date: String? = null,
    ): Response<DailyActivityDto>

    // Vista por mes de Ventas (solo dueño): resumen de los días y el Excel del mes, como la web (Sales.jsx).
    @GET("reports/days")
    suspend fun monthDays(
        @Header("Authorization") authorization: String,
        @Query("month") month: String,
    ): Response<MonthDaysDto>

    @GET("reports/export")
    suspend fun monthExcel(
        @Header("Authorization") authorization: String,
        @Query("month") month: String,
    ): Response<ResponseBody>

    // Almacén: ver y pasar mercancía en ambos sentidos son de cualquier cuenta; el historial de pases, solo dueño.
    @GET("warehouse")
    suspend fun warehouse(@Header("Authorization") authorization: String): Response<List<WarehouseItemDto>>

    @POST("warehouse")
    suspend fun createWarehouseItem(
        @Header("Authorization") authorization: String,
        @Body request: JsonObject,
    ): Response<WarehouseItemDto>

    @PUT("warehouse/{id}")
    suspend fun updateWarehouseItem(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
        @Body request: JsonObject,
    ): Response<WarehouseItemDto>

    @DELETE("warehouse/{id}")
    suspend fun deleteWarehouseItem(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
    ): Response<ResponseBody>

    @GET("warehouse/changes")
    suspend fun warehouseChanges(@Header("Authorization") authorization: String): Response<List<WarehouseChangeDto>>

    @GET("warehouse/transfers")
    suspend fun warehouseTransfers(@Header("Authorization") authorization: String): Response<List<WarehousePassDto>>

    @POST("warehouse/transfer")
    suspend fun transferToStore(
        @Header("Authorization") authorization: String,
        @Body request: ToStoreTransferRequest,
    ): Response<WarehousePassDto>

    @POST("warehouse/from-store")
    suspend fun transferToWarehouse(
        @Header("Authorization") authorization: String,
        @Body request: FromStoreTransferRequest,
    ): Response<WarehousePassDto>

    @GET("auth/cashiers")
    suspend fun cashiers(@Header("Authorization") authorization: String): Response<List<CashierDto>>

    @POST("auth/cashiers")
    suspend fun createCashier(
        @Header("Authorization") authorization: String,
        @Body request: CreateCashierRequest,
    ): Response<CashierDto>

    @DELETE("auth/cashiers/{id}")
    suspend fun deleteCashier(
        @Header("Authorization") authorization: String,
        @Path("id") id: Int,
    ): Response<JsonObject>

    // Correcciones de ventas (solo dueño; el servidor lo exige con `requireOwner`).
    @GET("sales/corrections")
    suspend fun saleCorrectionsOfDay(
        @Header("Authorization") authorization: String,
        @Query("date") date: String,
    ): Response<List<SaleCorrectionDto>>

    @GET("sales/{id}/corrections")
    suspend fun saleCorrections(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
    ): Response<List<SaleCorrectionDto>>

    @POST("sales/{id}/correct")
    suspend fun correctSale(
        @Header("Authorization") authorization: String,
        @Path("id") id: Long,
        @Body request: CorrectSaleRequest,
    ): Response<CorrectSaleResponse>

    // Contabilidad (solo dueño y plan Enterprise; el servidor responde 403 PLAN_REQUIRED en Basic).
    @GET("accounting/summary")
    suspend fun accountingSummary(
        @Header("Authorization") authorization: String,
        @Query("month") month: String,
    ): Response<AccountingSummaryDto>

    @GET("accounting/expenses")
    suspend fun accountingExpenses(
        @Header("Authorization") authorization: String,
        @Query("month") month: String,
    ): Response<List<ExpenseDto>>

    @POST("accounting/expenses")
    suspend fun createExpense(
        @Header("Authorization") authorization: String,
        @Body request: CreateExpenseRequest,
    ): Response<ExpenseDto>

    @POST("accounting/expenses/{id}/void")
    suspend fun voidExpense(
        @Header("Authorization") authorization: String,
        @Path("id") clientExpenseId: String,
    ): Response<ExpenseDto>

    @GET("accounting/export")
    suspend fun accountingExport(
        @Header("Authorization") authorization: String,
        @Query("month") month: String,
    ): Response<ResponseBody>

    // Auditoría de cierres (solo dueño; el servidor lo exige con `requireOwner`).
    @GET("audit/reports")
    suspend fun auditReports(
        @Header("Authorization") authorization: String,
        @Query("severity") severity: String? = null,
    ): Response<List<AuditReportDto>>
}
