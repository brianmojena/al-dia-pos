package cu.mypimes.pos.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Paleta tomada de la web (client/src/index.css): fondo gris muy claro,
 * tarjetas blancas y azul de acción. Los colores semánticos de cobro se
 * mantienen iguales en todas las pantallas: verde efectivo, azul
 * transferencia, ámbar divisa.
 */
object AlDiaColors {
    val Blue = Color(0xFF007AFF)
    val BlueDark = Color(0xFF0062CC)
    val BlueSoft = Color(0xFFEAF3FF)
    val Background = Color(0xFFF5F5F7)
    val Surface = Color(0xFFFFFFFF)
    val SurfaceMuted = Color(0xFFF9FAFB)
    val Border = Color(0xFFE5E7EB)
    val BorderSoft = Color(0xFFF0F0F2)

    val TextPrimary = Color(0xFF111827)
    val TextSecondary = Color(0xFF6B7280)
    val TextTertiary = Color(0xFF9CA3AF)

    val Cash = Color(0xFF10B981)
    val CashSoft = Color(0xFFE8F8F1)
    val Transfer = Blue
    val TransferSoft = BlueSoft
    val Foreign = Color(0xFFF59E0B)
    val ForeignSoft = Color(0xFFFEF5E7)
    val Euro = Color(0xFF8B5CF6)
    val EuroSoft = Color(0xFFF3EEFF)

    val Success = Color(0xFF059669)
    val SuccessSoft = Color(0xFFE7F7F0)
    val Warning = Color(0xFFB45309)
    val WarningSoft = Color(0xFFFFF7E6)
    val Danger = Color(0xFFDC2626)
    val DangerSoft = Color(0xFFFDECEC)
}

private val AlDiaColorScheme = lightColorScheme(
    primary = AlDiaColors.Blue,
    onPrimary = Color.White,
    primaryContainer = AlDiaColors.BlueSoft,
    onPrimaryContainer = AlDiaColors.BlueDark,
    secondary = AlDiaColors.Cash,
    onSecondary = Color.White,
    secondaryContainer = AlDiaColors.CashSoft,
    onSecondaryContainer = Color(0xFF065F46),
    tertiary = AlDiaColors.Foreign,
    onTertiary = Color.White,
    tertiaryContainer = AlDiaColors.ForeignSoft,
    onTertiaryContainer = Color(0xFF7C2D12),
    background = AlDiaColors.Background,
    onBackground = AlDiaColors.TextPrimary,
    surface = AlDiaColors.Surface,
    onSurface = AlDiaColors.TextPrimary,
    surfaceVariant = AlDiaColors.SurfaceMuted,
    onSurfaceVariant = AlDiaColors.TextSecondary,
    outline = AlDiaColors.Border,
    outlineVariant = AlDiaColors.BorderSoft,
    error = AlDiaColors.Danger,
    onError = Color.White,
    errorContainer = AlDiaColors.DangerSoft,
    onErrorContainer = Color(0xFF7F1D1D),
)

private val AlDiaTypography = Typography().let { base ->
    base.copy(
        headlineLarge = base.headlineLarge.copy(fontWeight = FontWeight.Bold, fontSize = 32.sp, letterSpacing = (-0.5).sp),
        headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.Bold, fontSize = 26.sp, letterSpacing = (-0.3).sp),
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Bold, fontSize = 22.sp),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
        titleSmall = base.titleSmall.copy(fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
        bodyLarge = base.bodyLarge.copy(fontSize = 16.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 14.sp),
        bodySmall = base.bodySmall.copy(fontSize = 12.sp),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
        labelSmall = base.labelSmall.copy(fontSize = 11.sp, letterSpacing = 0.4.sp),
    )
}

private val AlDiaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun AlDiaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AlDiaColorScheme,
        typography = AlDiaTypography,
        shapes = AlDiaShapes,
        content = content,
    )
}
