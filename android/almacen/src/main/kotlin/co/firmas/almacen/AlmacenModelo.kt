package co.firmas.almacen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import co.firmas.comun.Alta
import co.firmas.comun.ClienteApi
import co.firmas.comun.ErrorApi
import co.firmas.comun.Herramienta
import co.firmas.comun.Movimiento
import co.firmas.comun.Turno
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal enum class Pantalla(val titulo: String) {
    Rapida("Recepción rápida"),
    Detallada("Recepción detallada"),
    Gestion("Gestionar recepción"),
}

internal class Linea {
    var descripcion by mutableStateOf("")
    var cantidad by mutableStateOf("1")
    var estado by mutableStateOf("Excelente")
    var notas by mutableStateOf("")

    fun herramienta(sentido: String? = null) = Herramienta(
        descripcion = descripcion.trim(), cantidad = cantidad.trim().ifBlank { "1" },
        estado = estado, observaciones = notas.trim(), sentido = sentido,
    )
}

internal class Recepcion(private val modo: String) {
    var empleado by mutableStateOf("")
    var cedula by mutableStateOf("")
    var departamento by mutableStateOf("")
    var ficha by mutableStateOf("")
    var responsable by mutableStateOf("")
    var notas by mutableStateOf("")
    var declaracion by mutableStateOf<String?>(null)
    var lineas by mutableStateOf(listOf(Linea()))

    fun alta(declaracionServidor: String?): Alta {
        require(empleado.isNotBlank()) { "Escribe el nombre del empleado." }
        require(lineas.all { it.descripcion.isNotBlank() }) { "Completa la descripción de cada herramienta." }
        return Alta(
            tipo = "ENTREGA", modo = modo, empleado = empleado.trim(), cedula = cedula.trim(),
            departamento = departamento.trim(), responsable = responsable.trim(), observaciones = notas.trim(),
            herramientas = lineas.map { it.herramienta() },
            codigoEmpleado = ficha.trim().takeIf { modo == "detallada" },
            declaracion = declaracion?.trim()?.takeUnless { it == declaracionServidor },
        )
    }
}

internal class Regreso(val herramienta: Herramienta) {
    var seleccionado by mutableStateOf(false)
    var estado by mutableStateOf(herramienta.estado.orEmpty().ifBlank { "Excelente" })
    var notas by mutableStateOf("")
}

internal class Gestion(val entrega: Movimiento) {
    val admiteCambio = entrega.modo == "detallada"
    var cambio by mutableStateOf(false)
    var responsable by mutableStateOf(entrega.responsable.orEmpty())
    var notas by mutableStateOf("")
    var nuevas by mutableStateOf(listOf(Linea()))
    val regresos = entrega.pendientes.orEmpty().filter { it.id != null }.map(::Regreso)

    fun alta(): Alta {
        val salidas = regresos.filter { it.seleccionado }.map {
            Herramienta(
                id = it.herramienta.id, estado = it.estado, observaciones = it.notas.trim(),
                sentido = if (cambio) "devuelve" else null,
            )
        }
        require(salidas.isNotEmpty()) { "Selecciona al menos una línea pendiente." }
        val entradas = if (cambio) {
            require(nuevas.all { it.descripcion.isNotBlank() }) { "Completa cada herramienta nueva." }
            nuevas.map { it.herramienta("recibe") }
        } else emptyList()
        return Alta(
            tipo = if (cambio) "CAMBIO" else "DEVOLUCION", entregaId = entrega.id,
            herramientas = salidas + entradas, responsable = responsable.trim(), observaciones = notas.trim(),
        )
    }
}

class AlmacenModelo : ViewModel() {
    private var api: ClienteApi? = null
    private val red = Mutex()
    private var guardarIncertidumbre: (Boolean) -> Boolean = { true }

    internal var pantalla by mutableStateOf(Pantalla.Rapida)
    internal var rapida by mutableStateOf(Recepcion("rapida"))
    internal var detallada by mutableStateOf(Recepcion("detallada"))
    internal var gestion by mutableStateOf<Gestion?>(null)
    internal var pendientes by mutableStateOf<List<Movimiento>>(emptyList())
    internal var declaracion by mutableStateOf<String?>(null)
    internal var turno by mutableStateOf(Turno())
        private set
    internal var seguimiento by mutableStateOf<Movimiento?>(null)
        private set
    internal var estadoDesconocido by mutableStateOf(false)
        private set
    internal var ocupado by mutableStateOf(false)
        private set
    internal var aviso by mutableStateOf<String?>(null)
    internal var errorConexion by mutableStateOf<String?>(null)
        private set

    suspend fun conectar(
        cliente: ClienteApi, incierto: Boolean, cambiaOrigen: Boolean, persistir: (Boolean) -> Boolean,
    ) = red.withLock {
        api = cliente
        guardarIncertidumbre = persistir
        turno = Turno(resultadoIncierto = incierto)
        if (cambiaOrigen) {
            seguimiento = null
            estadoDesconocido = false
            pendientes = emptyList()
            gestion = null
            declaracion = null
            rapida = Recepcion("rapida")
            detallada = Recepcion("detallada")
        }
        errorConexion = null
        aviso = null
    }

    fun estaConectado() = api != null

    fun admiteCambioDeOrigen() = !ocupado && turno.activo == null && !turno.resultadoIncierto

    internal suspend fun sondear(): Boolean = red.withLock {
        intentarLectura()
    }

    private suspend fun intentarLectura(): Boolean = try {
        val cliente = checkNotNull(api)
        val activo = consultar { cliente.activo() }
        turno = turno.trasLectura(activo)
        errorConexion = null
        val previo = seguimiento
        if (previo != null && previo.estado == "esperando" && previo.id != activo?.id) {
            try {
                val estado = consultar { cliente.estado(previo.id) }
                estadoDesconocido = estado == null
                if (estado != null) seguimiento = estado
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                estadoDesconocido = true
            }
        }
        if (previo == null && activo != null) seguimiento = activo
        true
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        turno = turno.copy(comprobado = false)
        errorConexion = mensaje(error)
        false
    }

    internal fun cargar() = operacion { cliente ->
        when (pantalla) {
            Pantalla.Detallada -> declaracion = consultar { cliente.declaracion() }
            Pantalla.Gestion -> pendientes = consultar { cliente.pendientes() }
            Pantalla.Rapida -> Unit
        }
    }

    internal fun enviar() {
        if (!turno.permiteAlta || ocupado) return
        val origen = pantalla
        val datos = try {
            when (origen) {
                Pantalla.Rapida -> rapida.alta(null)
                Pantalla.Detallada -> detallada.alta(declaracion)
                Pantalla.Gestion -> checkNotNull(gestion).alta()
            }
        } catch (error: IllegalArgumentException) {
            aviso = error.message
            return
        }
        operacion { cliente ->
            if (!intentarLectura() || !turno.permiteAlta) return@operacion
            check(guardarIncertidumbre(true)) { "No se pudo guardar el estado del envío." }
            try {
                val creado = consultar { cliente.alta(datos) }
                turno = turno.trasLectura(creado)
                seguimiento = creado
                estadoDesconocido = false
                when (origen) {
                    Pantalla.Rapida -> rapida = Recepcion("rapida")
                    Pantalla.Detallada -> detallada = Recepcion("detallada")
                    Pantalla.Gestion -> { gestion = null; pendientes = emptyList() }
                }
                guardarIncertidumbre(false)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                turno = turno.trasFalloAlta(error)
                if (!turno.resultadoIncierto) guardarIncertidumbre(false)
                intentarLectura()
                throw error
            }
        }
    }

    internal fun cancelar(id: Long) = operacion { cliente ->
        val activo = consultar { cliente.activo() }
        turno = turno.trasLectura(activo)
        if (activo?.id == id) {
            seguimiento = activo
            estadoDesconocido = false
            try {
                consultar { cliente.cancelar(id) }
            } finally {
                intentarLectura()
            }
        } else {
            intentarLectura()
            aviso = "El movimiento confirmado ya salió del turno."
        }
    }

    internal fun permitirRepetir() {
        if (turno.comprobado && turno.activo == null && guardarIncertidumbre(false)) {
            turno = turno.permitirRepetir()
        }
    }

    private fun operacion(accion: suspend (ClienteApi) -> Unit) {
        val cliente = api ?: return
        if (ocupado) return
        ocupado = true
        aviso = null
        viewModelScope.launch {
            try {
                red.withLock { accion(cliente) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                aviso = mensaje(error)
            } finally {
                ocupado = false
            }
        }
    }

    private suspend fun <T> consultar(accion: () -> T): T = withContext(Dispatchers.IO) { accion() }

    private fun mensaje(error: Exception) = when (error) {
        is ErrorApi, is IllegalStateException -> error.message ?: "No se pudo completar la operación."
        else -> "No se pudo obtener una respuesta válida del servidor."
    }
}
