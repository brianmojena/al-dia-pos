package cu.mypimes.pos.data.auth

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface ApiService {
    // BuildConfig.API_BASE_URL already ends in /api/.
    @POST("auth/login")
    suspend fun login(@Body request: LoginRequest): Response<LoginResponse>

    @POST("auth/register")
    suspend fun register(@Body request: RegisterRequest): Response<LoginResponse>

    @POST("auth/reset-password")
    suspend fun resetPassword(@Body request: ResetPasswordRequest): Response<ResponseBody>

    @GET("auth/me")
    suspend fun me(): Response<MeResponse>
}

@kotlinx.serialization.Serializable
data class MeResponse(val user: ApiUserDto)
