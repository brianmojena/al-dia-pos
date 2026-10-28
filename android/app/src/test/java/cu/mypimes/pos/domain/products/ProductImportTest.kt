package cu.mypimes.pos.domain.products

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Portado de client/src/lib/productImport.test.js (parte de productos).
class ProductImportTest {
    @Test fun erroresFilaPorFilaConElNumeroDeFilaDeLaHoja() {
        val csv = listOf(
            "nombre;precio_venta;precio_compra;stock",
            "Arroz;130;90;50",
            ";200;;10",
            "Pan;diez;;5",
            "Leche;1000;;2,5",
            "arroz ;140;;3",
            "Aceite;-5;;1",
        ).joinToString("\n")
        val rows = buildProductImport(csv, emptyList()).rows
        val porFila = rows.associate { it.line to it.errors }

        assertTrue(porFila.getValue(2).isEmpty())
        assertTrue(porFila.getValue(3)[0].contains("Falta el nombre"))
        assertTrue(porFila.getValue(4)[0].contains("Precio de venta no válido: \"diez\""))
        assertTrue(porFila.getValue(5)[0].contains("entero"))
        assertTrue(porFila.getValue(6)[0].contains("Repetido: ya aparece en la fila 2"))
        assertTrue(porFila.getValue(7)[0].contains("negativo"))

        assertEquals("solo viajan al servidor las filas sin errores", 1, rows.count { it.errors.isEmpty() })
    }

    @Test fun marcaQueProductosYaExistenSeVanAActualizar() {
        val rows = buildProductImport("nombre;precio\nazucar (1 LB);120\nSal;40\n", listOf("Azúcar (1 lb)")).rows
        assertEquals("mismo producto aunque cambien acentos y mayúsculas", false, rows[0].creates)
        assertEquals(true, rows[1].creates)
    }

    @Test fun laPlantillaSeImportaSinErrores() {
        val rows = buildProductImport(TEMPLATE, emptyList()).rows
        assertEquals(3, rows.size)
        assertTrue(rows.all { it.errors.isEmpty() })
    }

    @Test fun columnasDelEncabezadoDeProductosSeMapeanPorPalabraContenida() {
        val row = buildProductImport("Producto;Precio venta CUP;Costo unitario;Cantidad\nArroz;130;90;50\n", emptyList()).rows[0]
        assertEquals(130.0, row.salePrice!!, 1e-9)
        assertEquals(90.0, row.purchasePrice!!, 1e-9)
        assertEquals(50.0, row.stock!!, 1e-9)
    }

    private companion object {
        // Igual que TEMPLATE_CSV de la web (productImport.js): con ";" y BOM.
        const val TEMPLATE = "﻿nombre;precio_venta;precio_compra;stock\r\n" +
            "Arroz (1 lb);130;90;50\r\n" +
            "Aceite vegetal (1 L);990;750;20\r\n" +
            "Refresco de lata;200;140;48\r\n"
    }
}
