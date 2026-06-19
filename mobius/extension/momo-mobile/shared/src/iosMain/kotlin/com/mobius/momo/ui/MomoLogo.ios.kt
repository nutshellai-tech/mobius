package com.mobius.momo.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.graphics.painter.Painter
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import org.jetbrains.skia.Image
import platform.UIKit.UIImage
import platform.UIKit.UIImagePNGRepresentation
import platform.posix.memcpy

@OptIn(ExperimentalForeignApi::class)
@Composable
actual fun momoLogoPainter(): Painter {
    val image = remember {
        val uiImage = UIImage.imageNamed("MobiusLogo") ?: return@remember null
        val data = UIImagePNGRepresentation(uiImage) ?: return@remember null
        val bytes = ByteArray(data.length.toInt())
        bytes.usePinned { pinned ->
            memcpy(pinned.addressOf(0), data.bytes, data.length)
        }
        Image.makeFromEncoded(bytes).toComposeImageBitmap()
    }
    return if (image != null) BitmapPainter(image) else ColorPainter(Color(0xFF5B6CFF))
}
