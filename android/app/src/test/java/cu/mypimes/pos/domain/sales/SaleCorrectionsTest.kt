package cu.mypimes.pos.domain.sales

import cu.mypimes.pos.data.pos.SaleDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SaleCorrectionsTest {
    private val cash = SaleDto(id = 1, total = 1000.0, paymentMethod = "efectivo")
    private val usd = SaleDto(id = 2, total = 700.0, paymentMethod = "divisa", foreignCurrency = "USD", foreignAmount = 2.0, exchangeRate = 350.0)

    private fun choice(method: String, transfer: String = "", currency: String = "USD", amount: String = "", rate: String = "") =
        SaleCorrections.Choice(method, transfer, currency, amount, rate)

    @Test
    fun simpleMethodsSendOnlyTheMethod() {
        val built = SaleCorrections.paymentRequest(cash, choice("transferencia"), "  error del cajero ")
        assertNull(built.error)
        val r = built.request!!
        assertEquals("pago", r.action); assertEquals("transferencia", r.paymentMethod)
        assertEquals("error del cajero", r.reason)
        assertNull(r.transferAmount); assertNull(r.foreignCurrency)
    }

    @Test
    fun sameMethodIsRejectedLikeTheServer() {
        assertEquals("La venta ya tiene esa forma de pago", SaleCorrections.paymentRequest(cash, choice("efectivo"), "").error)
        assertEquals(
            "La venta ya tiene esa forma de pago",
            SaleCorrections.paymentRequest(usd, choice("divisa", currency = "USD", amount = "2", rate = "350"), "").error,
        )
        // Mismos billetes con otra tasa sí es un cambio.
        assertNull(SaleCorrections.paymentRequest(usd, choice("divisa", currency = "USD", amount = "2", rate = "360"), "").error)
    }

    @Test
    fun mixedTransferMustBePositiveAndBelowTotal() {
        assertEquals("Falta el monto transferido del cobro mixto", SaleCorrections.paymentRequest(cash, choice("mixto"), "").error)
        assertEquals("Falta el monto transferido del cobro mixto", SaleCorrections.paymentRequest(cash, choice("mixto", "0"), "").error)
        assertEquals("El monto transferido tiene que ser menor que el total", SaleCorrections.paymentRequest(cash, choice("mixto", "1000"), "").error)
        val ok = SaleCorrections.paymentRequest(cash, choice("mixto", "400,505"), "").request!!
        assertEquals(400.51, ok.transferAmount!!, 0.0)
        assertEquals("mixto", ok.paymentMethod)
    }

    @Test
    fun foreignNeedsCurrencyAmountAndRate() {
        assertTrue(SaleCorrections.paymentRequest(cash, choice("divisa", rate = "350"), "").error!!.startsWith("Falta cuántos"))
        assertEquals("Falta la tasa de cambio del cobro", SaleCorrections.paymentRequest(cash, choice("divisa", amount = "2"), "").error)
        assertEquals("Moneda inválida: solo USD o EUR", SaleCorrections.paymentRequest(cash, choice("divisa", currency = "GBP", amount = "2", rate = "350"), "").error)
        val r = SaleCorrections.paymentRequest(cash, choice("divisa", currency = "EUR", amount = "3,5", rate = "380"), "").request!!
        assertEquals("EUR", r.foreignCurrency); assertEquals(3.5, r.foreignAmount!!, 0.0); assertEquals(380.0, r.exchangeRate!!, 0.0)
    }

    @Test
    fun initialChoiceSuggestsTheOtherMethod() {
        val fromCash = SaleCorrections.initialChoice(cash) { if (it == "USD") 350.0 else null }
        assertEquals("transferencia", fromCash.method)
        assertEquals("350", fromCash.rate)
    }

    @Test
    fun initialChoiceProposesBillsToCoverTheTotal() {
        val c = SaleCorrections.initialChoice(cash) { 350.0 }
        assertEquals("2.86", c.amount)
        val fromForeign = SaleCorrections.initialChoice(usd) { 350.0 }
        assertEquals("efectivo", fromForeign.method); assertEquals("2", fromForeign.amount)
        assertEquals("", SaleCorrections.initialChoice(cash) { null }.amount)
        assertEquals("3.34", SaleCorrections.withCurrency(c, 1000.0, "EUR", 300.0).amount)
    }

    @Test
    fun voidAndReasonAndCloseResult() {
        assertEquals("anular", SaleCorrections.voidRequest("").action)
        assertNull(SaleCorrections.voidRequest("   ").reason)
        assertEquals(200, SaleCorrections.voidRequest("x".repeat(300)).reason!!.length)
        assertEquals("cuadró", SaleCorrections.closeResult(0.2) { it.toString() })
        assertEquals("faltaron 1200.0", SaleCorrections.closeResult(-1200.0) { it.toString() })
        assertEquals("sobraron 300.0", SaleCorrections.closeResult(300.0) { it.toString() })
    }
}
