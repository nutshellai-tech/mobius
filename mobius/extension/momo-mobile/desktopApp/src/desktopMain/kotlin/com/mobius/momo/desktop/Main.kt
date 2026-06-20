package com.mobius.momo.desktop

import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowState
import androidx.compose.ui.window.application
import com.mobius.momo.ui.MomoApp

fun main() = application {
    Window(
        onCloseRequest = ::exitApplication,
        title = "小莫助理",
        state = WindowState(width = 1080.dp, height = 760.dp),
    ) {
        MomoApp()
    }
}
