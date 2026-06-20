package com.mobius.momo

import android.app.Application
import com.mobius.momo.data.AndroidContext

class MomoApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AndroidContext.application = this
    }
}
