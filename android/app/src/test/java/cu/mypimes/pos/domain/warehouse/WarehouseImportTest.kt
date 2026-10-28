package cu.mypimes.pos.domain.warehouse

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Portado de client/src/lib/warehouseImport.test.js.
class WarehouseImportTest {
    @Test fun laPlantillaDelAlmacenSeInterpretaSinErrores() {
        val rows = buildWarehouseImport(TEMPLATE, emptyList()).rows
        assertEquals(3, rows.size)
        assertTrue(rows.all { it.errors.isEmpty() })
        val arroz = rows[1]
        assertEquals("Arroz", arroz.name)
        assertEquals("lb", arroz.unit)
        assertEquals(90.0, arroz.cost!!, 1e-9)
        assertEquals(200.0, arroz.quantity!!, 1e-9)
    }

    @Test fun exigeCostoEnLosNuevosValidaUnidadYDecimalesYRespetaLoExistente() {
        val text = "nombre;unidad;costo;cantidad\nA;;;5\nB;caja;10;1\nC;;10;2,5\nD;kg;10;2,5\nAceite;;;3"
        val rows = buildWarehouseImport(text, listOf(ExistingArticle("aceite", null))).rows
        assertTrue(rows[0].errors[0].contains("costo"))
        assertTrue(rows[1].errors[0].contains("Unidad"))
        assertTrue(rows[2].errors[0].contains("entero"))
        assertTrue(rows[3].errors.isEmpty())
        assertTrue(rows[4].errors.isEmpty())
        assertEquals(false, rows[4].creates)
    }

    @Test fun sinLasColumnasDelAlmacenDaUnAvisoClaro() {
        assertTrue(buildWarehouseImport("nombre;precio_venta\nA;1", emptyList()).error!!.contains("columnas"))
    }

    private companion object {
        const val TEMPLATE = "﻿nombre;unidad;costo;cantidad\r\n" +
            "Aceite vegetal (5 L);;3500;12\r\n" +
            "Arroz;lb;90;200\r\n" +
            "Refresco de lata;;140;240\r\n"
    }
}
