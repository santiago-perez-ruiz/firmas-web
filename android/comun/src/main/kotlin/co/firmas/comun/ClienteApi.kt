package co.firmas.comun

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonParseException
import com.google.gson.JsonParser
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

class ErrorApi(val http: Int, val codigo: String?, mensaje: String) : IOException(mensaje)

class ClienteApi(
    direccion: String,
    private val credencial: String = "",
    permitirHttpLocal: Boolean = false,
) {
    private val origen = validarDireccion(direccion, permitirHttpLocal)
    private val gson = Gson()

    init {
        require(credencial.isBlank() || origen.startsWith("https://")) { "La credencial requiere HTTPS." }
    }

    fun comprobarAcceso() {
        comprobarSalud()
        activo()
    }

    private fun comprobarSalud() {
        if (pedir("/api/salud").asJsonObject.get("ok")?.asBoolean != true) {
            throw IOException("El servidor no informó que está disponible.")
        }
    }

    fun comprobarTablet(): String {
        comprobarSalud()
        val sesion = pedir("/api/dispositivos/sesion").asJsonObject
        val id = sesion.get("dispositivoId")?.takeIf { it.isJsonPrimitive }?.asString
        check(sesion.get("rol")?.asString == "tablet" && !id.isNullOrBlank()) {
            "El servidor no reconoció la sesión de la tablet."
        }
        return id
    }

    fun vincularTablet(codigo: String): String {
        comprobarSalud()
        val datos = pedir("/api/dispositivos/vincular", gson.toJson(mapOf("codigo" to codigo))).asJsonObject
        return datos.get("credencial")?.takeIf { it.isJsonPrimitive }?.asString
            ?.takeIf { it.isNotBlank() } ?: throw IOException("El servidor no entregó la credencial de la tablet.")
    }

    fun firmar(id: Long, empleado: String, responsable: String): Movimiento {
        val cuerpo = gson.toJson(mapOf("firmaEmpleado" to empleado, "firmaResponsable" to responsable))
        val resultado = movimiento(pedir("/api/movimientos/$id/firmar", cuerpo))
        if (resultado.id != id || resultado.estado != "firmado" || resultado.firmado_en.isNullOrBlank()) {
            throw IOException("El servidor no confirmó la firma del movimiento.")
        }
        return resultado
    }

    fun estadoFirma(id: Long): Movimiento =
        movimiento(pedir("/api/movimientos/$id/estado")).also {
            if (it.id != id || (it.estado == "firmado" && it.firmado_en.isNullOrBlank())) {
                throw IOException("El servidor devolvió un estado de firma inválido.")
            }
        }

    fun activo(): Movimiento? = pedir("/api/activo").let {
        if (it.isJsonNull) null else movimiento(it).also(::exigirEnEspera)
    }
    fun declaracion(): String = pedir("/api/declaraciones").asJsonObject.get("ENTREGA").asString
    fun pendientes(): List<Movimiento> = pedir("/api/entregas-pendientes").asJsonArray.map(::movimiento)
    fun alta(datos: Alta): Movimiento =
        movimiento(pedir("/api/movimientos", gson.toJson(datos), 201)).also(::exigirEnEspera)

    fun estado(id: Long): Movimiento? = try {
        movimiento(pedir("/api/movimientos/$id/estado")).also {
            if (it.id != id) throw IOException("El estado recibido pertenece a otro movimiento.")
        }
    } catch (error: ErrorApi) {
        // La ruta por ID todavía puede faltar en el servidor de transición.
        if (error.http != 404 || error.codigo != null) throw error
        pedir("/api/movimientos").asJsonArray.map(::movimiento).firstOrNull { it.id == id }
    }

    fun cancelar(id: Long) {
        val confirmado = pedir("/api/movimientos/$id/cancelar", "{}").asJsonObject.get("ok")
        if (confirmado?.asBoolean != true) throw IOException("El servidor no confirmó la cancelación.")
    }

    private fun exigirEnEspera(movimiento: Movimiento) {
        if (movimiento.estado != "esperando") throw IOException("El movimiento recibido no espera firma.")
    }

    private fun movimiento(json: JsonElement): Movimiento {
        val datos = gson.fromJson(json, Movimiento::class.java)
        if (datos == null || datos.id <= 0 || datos.codigo.isNullOrBlank() ||
            datos.estado !in listOf("esperando", "firmado", "cancelado")
        ) throw IOException("El servidor devolvió un movimiento inválido.")
        return datos
    }

    private fun pedir(ruta: String, cuerpo: String? = null, esperado: Int = 200): JsonElement {
        val conexion = URI.create(origen + ruta).toURL().openConnection() as HttpURLConnection
        try {
            conexion.instanceFollowRedirects = false
            conexion.useCaches = false
            conexion.connectTimeout = 5_000
            conexion.readTimeout = 5_000
            conexion.setRequestProperty("Accept", "application/json")
            conexion.setRequestProperty("Cache-Control", "no-store")
            if (credencial.isNotBlank()) conexion.setRequestProperty("Authorization", "Bearer $credencial")
            if (cuerpo != null) {
                val bytes = cuerpo.toByteArray(Charsets.UTF_8)
                conexion.requestMethod = "POST"
                conexion.doOutput = true
                conexion.setFixedLengthStreamingMode(bytes.size)
                conexion.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                conexion.outputStream.use { it.write(bytes) }
            }
            val http = conexion.responseCode
            if (http != esperado) {
                val detalle = conexion.errorStream?.bufferedReader(Charsets.UTF_8)?.use { lector ->
                    runCatching { JsonParser.parseString(lector.readText()).asJsonObject }.getOrNull()
                }
                throw ErrorApi(
                    http,
                    detalle?.get("codigo")?.takeIf { it.isJsonPrimitive }?.asString,
                    detalle?.get("error")?.takeIf { it.isJsonPrimitive }?.asString
                        ?: "El servidor respondió con código $http.",
                )
            }
            val tipo = conexion.contentType?.substringBefore(';')?.trim()
            if (!"application/json".equals(tipo, ignoreCase = true)) {
                throw IOException("El servidor no devolvió una respuesta JSON.")
            }
            val contenido = conexion.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            if (contenido.isBlank()) throw IOException("El servidor devolvió una respuesta vacía.")
            return try {
                JsonParser.parseString(contenido)
            } catch (error: JsonParseException) {
                throw IOException("La respuesta del servidor no es JSON válido.", error)
            }
        } finally {
            conexion.disconnect()
        }
    }

    companion object {
        fun validarDireccion(direccion: String, permitirHttpLocal: Boolean): String {
            val origen = direccion.trim().trimEnd('/')
            val uri = runCatching { URI(origen) }.getOrNull()
            require(uri != null && uri.host != null && uri.userInfo == null &&
                uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.isEmpty()
            ) { "Escribe la dirección base del servidor." }
            require(uri.scheme == "https" || (permitirHttpLocal && uri.scheme == "http" &&
                uri.host in setOf("127.0.0.1", "10.0.2.2"))) {
                "Usa una dirección HTTPS."
            }
            return origen
        }
    }
}
