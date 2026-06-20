package com.mobius.momo.preview

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

private val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")

@Composable
fun PreviewStatusBar(modifier: Modifier = Modifier) {
    val currentTime by produceState(initialValue = formattedCurrentTime()) {
        while (true) {
            val now = LocalDateTime.now()
            value = now.format(timeFormatter)
            delay(((60 - now.second) * 1_000L) - now.nano / 1_000_000L)
        }
    }

    Row(
        modifier = modifier
            .height(DevicePreviewSpec.topSafeArea)
            .background(Color(0xFF161616))
            .padding(horizontal = 21.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = currentTime,
            color = Color.White,
            fontFamily = FontFamily.SansSerif,
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp,
            lineHeight = 17.sp,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(top = 1.dp),
        ) {
            WifiIcon()
            Spacer(Modifier.width(7.dp))
            BatteryIcon()
        }
    }
}

private fun formattedCurrentTime(): String = LocalDateTime.now().format(timeFormatter)

@Composable
private fun WifiIcon() {
    Canvas(Modifier.size(width = 18.dp, height = 13.dp)) {
        val path = Path().apply {
            moveTo(size.width * 0.08f, size.height * 0.35f)
            quadraticBezierTo(size.width * 0.50f, -size.height * 0.04f, size.width * 0.92f, size.height * 0.35f)
            lineTo(size.width * 0.79f, size.height * 0.51f)
            quadraticBezierTo(size.width * 0.50f, size.height * 0.23f, size.width * 0.21f, size.height * 0.51f)
            close()

            moveTo(size.width * 0.29f, size.height * 0.61f)
            quadraticBezierTo(size.width * 0.50f, size.height * 0.42f, size.width * 0.71f, size.height * 0.61f)
            lineTo(size.width * 0.58f, size.height * 0.77f)
            quadraticBezierTo(size.width * 0.50f, size.height * 0.69f, size.width * 0.42f, size.height * 0.77f)
            close()

            moveTo(size.width * 0.50f, size.height * 0.82f)
            lineTo(size.width * 0.61f, size.height)
            lineTo(size.width * 0.39f, size.height)
            close()
        }
        drawPath(path, Color.White)
    }
}

@Composable
private fun BatteryIcon() {
    Canvas(Modifier.size(width = 25.dp, height = 13.dp)) {
        val body = Path().apply {
            moveTo(size.width * 0.05f, size.height * 0.10f)
            lineTo(size.width * 0.84f, size.height * 0.10f)
            quadraticBezierTo(size.width * 0.91f, size.height * 0.10f, size.width * 0.91f, size.height * 0.25f)
            lineTo(size.width * 0.91f, size.height * 0.75f)
            quadraticBezierTo(size.width * 0.91f, size.height * 0.90f, size.width * 0.84f, size.height * 0.90f)
            lineTo(size.width * 0.05f, size.height * 0.90f)
            quadraticBezierTo(0f, size.height * 0.90f, 0f, size.height * 0.75f)
            lineTo(0f, size.height * 0.25f)
            quadraticBezierTo(0f, size.height * 0.10f, size.width * 0.05f, size.height * 0.10f)
            close()
        }
        drawPath(body, Color.White, style = Stroke(width = 1.2.dp.toPx()))

        val charge = Path().apply {
            moveTo(size.width * 0.10f, size.height * 0.23f)
            lineTo(size.width * 0.72f, size.height * 0.23f)
            lineTo(size.width * 0.72f, size.height * 0.77f)
            lineTo(size.width * 0.10f, size.height * 0.77f)
            close()
        }
        drawPath(charge, Color.White)

        val terminal = Path().apply {
            moveTo(size.width * 0.95f, size.height * 0.36f)
            quadraticBezierTo(size.width, size.height * 0.41f, size.width, size.height * 0.50f)
            quadraticBezierTo(size.width, size.height * 0.59f, size.width * 0.95f, size.height * 0.64f)
        }
        drawPath(terminal, Color.White, style = Stroke(width = 1.6.dp.toPx()))
    }
}
