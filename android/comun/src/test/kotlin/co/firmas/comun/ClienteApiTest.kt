package co.firmas.comun

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URI

class ClienteApiTest {
    @Test
    fun conflictoConservaElEnvioYBloqueaElTurnoHastaLaCancelacion() {
        val movimiento = """{"id":27,"codigo":"TRXD-2026-001","estado":"esperando"}"""
        val cancelado = """{"id":27,"codigo":"TRXD-2026-001","estado":"cancelado","firmado_en":null}"""
        var ocupado = false
        var cuerpo = ""
        val servidor = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        servidor.createContext("/") { peticion ->
            val (http, contenido) = when (peticion.requestURI.path) {
                "/api/activo" -> 200 to if (ocupado) movimiento else "null"
                "/api/movimientos" -> {
                    cuerpo = peticion.requestBody.bufferedReader().use { it.readText() }
                    ocupado = true
                    409 to """{"codigo":"MOVIMIENTO_ACTIVO","error":"Ya hay un activo"}"""
                }
                "/api/movimientos/27/cancelar" -> {
                    ocupado = false
                    200 to """{"ok":true}"""
                }
                "/api/movimientos/27/estado" -> 200 to cancelado
                else -> 404 to "{}"
            }
            val bytes = contenido.toByteArray()
            peticion.responseHeaders.set("Content-Type", "application/json")
            peticion.sendResponseHeaders(http, bytes.size.toLong())
            peticion.responseBody.use { it.write(bytes) }
        }
        servidor.start()
        try {
            val cliente = ClienteApi("http://127.0.0.1:${servidor.address.port}", permitirHttpLocal = true)
            val borrador = Alta(
                "ENTREGA", listOf(Herramienta(descripcion = "Taladro", estado = "Mantenimiento")),
                modo = "detallada", codigoEmpleado = "FICHA-SINTETICA", declaracion = "Texto editable",
            )
            val libre = Turno().trasLectura(cliente.activo())
            assertTrue(libre.permiteAlta)
            val error = assertThrows(ErrorApi::class.java) { cliente.alta(borrador) }
            assertEquals(409, error.http)
            assertEquals("MOVIMIENTO_ACTIVO", error.codigo)
            val bloqueado = libre.trasFalloAlta(error).trasLectura(cliente.activo())
            assertFalse(bloqueado.permiteAlta)
            assertFalse(bloqueado.resultadoIncierto)
            val json = JsonParser.parseString(cuerpo).asJsonObject
            assertEquals(borrador.codigoEmpleado, json.get("codigoEmpleado").asString)
            assertEquals(borrador.declaracion, json.get("declaracion").asString)
            assertEquals("Taladro", borrador.herramientas.single().descripcion)
            cliente.cancelar(checkNotNull(bloqueado.activo).id)
            assertEquals("cancelado", cliente.estado(27)?.estado)
            assertTrue(bloqueado.trasLectura(cliente.activo()).permiteAlta)
        } finally {
            servidor.stop(0)
        }
    }

    @Test
    fun unaRespuestaPerdidaExigeConfirmacionAunCuandoElTurnoEsteLibre() {
        val turno = Turno().trasLectura(null).trasFalloAlta(java.io.IOException()).trasLectura(null)
        assertTrue(turno.resultadoIncierto)
        assertFalse(turno.permiteAlta)
        assertTrue(turno.permitirRepetir().permiteAlta)
    }

    @Test
    fun servidorLocalConBaseTemporal() {
        val origen = System.getenv("FIRMAS_URL_PRUEBAS")
        assumeTrue(!origen.isNullOrBlank())
        val cliente = ClienteApi(checkNotNull(origen), permitirHttpLocal = true)
        cliente.comprobarAcceso()
        assertNull(cliente.activo())
        assertTrue(cliente.declaracion().isNotBlank())
        val rapida = cliente.alta(
            Alta("ENTREGA", listOf(Herramienta(descripcion = "Martillo sintético")), modo = "rapida",
                empleado = "Empleado sintético"),
        )
        assertTrue(rapida.codigo.startsWith("TRX-"))
        assertEquals(rapida.id, cliente.activo()?.id)
        cliente.cancelar(rapida.id)
        assertNull(cliente.activo())

        val recepcion = cliente.alta(
            Alta("ENTREGA", listOf(
                Herramienta(descripcion = "Taladro sintético", cantidad = "2", estado = "Bueno"),
                Herramienta(descripcion = "Pinza sintética", estado = "Mantenimiento", observaciones = "Por revisar"),
                Herramienta(descripcion = "Llave sintética", estado = "Regular"),
            ), modo = "detallada", empleado = "Empleado sintético", codigoEmpleado = "FICHA-SINTETICA",
                declaracion = "Declaración sintética"),
        )
        assertTrue(recepcion.codigo.startsWith("TRXD-"))
        assertEquals("FICHA-SINTETICA", recepcion.codigo_empleado)
        assertEquals("Declaración sintética", recepcion.declaracion)
        firmar(origen, recepcion.id)
        assertNotNull(cliente.estado(recepcion.id)?.firmado_en)
        fun pendientes() = cliente.pendientes().single { it.id == recepcion.id }.pendientes.orEmpty()
        assertEquals(listOf(1L, 2L, 3L), pendientes().map { it.id })
        assertEquals("Por revisar", pendientes()[1].observaciones)

        val devolucion = cliente.alta(
            Alta("DEVOLUCION", listOf(Herramienta(id = 1, estado = "Regular", observaciones = "Devuelta")),
                entregaId = recepcion.id),
        )
        assertEquals("2", devolucion.herramientas?.single()?.cantidad)
        firmar(origen, devolucion.id)
        assertEquals(listOf(2L, 3L), pendientes().map { it.id })

        val cambio = cliente.alta(
            Alta("CAMBIO", listOf(
                Herramienta(id = 2, sentido = "devuelve", estado = "Mantenimiento"),
                Herramienta(descripcion = "Pinza nueva sintética", cantidad = "1", estado = "Excelente", sentido = "recibe"),
            ), entregaId = recepcion.id),
        )
        firmar(origen, cambio.id)
        assertEquals(listOf(3L, 4L), pendientes().map { it.id })
        assertEquals("Pinza nueva sintética", pendientes().last().descripcion)
    }

    private fun firmar(origen: String, id: Long) {
        val png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXWQAAAAASUVORK5CYII="
        val conexion = URI.create("$origen/api/movimientos/$id/firmar").toURL().openConnection() as HttpURLConnection
        try {
            conexion.connectTimeout = 5_000
            conexion.readTimeout = 5_000
            conexion.requestMethod = "POST"
            conexion.doOutput = true
            conexion.setRequestProperty("Content-Type", "application/json")
            conexion.outputStream.use { it.write("""{"firmaEmpleado":"$png","firmaResponsable":"$png"}""".toByteArray()) }
            assertEquals(200, conexion.responseCode)
        } finally {
            conexion.disconnect()
        }
    }
}
