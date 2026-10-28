package cu.mypimes.pos.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cu.mypimes.pos.ui.theme.AlDiaColors

@Composable
fun AlDiaCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(20.dp),
        color = AlDiaColors.Surface,
        border = BorderStroke(1.dp, AlDiaColors.BorderSoft),
        shadowElevation = 0.dp,
    ) {
        Box(Modifier.padding(16.dp)) { content() }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier,
        style = MaterialTheme.typography.titleSmall,
        color = AlDiaColors.TextSecondary,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    color: Color = AlDiaColors.Blue,
    height: Int = 52,
) {
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier.fillMaxWidth().height(height.dp),
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = color,
            contentColor = Color.White,
            disabledContainerColor = color.copy(alpha = 0.35f),
            disabledContentColor = Color.White.copy(alpha = 0.9f),
        ),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
            Spacer(Modifier.width(10.dp))
        }
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
fun AlDiaField(
    label: String? = null,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    enabled: Boolean = true,
    singleLine: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text,
    supporting: String? = null,
    big: Boolean = false,
    autoFocus: Boolean = false,
) {
    Column(modifier) {
        if (label != null) {
            Text(
                label.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(6.dp))
        }
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = enabled,
            singleLine = singleLine,
            placeholder = { Text(placeholder, color = AlDiaColors.TextTertiary) },
            textStyle = if (big) MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold)
            else MaterialTheme.typography.bodyLarge,
            shape = RoundedCornerShape(14.dp),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = AlDiaColors.Blue,
                unfocusedBorderColor = AlDiaColors.Border,
                focusedContainerColor = Color.White,
                unfocusedContainerColor = Color.White,
                disabledContainerColor = AlDiaColors.SurfaceMuted,
            ),
        )
        if (supporting != null) {
            Spacer(Modifier.height(5.dp))
            Text(supporting, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextTertiary)
        }
    }
}

@Composable
fun Pill(
    text: String,
    color: Color,
    background: Color,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(background)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = color, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun InfoBanner(text: String, modifier: Modifier = Modifier, tone: Color = AlDiaColors.Blue) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(tone.copy(alpha = 0.09f))
            .padding(horizontal = 14.dp, vertical = 11.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = tone, fontWeight = FontWeight.Medium)
    }
}

/** Aviso de que lo que se ve sale del aparato y no de la nube; no dice nada si `since` es null. */
@Composable
fun StaleNote(since: Long?, modifier: Modifier = Modifier, extra: String? = null) {
    if (since == null) return
    InfoBanner(
        cu.mypimes.pos.domain.Freshness.label(since) + (extra?.let { ". $it" } ?: ""),
        modifier.padding(bottom = 10.dp), tone = AlDiaColors.Warning,
    )
}

@Composable
fun ErrorBanner(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AlDiaColors.DangerSoft)
            .padding(horizontal = 14.dp, vertical = 11.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.Danger, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun EmptyBlock(title: String, message: String? = null, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(AlDiaColors.Surface)
            .padding(horizontal = 20.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextSecondary)
        if (message != null) {
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.TextTertiary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
fun LoadingBlock(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = AlDiaColors.Blue, strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
    }
}

@Composable
fun KeyValueRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    valueColor: Color = AlDiaColors.TextPrimary,
    bold: Boolean = false,
) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary)
        Text(
            value,
            style = if (bold) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
            color = valueColor,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium,
        )
    }
}
