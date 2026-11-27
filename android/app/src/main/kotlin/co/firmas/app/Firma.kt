package co.firmas.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Composable
internal fun Firma(modelo: FirmaModelo) {
    BackHandler {}
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val anchoLienzo = maxHeight * (ANCHO / ALTO * 0.55f)
        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            modelo.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            modelo.conexion?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            modelo.aviso?.let { Text(it) }
            val confirmado = modelo.confirmado
            val actual = modelo.movimiento
            when {
                modelo.accesoSuspendido -> Text("Acceso suspendido. Abre soporte para revisar la vinculación.")
                confirmado != null -> {
                    Text("Firmas guardadas", style = MaterialTheme.typography.headlineMedium)
                    Text(confirmado)
                    Button(onClick = { modelo.confirmado = null }) { Text("Continuar") }
                }
                actual == null -> Text(
                    if (modelo.incierto) "Comprobando el resultado del envío" else "Esperando movimiento",
                    style = MaterialTheme.typography.headlineMedium,
                )
                else -> key(actual.id, modelo.paso) {
                    Column(
                        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(actual.codigo, style = MaterialTheme.typography.titleMedium)
                        when (modelo.paso) {
                            Paso.RESUMEN -> {
                                val titulo = when (actual.tipo) {
                                    "DEVOLUCION" -> "Devolución"
                                    "CAMBIO" -> "Cambio"
                                    else -> "Recepción"
                                }
                                Text(titulo, style = MaterialTheme.typography.headlineMedium)
                                Text("Empleado: ${actual.empleado.orEmpty()}")
                                actual.cedula?.takeIf { it.isNotBlank() }?.let { Text("Cédula: $it") }
                                actual.codigo_empleado?.takeIf { it.isNotBlank() }?.let { Text("Ficha: $it") }
                                actual.departamento?.takeIf { it.isNotBlank() }?.let { Text("Departamento: $it") }
                                Text("Almacenista: ${actual.responsable.orEmpty()}")
                                for (linea in actual.herramientas.orEmpty()) {
                                    val sentido = when (linea.sentido) {
                                        "devuelve" -> "Devuelve · "
                                        "recibe" -> "Recibe · "
                                        else -> ""
                                    }
                                    Text(listOfNotNull(
                                        "$sentido${linea.cantidad ?: "1"} × ${linea.descripcion.orEmpty()}",
                                        linea.estado?.takeIf { it.isNotBlank() },
                                        linea.observaciones?.takeIf { it.isNotBlank() },
                                    ).joinToString(" · "))
                                }
                                actual.observaciones?.takeIf { it.isNotBlank() }?.let { Text(it) }
                                Text("Declaración", style = MaterialTheme.typography.titleLarge)
                                Text(actual.declaracion.orEmpty())
                                Button(onClick = { modelo.paso = Paso.EMPLEADO }) { Text("Empezar a firmar") }
                            }
                            Paso.EMPLEADO, Paso.ALMACENISTA -> {
                                val empleado = modelo.paso == Paso.EMPLEADO
                                val trazo = if (empleado) modelo.empleado else modelo.almacenista
                                val editable = !modelo.enviando && !modelo.incierto
                                Text(if (empleado) "Firma del empleado" else "Firma del almacenista",
                                    style = MaterialTheme.typography.headlineMedium)
                                val nombre = if (empleado) actual.empleado else actual.responsable
                                nombre?.takeIf { it.isNotBlank() }?.let { Text(it) }
                                Lienzo(trazo, editable, anchoLienzo)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(enabled = editable, onClick = {
                                        modelo.paso = if (empleado) Paso.RESUMEN else Paso.EMPLEADO
                                    }) { Text("Volver") }
                                    OutlinedButton(enabled = editable && trazo.tieneTinta, onClick = trazo::borrar) {
                                        Text("Borrar")
                                    }
                                    Button(enabled = editable && trazo.tieneTinta, onClick = {
                                        if (empleado) modelo.paso = Paso.ALMACENISTA else modelo.enviar()
                                    }) {
                                        Text(when {
                                            empleado -> "Confirmar firma"
                                            modelo.enviando -> "Enviando…"
                                            modelo.incierto -> "Comprobando…"
                                            else -> "Enviar firmas"
                                        })
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun Lienzo(trazo: Trazo, editable: Boolean, ancho: Dp) {
    Canvas(
        Modifier.widthIn(max = ancho).fillMaxWidth().aspectRatio(ANCHO / ALTO).clipToBounds()
            .background(Color.White).border(1.dp, Color.Gray)
            .pointerInput(trazo, editable) {
                if (!editable) return@pointerInput
                fun punto(posicion: Offset) = Offset(
                    (posicion.x / size.width * ANCHO).coerceIn(0.5f, ANCHO - 0.5f),
                    (posicion.y / size.height * ALTO).coerceIn(0.5f, ALTO - 0.5f),
                )
                awaitEachGesture {
                    val inicio = awaitFirstDown(requireUnconsumed = true)
                    trazo.empezar(punto(inicio.position))
                    inicio.consume()
                    do {
                        val cambio = awaitPointerEvent().changes.firstOrNull { it.id == inicio.id } ?: break
                        if (cambio.isConsumed) break
                        for (muestra in cambio.historical) trazo.agregar(punto(muestra.position))
                        trazo.agregar(punto(cambio.position))
                        cambio.consume()
                    } while (cambio.pressed)
                }
            }
    ) {
        val canvas = drawContext.canvas.nativeCanvas
        canvas.save()
        canvas.scale(size.width / ANCHO, size.height / ALTO)
        trazo.dibujar(canvas)
        canvas.restore()
    }
}
