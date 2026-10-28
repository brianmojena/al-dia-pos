package cu.mypimes.pos.data.store

import org.junit.Assert.assertEquals
import org.junit.Test

class ShopRatesBodyTest {
    // Un null debe viajar como null: si la clave falta, el servidor no cambia la tasa.
    @Test
    fun clearedRateIsSentAsExplicitNull() {
        assertEquals("""{"usd_rate":null,"eur_rate":510.5}""", shopRatesBody(null, 510.5).toString())
        assertEquals("""{"usd_rate":480.0,"eur_rate":null}""", shopRatesBody(480.0, null).toString())
    }
}
