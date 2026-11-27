package co.firmas.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    if (!ajustes && modelo.estaConectado()) {
                        Almacen(modelo) { ajustes = true }
                    } else {
                        Column(
                            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text("Servidor de Almacén", style = MaterialTheme.typography.headlineSmall)
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
