package com.mobius.momo.preview

import androidx.compose.desktop.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowState
import androidx.compose.ui.window.application
import com.mobius.momo.ui.MomoApp

@Preview
fun main() = application {
    Window(
        onCloseRequest = ::exitApplication,
        title = "小莫助理移动端预览",
        state = WindowState(width = 390.dp, height = 844.dp),
    ) {
        MomoApp()
    }
}
