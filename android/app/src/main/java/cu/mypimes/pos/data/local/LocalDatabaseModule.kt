package cu.mypimes.pos.data.local

import android.content.Context
import androidx.room.Room
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object LocalDatabaseModule {
    @Provides @Singleton
    fun provideDatabase(@ApplicationContext context: Context): LocalDatabase =
        Room.databaseBuilder(context, LocalDatabase::class.java, "mypimes-local.db")
            .addMigrations(LocalMigrations.MIGRATION_1_2)
            // No destructive migration fallback: a missing migration must fail visibly, not erase work.
            .build()

    @Provides
    fun provideLocalDao(database: LocalDatabase): LocalDao = database.localDao()
}
