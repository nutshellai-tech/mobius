package com.mobius.momo.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AppConfigTest {
    @Test
    fun `saved server URL overrides the build default`() {
        assertEquals(
            "https://mobius.company.test",
            resolveMobiusBaseUrl(
                buildDefault = "https://build.example.test/",
                savedValue = " https://mobius.company.test/ ",
            ),
        )
    }

    @Test
    fun `build default is used when no saved URL exists`() {
        assertEquals(
            "https://build.example.test",
            resolveMobiusBaseUrl(
                buildDefault = "https://build.example.test/",
                savedValue = " ",
            ),
        )
    }

    @Test
    fun `blank configuration remains blank until the user configures it`() {
        assertEquals("", resolveMobiusBaseUrl(buildDefault = "", savedValue = null))
    }

    @Test
    fun `only HTTP and HTTPS server URLs are accepted`() {
        assertFailsWith<IllegalArgumentException> {
            normalizeMobiusBaseUrl("ftp://mobius.example.test")
        }
    }
}
