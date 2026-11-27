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
import java.net.InetSocketAddress
import java.io.IOException

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
        firmar(cliente, recepcion.id)
        assertNotNull(cliente.estado(recepcion.id)?.firmado_en)
        fun pendientes() = cliente.pendientes().single { it.id == recepcion.id }.pendientes.orEmpty()
        assertEquals(listOf(1L, 2L, 3L), pendientes().map { it.id })
        assertEquals("Por revisar", pendientes()[1].observaciones)

        val devolucion = cliente.alta(
            Alta("DEVOLUCION", listOf(Herramienta(id = 1, estado = "Regular", observaciones = "Devuelta")),
                entregaId = recepcion.id),
        )
        assertEquals("2", devolucion.herramientas?.single()?.cantidad)
        firmar(cliente, devolucion.id)
        assertEquals(listOf(2L, 3L), pendientes().map { it.id })

        val cambio = cliente.alta(
            Alta("CAMBIO", listOf(
                Herramienta(id = 2, sentido = "devuelve", estado = "Mantenimiento"),
                Herramienta(descripcion = "Pinza nueva sintética", cantidad = "1", estado = "Excelente", sentido = "recibe"),
            ), entregaId = recepcion.id),
        )
        firmar(cliente, cambio.id)
        assertEquals(listOf(3L, 4L), pendientes().map { it.id })
        assertEquals("Pinza nueva sintética", pendientes().last().descripcion)
    }

    @Test
    fun respuestaDeFirmaPerdidaSeReconciliaPorIdAunqueElActivoCambie() {
        var publicado = false
        var escritos = 0
        val servidor = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        assertFalse(servidor.address.port in listOf(3000, 8090))
        servidor.createContext("/") { peticion ->
            val (http, contenido) = when (peticion.requestURI.path) {
                "/api/activo" -> 200 to if (publicado) {
                    """{"id":28,"codigo":"TRX-2026-002","estado":"esperando"}"""
                } else {
                    """{"id":27,"codigo":"TRX-2026-001","estado":"esperando"}"""
                }
                "/api/movimientos/27/firmar" -> {
                    val cuerpo = peticion.requestBody.bufferedReader().use { it.readText() }
                    val json = JsonParser.parseString(cuerpo).asJsonObject
                    if (peticion.requestMethod == "POST" && json.get("firmaEmpleado").asString == PNG &&
                        json.get("firmaResponsable").asString == PNG_RESPONSABLE
                    ) {
                        escritos++
                        publicado = true
                        502 to "{}"
                    } else {
                        400 to "{}"
                    }
                }
                "/api/movimientos/27/estado" -> 200 to if (publicado) {
                    """{"id":27,"codigo":"TRX-2026-001","estado":"firmado","firmado_en":"2026-01-01T00:00:00Z"}"""
                } else {
                    """{"id":27,"codigo":"TRX-2026-001","estado":"esperando","firmado_en":null}"""
                }
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
            assertEquals(27L, cliente.activo()?.id)
            assertEquals(27L, cliente.activo()?.id)
            assertEquals("esperando", cliente.estadoFirma(27).estado)
            val fallo = assertThrows(ErrorApi::class.java) { cliente.firmar(27, PNG, PNG_RESPONSABLE) }
            assertEquals(502, fallo.http)
            assertEquals(28L, cliente.activo()?.id)
            val firmado = cliente.estadoFirma(27)
            assertEquals("firmado", firmado.estado)
            assertNotNull(firmado.firmado_en)
            assertEquals(1, escritos)
            assertThrows(IOException::class.java) { cliente.estadoFirma(28) }
        } finally {
            servidor.stop(0)
        }
    }

    private fun firmar(cliente: ClienteApi, id: Long) {
        val movimiento = cliente.firmar(id, PNG, PNG_RESPONSABLE)
        assertEquals(id, movimiento.id)
        assertEquals("firmado", movimiento.estado)
        assertNotNull(movimiento.firmado_en)
    }

    companion object {
        private const val PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR4nGPg/8/AAAADPgEPpjFeOQAAAABJRU5ErkJggg=="
        private const val PNG_RESPONSABLE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR4nGNgYHD7DwABkAFGdxMcdAAAAABJRU5ErkJggg=="
    }
}
