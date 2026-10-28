package cu.mypimes.pos.data.sync

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.QueryMap

/** Descarga incremental: el mismo endpoint y los mismos cursores que la web. */
interface SyncApi {
    @GET("sync/snapshot")
    suspend fun changes(
        @Header("Authorization") authorization: String,
        @QueryMap query: Map<String, String>,
    ): Response<ChangesPage>
}

@Module
@InstallIn(SingletonComponent::class)
object SyncApiModule {
    @Provides @Singleton
    fun provideSyncApi(retrofit: Retrofit): SyncApi = retrofit.create(SyncApi::class.java)
}
