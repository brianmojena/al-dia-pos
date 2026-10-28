package cu.mypimes.pos.data.shared

import cu.mypimes.pos.domain.shared.SharedBundle
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton
import kotlinx.serialization.Serializable
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

@Serializable
data class ActivateRequest(val code: String)

/** Rutas de `server/routes/sharedEnroll.js` y `GET /api/auth/shared-device`. */
interface SharedApi {
    /** Sin sesión: el código de un solo uso es la credencial. */
    @POST("shared")
    suspend fun activate(@Body request: ActivateRequest): Response<SharedBundle>

    @GET("auth/shared-device")
    suspend fun renew(@Header("Authorization") authorization: String): Response<SharedBundle>
}

@Module
@InstallIn(SingletonComponent::class)
object SharedApiModule {
    @Provides @Singleton
    fun provideSharedApi(retrofit: Retrofit): SharedApi = retrofit.create(SharedApi::class.java)
}
