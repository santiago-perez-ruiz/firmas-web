package co.firmas.app

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import co.firmas.comun.ClienteApi
import co.firmas.comun.ErrorApi
import co.firmas.comun.Movimiento
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicReference

internal enum class Paso { RESUMEN, EMPLEADO, ALMACENISTA }

internal class FirmaModelo(app: Application) : AndroidViewModel(app) {
    private val registro = app.getSharedPreferences("turno_firma", 0)
    private val red = app.getSystemService(ConnectivityManager::class.java)
    private val despertar = Channel<Unit>(Channel.CONFLATED)
    private val operaciones = Mutex()
    private var origen: String? = null
    private var cliente: ClienteApi? = null
    private var anterior = 0L
    private var pendiente = 0L

    var movimiento by mutableStateOf<Movimiento?>(null)
        private set
    var paso by mutableStateOf(Paso.RESUMEN)
    var confirmado by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
        private set
    var conexion by mutableStateOf<String?>(null)
        private set
    var accesoSuspendido by mutableStateOf(false)
        private set
    var aviso by mutableStateOf<String?>(null)
        private set
    var enviando by mutableStateOf(false)
        private set
    var incierto by mutableStateOf(false)
        private set

    val empleado = Trazo()
    val almacenista = Trazo()

    fun conectar(direccion: String, api: ClienteApi) {
        if (origen != direccion) {
            cambiar(null)
            confirmado = null
            aviso = null
            error = null
            conexion = null
            accesoSuspendido = false
            anterior = registro.getLong("captura:$direccion", 0)
            pendiente = registro.getLong("envio:$direccion", 0)
            incierto = pendiente != 0L
        }
        origen = direccion
        cliente = api
        despertar.trySend(Unit)
    }

    fun admiteCambio(direccion: String) =
        !enviando && registro.getLong("envio:$direccion", 0) == 0L

    suspend fun sondear() {
        val actual = AtomicReference(red.activeNetwork)
        val escucha = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (actual.getAndSet(network) != network) despertar.trySend(Unit)
            }

            override fun onLost(network: Network) {
                actual.updateAndGet { if (it == network) null else it }
            }
        }
        red.registerDefaultNetworkCallback(escucha)
        try {
            var espera = 3_000L
            while (true) {
                despertar.tryReceive()
                val inicio = SystemClock.elapsedRealtime()
                val bien = operaciones.withLock { consultar() }
                if (bien) espera = 3_000L
                val pausa = if (bien) espera - (SystemClock.elapsedRealtime() - inicio) else espera
                withTimeoutOrNull(pausa) { despertar.receive() }
                if (!bien) espera = (espera * 2).coerceAtMost(30_000L)
            }
        } finally {
            red.unregisterNetworkCallback(escucha)
        }
    }

    fun enviar() {
        val api = cliente ?: return
        val actual = movimiento ?: return
        if (enviando || incierto || accesoSuspendido || !empleado.tieneTinta || !almacenista.tieneTinta) return
        enviando = true
        error = null
        viewModelScope.launch {
            try {
                operaciones.withLock {
                    if (movimiento?.id != actual.id) return@withLock
                    aviso = null
                    val firmaEmpleado = empleado.png()
                    val firmaAlmacenista = almacenista.png()
                    registrarEnvio(actual.id)
                    try {
                        confirmar(withContext(Dispatchers.IO) {
                            api.firmar(actual.id, firmaEmpleado, firmaAlmacenista)
                        })
                    } catch (fallo: CancellationException) {
                        throw fallo
                    } catch (fallo: Exception) {
                        informar(fallo)
                        reconciliar(api, actual.id)
                    }
                }
            } catch (fallo: CancellationException) {
                throw fallo
            } catch (fallo: Exception) {
                informar(fallo)
            } finally {
                enviando = false
                despertar.trySend(Unit)
            }
        }
    }

    private suspend fun consultar(): Boolean {
        val api = cliente ?: return true
        return try {
            if (pendiente != 0L) reconciliar(api, pendiente)
            val actual = withContext(Dispatchers.IO) { api.activo() }
            if (actual?.id != movimiento?.id || anterior != 0L) {
                if (anterior != 0L && actual?.id == anterior) {
                    aviso = "La aplicación se cerró. Vuelve a capturar las firmas de este movimiento."
                } else if (anterior != 0L) {
                    aviso = "La aplicación se cerró y el movimiento anterior terminó."
                } else if (movimiento != null && confirmado == null) {
                    aviso = "El movimiento anterior ya no está disponible para firmar."
                }
                anterior = 0
                error = null
                cambiar(actual)
                registro.edit().putLong("captura:$origen", actual?.id ?: 0).apply()
            }
            conexion = null
            accesoSuspendido = false
            true
        } catch (fallo: CancellationException) {
            throw fallo
        } catch (fallo: Exception) {
            conexion = mensaje(fallo)
            suspenderSiDenegado(fallo)
            false
        }
    }

    private suspend fun reconciliar(api: ClienteApi, id: Long) {
        val estado = try {
            withContext(Dispatchers.IO) { api.estadoFirma(id) }
        } catch (fallo: CancellationException) {
            throw fallo
        } catch (fallo: ErrorApi) {
            if (fallo.http == 404 && fallo.codigo == "NO_ENCONTRADO") {
                cerrarTurno()
                aviso = "La tablet ya no tiene acceso al movimiento anterior."
                return
            }
            throw fallo
        }
        when (estado.estado) {
            "firmado" -> confirmar(estado)
            "cancelado" -> {
                cerrarTurno()
                aviso = "El movimiento fue cancelado."
            }
            "esperando" -> {
                registrarEnvio(0)
                aviso = if (movimiento?.id == id) "El servidor sigue esperando las firmas. Puedes volver a enviar."
                    else "El movimiento sigue pendiente. Vuelve a capturar las firmas."
            }
        }
    }

    private fun registrarEnvio(id: Long) {
        check(registro.edit().putLong("envio:$origen", id).commit()) {
            "No se pudo guardar el estado del envío."
        }
        pendiente = id
        incierto = id != 0L
    }

    private fun cerrarTurno() {
        registrarEnvio(0)
        registro.edit().remove("captura:$origen").apply()
        anterior = 0
        cambiar(null)
    }

    private fun confirmar(estado: Movimiento) {
        cerrarTurno()
        confirmado = estado.codigo
        error = null
        aviso = null
    }

    private fun cambiar(nuevo: Movimiento?) {
        empleado.borrar()
        almacenista.borrar()
        paso = Paso.RESUMEN
        movimiento = nuevo
    }

    private fun informar(fallo: Exception) {
        error = mensaje(fallo)
        suspenderSiDenegado(fallo)
    }

    private fun suspenderSiDenegado(fallo: Exception) {
        if (fallo is ErrorApi && fallo.http in listOf(401, 403)) accesoSuspendido = true
    }

    private fun mensaje(fallo: Exception): String = when (fallo) {
        is ErrorApi, is IllegalStateException -> fallo.message ?: "No se pudo completar la operación."
        else -> "No se pudo comunicar con el servidor. La aplicación volverá a consultar."
    }
}
