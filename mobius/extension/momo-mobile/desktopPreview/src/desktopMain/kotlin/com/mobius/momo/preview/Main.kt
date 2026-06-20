package com.mobius.momo.preview

import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.WindowState
import androidx.compose.ui.window.application
import com.mobius.momo.ui.MomoApp

@Preview
fun main() = application {
    Window(
        onCloseRequest = ::exitApplication,
        title = "小莫助理移动端预览",
        state = WindowState(
            position = WindowPosition(0.dp, 0.dp),
            width = DevicePreviewSpec.windowWidth,
            height = DevicePreviewSpec.windowHeight,
        ),
        undecorated = true,
        resizable = false,
    ) {
        DevicePreview()
    }
}

@Composable
private fun DevicePreview() {
    val deviceShape = RoundedCornerShape(DevicePreviewSpec.deviceCornerRadius)

    Box(
        modifier = Modifier
            .size(DevicePreviewSpec.windowWidth, DevicePreviewSpec.windowHeight)
            .background(Color(0xFF2B2B2B)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(deviceShape)
                .background(Color.Black)
                .border(
                    width = DevicePreviewSpec.deviceBorderWidth,
                    color = Color.Black,
                    shape = deviceShape,
                ),
        ) {
            Column(Modifier.fillMaxSize()) {
                PreviewStatusBar(Modifier.fillMaxWidth())
                Box(Modifier.weight(1f).background(Color.White)) {
                    MomoApp()
                }
                PreviewHomeIndicator(Modifier.fillMaxWidth())
            }

            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .size(DevicePreviewSpec.notchWidth, DevicePreviewSpec.notchHeight)
                    .clip(RoundedCornerShape(bottomStart = 16.dp, bottomEnd = 16.dp))
                    .background(Color.Black),
            )
        }
    }
}
