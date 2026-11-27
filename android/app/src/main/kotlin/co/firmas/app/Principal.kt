package co.firmas.app

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.RestrictionsManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import co.firmas.almacen.Almacen
import co.firmas.almacen.AlmacenModelo
import co.firmas.comun.ClienteApi
import co.firmas.comun.ErrorApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class Principal : ComponentActivity() {
    private val firma: FirmaModelo by viewModels()
    private lateinit var configFirma: ConfiguracionFirma
    private var modoFirma by mutableStateOf(false)
    private var soporte by mutableStateOf(false)
    private var desbloqueado by mutableStateOf(false)
    private var administrada by mutableStateOf<String?>(null)
    private var errorFirma by mutableStateOf<String?>(null)
    private var fijarAlReanudar = false
    private var fijado by mutableStateOf(false)
    private var estadoQuiosco by mutableStateOf<String?>(null)
    private val temporizador = Handler(Looper.getMainLooper())
    private val abrirSoporte = Runnable {
        if (modoFirma && !soporte && !firma.enviando) {
            actualizarAdministrada()
            desbloqueado = false
            soporte = true
        }
    }

    private fun actualizarAdministrada() {
        administrada = getSystemService(RestrictionsManager::class.java).applicationRestrictions
            .getString("servidor_https")?.trim()?.takeIf { it.isNotEmpty() }
    }

    private fun entrarQuiosco() {
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        actualizarQuiosco()
        if (fijado) return
        val gestionado = getSystemService(DevicePolicyManager::class.java).isLockTaskPermitted(packageName)
        estadoQuiosco = if (gestionado) null else "Acepta la fijación de pantalla cuando Android la solicite."
        try {
            startLockTask()
            actualizarQuiosco()
        } catch (_: RuntimeException) {
            estadoQuiosco = "No se pudo activar el quiosco. Revisa la configuración de Android."
        }
    }

    private fun liberarQuiosco() {
        if (getSystemService(ActivityManager::class.java).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
            stopLockTask()
        }
    }

    private fun actualizarQuiosco() {
        fijado = getSystemService(ActivityManager::class.java).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) actualizarQuiosco()
    }

    override fun onResume() {
        super.onResume()
        actualizarAdministrada()
        actualizarQuiosco()
        if (fijarAlReanudar) {
            fijarAlReanudar = false
            entrarQuiosco()
        }
    }

    override fun onPause() {
        temporizador.removeCallbacks(abrirSoporte)
        super.onPause()
    }

    override fun dispatchTouchEvent(evento: MotionEvent): Boolean {
        if (modoFirma && !soporte) {
            when (evento.actionMasked) {
                MotionEvent.ACTION_POINTER_DOWN -> {
                    temporizador.removeCallbacks(abrirSoporte)
                    if (evento.pointerCount == 3) temporizador.postDelayed(abrirSoporte, 3_000)
                }
                MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                    temporizador.removeCallbacks(abrirSoporte)
            }
        }
        return super.dispatchTouchEvent(evento)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configFirma = ConfiguracionFirma(this)
        modoFirma = configFirma.activa
        if (modoFirma) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            fijarAlReanudar = savedInstanceState == null ||
                getSystemService(DevicePolicyManager::class.java).isLockTaskPermitted(packageName)
        }
        actualizarAdministrada()
        val preferencias = getSharedPreferences("servidor", MODE_PRIVATE)
        val direccionGuardada = preferencias.getString("direccion", "").orEmpty()
        setContent {
            val modelo: AlmacenModelo = viewModel()
            var direccion by rememberSaveable { mutableStateOf(direccionGuardada) }
            var ajustes by rememberSaveable { mutableStateOf(true) }
            var credencial by remember { mutableStateOf("") }
            var probando by remember { mutableStateOf(false) }
            var error by remember { mutableStateOf<String?>(null) }
            val alcance = rememberCoroutineScope()
            LaunchedEffect(Unit) {
                if (modoFirma) {
                    try {
                        val api = withContext(Dispatchers.IO) {
                            ClienteApi(configFirma.origen, configFirma.credencial())
                        }
                        firma.conectar(configFirma.origen, api)
                    } catch (fallo: CancellationException) {
                        throw fallo
                    } catch (_: Exception) {
                        errorFirma = "No se pudo abrir la vinculación guardada. Abre soporte para volver a vincular la tablet."
                    }
                }
            }
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    if (soporte) {
                        AjustesFirma(
                            configFirma, administrada, desbloqueado,
                            desbloquear = { desbloqueado = true },
                            cancelar = {
                                soporte = false
                                desbloqueado = false
                                if (modoFirma) entrarQuiosco()
                            },
                            antesDeElegirQr = ::liberarQuiosco,
                            guardar = { origen, api ->
                                firma.conectar(origen, api)
                                errorFirma = null
                                modoFirma = true
                                soporte = false
                                desbloqueado = false
                                entrarQuiosco()
                            },
                            salir = {
                                liberarQuiosco()
                                configFirma.salir()
                                window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE or
                                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                                modoFirma = false
                                soporte = false
                                desbloqueado = false
                                ajustes = true
                            },
                            cambiarOrigen = { firma.admiteCambio(configFirma.origen) },
                        )
                    } else if (modoFirma) {
                        LaunchedEffect(Unit) {
                            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                                firma.sondear()
                            }
                        }
                        Column {
                            errorFirma?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            if (!fijado) {
                                estadoQuiosco?.let { Text(it) }
                                TextButton(onClick = ::entrarQuiosco) { Text("Activar quiosco") }
                            }
                            if (administrada != null && administrada != configFirma.origen) {
                                Text("Hay una dirección administrada pendiente. Abre soporte para comprobarla.")
                            }
                            Firma(firma)
                        }
                    } else if (!ajustes && modelo.estaConectado()) {
                        Almacen(modelo) { ajustes = true }
                    } else {
                        Column(
                            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text("Servidor de Almacén", style = MaterialTheme.typography.headlineSmall)
                            TextButton(enabled = !probando, onClick = {
                                desbloqueado = false
                                soporte = true
                            }) { Text("Configurar modo Firma") }
                            OutlinedTextField(
                                direccion, { direccion = it }, label = { Text("Dirección del servidor") },
                                singleLine = true, enabled = !probando, modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedTextField(
                                credencial, { credencial = it },
                                label = { Text("Credencial de operador, si se requiere") },
                                visualTransformation = PasswordVisualTransformation(),
                                singleLine = true, enabled = !probando, modifier = Modifier.fillMaxWidth(),
                            )
                            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Button(enabled = !probando && direccion.isNotBlank(), onClick = {
                                    probando = true
                                    error = null
                                    alcance.launch {
                                        try {
                                            val origen = ClienteApi.validarDireccion(direccion, BuildConfig.DEBUG)
                                            val anterior = preferencias.getString("direccion", "").orEmpty()
                                            val incierto = preferencias.getBoolean("envio_incierto", false)
                                            check(origen == anterior || (!incierto && modelo.admiteCambioDeOrigen())) {
                                                "Resuelve el turno anterior antes de cambiar de servidor."
                                            }
                                            val cliente = ClienteApi(origen, credencial.trim(), BuildConfig.DEBUG)
                                            withContext(Dispatchers.IO) { cliente.comprobarAcceso() }
                                            check(preferencias.edit().putString("direccion", origen).commit()) {
                                                "No se pudo guardar la dirección del servidor."
                                            }
                                            modelo.conectar(cliente, incierto, origen != anterior) {
                                                preferencias.edit().putBoolean("envio_incierto", it).commit()
                                            }
                                            direccion = origen
                                            ajustes = false
                                        } catch (fallo: CancellationException) {
                                            throw fallo
                                        } catch (fallo: Exception) {
                                            error = when (fallo) {
                                                is ErrorApi, is IllegalArgumentException, is IllegalStateException -> fallo.message
                                                else -> "No se pudo comprobar el acceso al servidor."
                                            }
                                        } finally {
                                            probando = false
                                        }
                                    }
                                }) { Text(if (probando) "Comprobando…" else "Comprobar y guardar") }
                                if (modelo.estaConectado()) {
                                    TextButton(enabled = !probando, onClick = { ajustes = false }) { Text("Volver") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
