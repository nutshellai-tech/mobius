package com.mobius.momo.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.loadImageBitmap

@Composable
actual fun momoLogoPainter(): Painter {
    val image = remember {
        Thread.currentThread().contextClassLoader
            .getResourceAsStream("mobius_logo.png")
            ?.use { loadImageBitmap(it) }
    }
    return if (image != null) BitmapPainter(image) else ColorPainter(Color(0xFF5B6CFF))
}
