package cu.mypimes.pos.data.pos

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** Small injectable boundary so repository tests do not need Android preferences or WorkManager. */
interface RegisterIdStore {
    fun getOrCreate(): String
}

interface PosSyncScheduler {
    fun schedule(accountKey: String)
}

/** Caja central: clave bajo la que se guarda el catálogo. Fuera de ese modo devuelve la clave de la cuenta. */
interface CatalogScope {
    fun catalogKey(accountKey: String): String
}

@Singleton
class AndroidCatalogScope @Inject constructor(
    private val shared: dagger.Lazy<cu.mypimes.pos.data.shared.SharedDeviceRepository>,
) : CatalogScope {
    override fun catalogKey(accountKey: String) = shared.get().catalogKey(accountKey)
}

@Singleton
class AndroidRegisterIdStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val shared: dagger.Lazy<cu.mypimes.pos.data.shared.SharedDeviceRepository>,
) : RegisterIdStore {
    override fun getOrCreate(): String {
        // En una caja compartida el servidor exige `shared:<caja>[:<cajero>]`; si no, rechaza la operación.
        shared.get().registerIdForCurrent()?.let { return it }
        val prefs = context.getSharedPreferences("pos_register", Context.MODE_PRIVATE)
        prefs.getString(KEY_REGISTER_ID, null)?.let { return it }
        val id = "desk-${UUID.randomUUID()}"
        check(prefs.edit().putString(KEY_REGISTER_ID, id).commit()) { "No se pudo guardar el identificador de caja" }
        return id
    }

    private companion object { const val KEY_REGISTER_ID = "register_id" }
}

@Singleton
class WorkManagerPosSyncScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
) : PosSyncScheduler {
    override fun schedule(accountKey: String) {
        val request = OneTimeWorkRequestBuilder<PosSyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInputData(Data.Builder().putString(PosSyncWorker.INPUT_ACCOUNT, accountKey).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "pos-sales-sync-$accountKey", ExistingWorkPolicy.APPEND_OR_REPLACE, request,
        )
    }
}

@Module
@InstallIn(SingletonComponent::class)
abstract class PosRuntimeModule {
    @Binds @Singleton
    abstract fun bindRegisterIdStore(implementation: AndroidRegisterIdStore): RegisterIdStore

    @Binds @Singleton
    abstract fun bindCatalogScope(implementation: AndroidCatalogScope): CatalogScope

    @Binds @Singleton
    abstract fun bindPosSyncScheduler(implementation: WorkManagerPosSyncScheduler): PosSyncScheduler
}
