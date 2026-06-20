package com.mobius.momo.preview

import kotlin.test.Test
import kotlin.test.assertEquals

class DevicePreviewSpecTest {
    @Test
    fun `device canvas and safe areas match the preview contract`() {
        assertEquals(430, DevicePreviewSpec.windowWidth.value.toInt())
        assertEquals(900, DevicePreviewSpec.windowHeight.value.toInt())
        assertEquals(47, DevicePreviewSpec.topSafeArea.value.toInt())
        assertEquals(34, DevicePreviewSpec.bottomSafeArea.value.toInt())
    }

    @Test
    fun `device chrome dimensions match the preview contract`() {
        assertEquals(47, DevicePreviewSpec.deviceCornerRadius.value.toInt())
        assertEquals(4, DevicePreviewSpec.deviceBorderWidth.value.toInt())
        assertEquals(200, DevicePreviewSpec.notchWidth.value.toInt())
        assertEquals(30, DevicePreviewSpec.notchHeight.value.toInt())
        assertEquals(134, DevicePreviewSpec.homeIndicatorWidth.value.toInt())
        assertEquals(5, DevicePreviewSpec.homeIndicatorHeight.value.toInt())
    }
}
