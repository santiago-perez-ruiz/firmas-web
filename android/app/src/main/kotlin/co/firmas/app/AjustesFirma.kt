package co.firmas.app

import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import co.firmas.comun.ClienteApi
import co.firmas.comun.ErrorApi
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun AjustesFirma(
    config: ConfiguracionFirma,
    administrada: String?,
    desbloqueado: Boolean,
    desbloquear: () -> Unit,
    cancelar: () -> Unit,
    antesDeElegirQr: () -> Unit,
    guardar: (String, ClienteApi) -> Unit,
    salir: () -> Unit,
    cambiarOrigen: () -> Boolean,
) {
    val resolver = LocalContext.current.contentResolver
    val alcance = rememberCoroutineScope()
    var direccion by remember { mutableStateOf(administrada ?: config.origen) }
    var codigo by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var repetir by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var trabajando by remember { mutableStateOf(false) }
    var canje by remember { mutableStateOf<Pair<String, String>?>(null) }
    val elegir = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            trabajando = true
            alcance.launch {
                try {
                    direccion = withContext(Dispatchers.IO) { leerQr(resolver, uri) }
                    error = null
                } catch (fallo: CancellationException) {
                    throw fallo
                } catch (_: Exception) {
                    error = "No se pudo leer un código QR con una dirección HTTPS."
                } finally {
                    trabajando = false
                }
            }
        }
    }
    fun ejecutar(accion: suspend () -> Unit) {
        trabajando = true
        error = null
        alcance.launch {
            try {
                accion()
            } catch (fallo: CancellationException) {
                throw fallo
            } catch (fallo: Exception) {
                error = when (fallo) {
                    is ErrorApi, is IllegalArgumentException, is IllegalStateException -> fallo.message
                    else -> "No se pudo comprobar o guardar la configuración de Firma."
                }
            } finally {
                trabajando = false
            }
        }
    }

    BackHandler { if (!trabajando) cancelar() }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Soporte de Firma", style = MaterialTheme.typography.headlineSmall)
        if (config.tienePin && !desbloqueado) {
            Pin(pin, { pin = it }, "PIN de soporte", !trabajando)
            Button(enabled = !trabajando && pin.isNotBlank(), onClick = {
                val entrada = pin
                pin = ""
                ejecutar {
                    check(withContext(Dispatchers.IO) { config.autenticar(entrada) }) { "PIN incorrecto." }
                    desbloquear()
                }
            }) { Text("Desbloquear") }
        } else {
            OutlinedTextField(
                administrada ?: direccion, { direccion = it }, label = { Text("Dirección HTTPS del servidor") },
                enabled = administrada == null && !trabajando, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            if (administrada != null) Text("Dirección administrada")
            if (administrada == null) {
                TextButton(enabled = !trabajando, onClick = {
                    ejecutar {
                        antesDeElegirQr()
                        elegir.launch("image/*")
                    }
                }) { Text("Leer QR desde una imagen") }
            }
            OutlinedTextField(
                codigo, { codigo = it }, label = { Text("Código de vinculación") },
                supportingText = {
                    Text(if (config.origen.isEmpty()) "Solicita el código a administración."
                        else "Deja vacío para comprobar la vinculación guardada.")
                },
                visualTransformation = PasswordVisualTransformation(),
                enabled = !trabajando, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            if (!config.tienePin) {
                Pin(pin, { pin = it }, "Crear PIN de soporte", !trabajando)
                Pin(repetir, { repetir = it }, "Repetir PIN de soporte", !trabajando)
            }
            Button(enabled = !trabajando && (administrada ?: direccion).isNotBlank(), onClick = {
                ejecutar {
                    val origen = ClienteApi.validarDireccion(administrada ?: direccion, false)
                    val mismo = origen == config.origen
                    check(mismo || cambiarOrigen()) { "Resuelve el envío anterior antes de cambiar de servidor." }
                    val pinNuevo = if (config.tienePin) null else pin.also {
                        require(it.matches(Regex("[0-9]{6,12}")) && it == repetir) {
                            "Usa el mismo PIN de 6 a 12 dígitos en los dos campos."
                        }
                    }
                    val anterior = canje?.takeIf { it.first == origen }?.second
                    val entrada = codigo.trim()
                    val token = when {
                        anterior != null && entrada.isEmpty() -> anterior
                        entrada.isNotEmpty() -> withContext(Dispatchers.IO) {
                            ClienteApi(origen).vincularTablet(entrada)
                        }.also {
                            canje = origen to it
                            codigo = ""
                        }
                        mismo -> withContext(Dispatchers.IO) { config.credencial() }
                        else -> ""
                    }
                    require(token.isNotBlank()) { "Introduce un código para vincular esta tablet." }
                    val api = ClienteApi(origen, token)
                    withContext(Dispatchers.IO) { api.comprobarTablet() }
                    // La comprobación y el guardado pertenecen al mismo origen y credencial.
                    config.guardar(origen, token, pinNuevo)
                    guardar(origen, api)
                }
            }) { Text(if (trabajando) "Comprobando…" else "Comprobar y entrar en Firma") }
            if (config.activa) {
                TextButton(enabled = !trabajando, onClick = { ejecutar { salir() } }) {
                    Text("Salir de Firma")
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        TextButton(enabled = !trabajando, onClick = cancelar) { Text("Volver") }
    }
}

@Composable
private fun Pin(valor: String, editar: (String) -> Unit, rotulo: String, habilitado: Boolean) {
    OutlinedTextField(
        valor, { if (it.length <= 12 && it.all { c -> c in '0'..'9' }) editar(it) },
        label = { Text(rotulo) }, enabled = habilitado, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
    )
}

private fun leerQr(resolver: ContentResolver, uri: Uri): String {
    val opciones = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opciones) }
    require(opciones.outWidth > 0 && opciones.outHeight > 0)
    var muestra = 1
    while (maxOf(opciones.outWidth, opciones.outHeight) / muestra > 2048) muestra *= 2
    val imagen = resolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = muestra })
    } ?: error("Imagen inválida.")
    return try {
        val pixeles = IntArray(imagen.width * imagen.height)
        imagen.getPixels(pixeles, 0, imagen.width, 0, 0, imagen.width, imagen.height)
        val fuente = RGBLuminanceSource(imagen.width, imagen.height, pixeles)
        val texto = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(fuente))).text
        ClienteApi.validarDireccion(texto, false)
    } finally {
        imagen.recycle()
    }
}
