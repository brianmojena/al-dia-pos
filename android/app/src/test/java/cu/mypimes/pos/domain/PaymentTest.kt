package cu.mypimes.pos.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PaymentTest {
    private fun field(x: JsonObject, name: String): JsonElement = x[name] ?: JsonNull
    private fun num(x: JsonObject, name: String): Double = field(x, name).let { if (it is JsonNull) 0.0 else it.jsonNumber() }
    private fun nullableNum(x: JsonObject, name: String): Double? = field(x, name).let { if (it is JsonNull) null else it.jsonNumber() }
    private fun str(x: JsonObject, name: String): String? = field(x, name).let { if (it is JsonNull) null else it.jsonString() }
    private fun any(x: JsonElement): Any? = when (x) {
        JsonNull -> null
        is JsonObject -> x.mapValues { any(it.value) }
        is JsonArray -> x.map(::any)
        is JsonPrimitive -> when {
            x.isString && x.content == "\$NaN" -> Double.NaN
            x.isString -> x.content
            x.content == "true" -> true
            x.content == "false" -> false
            else -> x.content.toDoubleOrNull() ?: x.content
        }
    }
    private fun JsonElement.jsonNumber(): Double = (this as JsonPrimitive).content.toDouble()
    private fun JsonElement.jsonString(): String = (this as JsonPrimitive).content
    private fun splitMap(s: Payment.Split) = mapOf("cash" to s.cash, "transfer" to s.transfer, "usd" to s.usd, "eur" to s.eur, "foreign_cup" to s.foreign_cup)
    private fun fieldsMap(v: Payment.ForeignFields) = mapOf("foreign_currency" to v.foreign_currency, "foreign_amount" to v.foreign_amount, "exchange_rate" to v.exchange_rate, "shop_rate" to v.shop_rate)
    private fun purchaseFieldsMap(v: Payment.PurchaseFields) = mapOf("foreign_currency" to v.foreign_currency, "foreign_amount" to v.foreign_amount, "exchange_rate" to v.exchange_rate, "shop_rate" to v.shop_rate, "cup_amount" to v.cup_amount)
    private fun cashMap(v: Payment.CashBreakdown) = mapOf("totalCents" to v.totalCents, "receivedCents" to v.receivedCents?.toDouble(), "changeCents" to v.changeCents, "shortfallCents" to v.shortfallCents, "validAmount" to v.validAmount, "canConfirm" to v.canConfirm)
    private fun withdrawalMap(method: String, amount: Double, note: String?) = mapOf("method" to method, "amount" to amount, "note" to note)

    @Test fun sharedJsonCasesMatchJavascriptReference() {
        val source = javaClass.classLoader!!.getResourceAsStream("payment-cases.json")
            ?: error("Missing payment-cases.json from test resources")
        val cases = Json.parseToJsonElement(source.bufferedReader().use { it.readText() }).jsonArray
        cases.forEach { element ->
            val testCase = element.jsonObject
            val input = testCase.getValue("input").jsonObject
            val expected = testCase["expected"]?.let(::any)
            var actualError: String? = null
            val actual: Any? = try { when (testCase.getValue("op").jsonString()) {
                "round2" -> Payment.round2(any(field(input, "value")))
                "paymentLabel" -> Payment.paymentLabel(str(input, "method"), str(input, "currency"))
                "paymentSplit" -> splitMap(Payment.paymentSplit(any(field(input, "total")), str(input, "method"), any(field(input, "transferAmount")), str(input, "currency"), any(field(input, "foreignAmount")), any(field(input, "rate"))))
                "serverPaymentSplit" -> splitMap(Payment.paymentSplit(any(field(input, "total")), str(input, "method"), any(field(input, "transferAmount")), str(input, "currency"), any(field(input, "foreignAmount")), any(field(input, "rate")), serverSemantics = true))
                "foreignBreakdown" -> Payment.foreignBreakdown(any(field(input, "total")), any(field(input, "amount")), any(field(input, "rate"))).let { mapOf("foreignCup" to it.foreignCup, "cashToCollect" to it.cashToCollect, "change" to it.change) }
                "foreignNeeded" -> Payment.foreignNeeded(any(field(input, "total")), any(field(input, "rate")))
                "maxTransfer" -> Payment.maxTransfer(num(input, "total"), nullableNum(input, "limit"))
                "initialTransfer" -> Payment.initialTransfer(num(input, "total"), nullableNum(input, "limit"))
                "clampTransfer" -> Payment.clampTransfer(any(field(input, "value")), num(input, "total"), nullableNum(input, "limit"))
                "mixedPayload" -> Payment.mixedPayload(num(input, "total"), num(input, "transfer"))
                "withdrawalSplit" -> splitMap(Payment.withdrawalSplit(str(input, "method")!!, any(field(input, "amount")), field(input, "voided").jsonPrimitive.content == "true"))
                "withdrawalFields" -> Payment.withdrawalFields(str(input, "method")!!, any(field(input, "amount")), any(field(input, "note"))).let { withdrawalMap(it.method, it.amount, it.note) }
                "purchaseSplit" -> splitMap(Payment.purchaseSplit(str(input, "currency")!!, any(field(input, "foreignAmount")), any(field(input, "cupAmount"))))
                "purchaseCup" -> Payment.purchaseCup(any(field(input, "amount")), any(field(input, "rate")))
                "foreignFields" -> fieldsMap(Payment.foreignFields(str(input, "method"), str(input, "currency"), any(field(input, "amount")), any(field(input, "rate")), any(field(input, "shopRate"))))
                "purchaseFields" -> purchaseFieldsMap(Payment.purchaseFields(str(input, "currency"), any(field(input, "amount")), any(field(input, "rate")), any(field(input, "shopRate"))))
                "offShopRate" -> Payment.offShopRate(str(input, "method"), any(field(input, "rate")), any(field(input, "shopRate")))
                "offShopPurchase" -> Payment.offShopPurchase(any(field(input, "rate")), any(field(input, "shopRate")))
                "parseCupCents" -> Payment.parseCupCents(any(field(input, "value")))?.toDouble()
                "cashPaymentBreakdown" -> cashMap(Payment.cashPaymentBreakdown(num(input, "total"), any(field(input, "received"))))
                else -> error("Unknown operation: ${testCase["op"]}")
            } } catch (error: IllegalArgumentException) {
                actualError = error.message
                null
            }
            val expectedError = testCase["expectedError"]?.jsonString()
            if (expectedError != null) {
                assertEquals(testCase.getValue("name").jsonString(), expectedError, actualError)
            } else {
                assertEquals(testCase.getValue("name").jsonString(), null, actualError)
                val expectedMap = expected as? Map<*, *>
                if (expectedMap != null && actual is Map<*, *>) {
                    // JS's withdrawal/purchase split outputs omit foreign_cup.
                    assertEquals(testCase.getValue("name").jsonString(), expectedMap, actual.filterKeys { it in expectedMap.keys })
                } else {
                    assertEquals(testCase.getValue("name").jsonString(), expected, actual)
                }
            }
        }
        assertTrue("Fixture list should not be empty", cases.isNotEmpty())
    }
}
