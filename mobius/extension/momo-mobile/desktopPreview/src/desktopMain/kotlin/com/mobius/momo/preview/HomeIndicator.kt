package com.mobius.momo.preview

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape

@Composable
fun PreviewHomeIndicator(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .height(DevicePreviewSpec.bottomSafeArea)
            .background(Color.White),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .width(DevicePreviewSpec.homeIndicatorWidth)
                .height(DevicePreviewSpec.homeIndicatorHeight)
                .background(Color.Black, RoundedCornerShape(100.dp)),
        )
    }
}
