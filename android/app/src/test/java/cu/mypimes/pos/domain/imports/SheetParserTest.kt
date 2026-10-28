package cu.mypimes.pos.domain.imports

import cu.mypimes.pos.domain.products.buildProductImport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Portado de client/src/lib/productImport.test.js. Estos casos salen de cómo llegan las listas de una tienda cubana:
// hechas en Excel en español, guardadas en Windows, o copiadas y pegadas.
class SheetParserTest {
    @Test fun numerosEscritosPorUnaPersona() {
        assertEquals(1500.0, parseSheetNumber("1.500")!!, 1e-9)
        assertEquals(1.5, parseSheetNumber("1,5")!!, 1e-9)
        assertEquals(12.5, parseSheetNumber("12.50")!!, 1e-9)
        assertEquals(1234.5, parseSheetNumber("1.234,50")!!, 1e-9)
        assertEquals(1234.5, parseSheetNumber("1,234.50")!!, 1e-9)
        assertEquals(1234567.0, parseSheetNumber("1.234.567")!!, 1e-9)
        assertEquals(990.0, parseSheetNumber("$ 990")!!, 1e-9)
        assertEquals(990.0, parseSheetNumber("990 CUP")!!, 1e-9)
        assertEquals(0.5, parseSheetNumber("0.500")!!, 1e-9)
        assertEquals(null, parseSheetNumber(""))
        assertEquals(null, parseSheetNumber("   "))
        assertTrue(parseSheetNumber("diez")!!.isNaN())
        assertTrue(parseSheetNumber("1.2.3")!!.isNaN())
    }

    @Test fun excelEnEspanolPuntoYComaYMilesConPunto() {
        val rows = buildProductImport("Nombre;Precio de venta;Precio de compra;Stock\r\nArroz (1 lb);1.500;1.100;50\r\n", emptyList()).rows
        assertEquals(1, rows.size)
        assertEquals("Arroz (1 lb)", rows[0].name)
        assertEquals(1500.0, rows[0].salePrice!!, 1e-9)
        assertEquals(1100.0, rows[0].purchasePrice!!, 1e-9)
        assertEquals(50.0, rows[0].stock!!, 1e-9)
    }

    @Test fun celdasCopiadasDeExcelConTabuladores() {
        val rows = buildProductImport("producto\tprecio\tcantidad\nCafé Serrano\t750\t12\nAzúcar\t110\t40\n", emptyList()).rows
        assertEquals(2, rows.size)
        assertEquals("Café Serrano", rows[0].name)
        assertEquals(40.0, rows[1].stock!!, 1e-9)
    }

    @Test fun csvConComaYCamposEntreComillas() {
        val rows = buildProductImport("nombre,precio_venta,stock\n\"Galletas, paquete\",500,14\n\"Queso \"\"Kraft\"\"\",780,10\n", emptyList()).rows
        assertEquals("Galletas, paquete", rows[0].name)
        assertEquals("Queso \"Kraft\"", rows[1].name)
    }

    @Test fun archivoDeExcelEnWindowsNoUtf8ConservaLosAcentos() {
        // "Azúcar;110" en Windows-1252: la ú es el byte 0xFA.
        val bytes = "nombre;precio\r\nAz".toByteArray(Charsets.UTF_8) + byteArrayOf(0xFA.toByte()) + "car;110\r\n".toByteArray(Charsets.UTF_8)
        val rows = buildProductImport(decodeSheet(bytes), emptyList()).rows
        assertEquals("Azúcar", rows[0].name)
    }

    @Test fun reconoceUnXlsxSubidoDirectamente() {
        assertTrue(looksLikeExcelBinary(byteArrayOf(0x50, 0x4b, 0x03, 0x04, 0x14)))
        assertFalse(looksLikeExcelBinary("nombre;precio".toByteArray()))
    }

    @Test fun lasFilasVaciasDelMedioNoCuentanPeroNoCorrenLaNumeracion() {
        val rows = buildProductImport("nombre;precio\n\nArroz;130\n;\nPan;50\n", emptyList()).rows
        assertEquals(listOf(3, 5), rows.map { it.line })
    }

    @Test fun sinTitulosReconociblesExplicaQueEspera() {
        val error = buildProductImport("Arroz;130;50\nPan;50;10\n", emptyList()).error
        assertTrue(error!!.contains("primera fila tiene que tener los títulos"))
    }

    @Test fun precioDeCompraYStockVaciosQuedanComoNoIndicadoNoComoCero() {
        val row = buildProductImport("nombre;precio_venta;precio_compra;stock\nArroz;130;;\n", emptyList()).rows[0]
        assertEquals(null, row.purchasePrice)
        assertEquals(null, row.stock)
        assertEquals("azucar (1 lb)", normalizeName("  Azúcar   (1 LB) "))
    }
}
