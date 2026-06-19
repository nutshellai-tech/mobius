package com.mobius.momo.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import com.mobius.momo.shared.R

@Composable
actual fun momoLogoPainter(): Painter = painterResource(R.drawable.mobius_logo)
