package com.mobius.momo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.mobius.momo.data.AndroidContext
import com.mobius.momo.ui.MomoApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AndroidContext.activity = this
        setContent { MomoApp() }
    }

    override fun onDestroy() {
        if (AndroidContext.activity === this) AndroidContext.activity = null
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        AndroidContext.handlePermissionResult(requestCode, grantResults)
    }

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        AndroidContext.handleActivityResult(requestCode, resultCode, data)
    }
}
