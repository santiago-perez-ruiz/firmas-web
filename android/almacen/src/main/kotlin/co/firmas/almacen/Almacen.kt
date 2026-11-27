package co.firmas.almacen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

private val rapidas = listOf("Excelente", "Bueno", "Regular", "Malo", "Con daños")
private val detalladas = listOf("Excelente", "Bueno", "Regular", "Mantenimiento")

@Composable
fun Almacen(modelo: AlmacenModelo, abrirAjustes: () -> Unit) {
    val ciclo = LocalLifecycleOwner.current
    LaunchedEffect(modelo, ciclo) {
        ciclo.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            var intervalo = 3_000L
            while (true) {
                intervalo = if (modelo.sondear()) 3_000L else (intervalo * 2).coerceAtMost(24_000L)
                delay(intervalo)
            }
        }
    }
    LaunchedEffect(modelo.pantalla) { modelo.cargar() }
    var cancelar by rememberSaveable { mutableStateOf<Long?>(null) }
    var repetir by rememberSaveable { mutableStateOf(false) }
    val activo = modelo.turno.activo
    val seguimiento = modelo.seguimiento
    val editable = !modelo.ocupado

    Column(Modifier.fillMaxSize()) {
        Surface(color = MaterialTheme.colorScheme.primaryContainer) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Almacén", style = MaterialTheme.typography.headlineSmall)
                TextButton(onClick = abrirAjustes, enabled = editable) { Text("Servidor") }
            }
        }
        ScrollableTabRow(selectedTabIndex = modelo.pantalla.ordinal, edgePadding = 8.dp) {
            Pantalla.entries.forEach { pantalla ->
                Tab(
                    selected = modelo.pantalla == pantalla,
                    enabled = editable,
                    onClick = { modelo.pantalla = pantalla; modelo.aviso = null },
                    text = { Text(pantalla.titulo) },
                )
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            if (activo != null) {
                Text("${activo.codigo} · Esperando firma", style = MaterialTheme.typography.titleMedium)
                TextButton(enabled = editable, onClick = { cancelar = activo.id }) {
                    Text("Cancelar movimiento")
                }
            }
            if (seguimiento != null && seguimiento.id != activo?.id) {
                val estado = when {
                    modelo.estadoDesconocido -> "Estado por confirmar"
                    seguimiento.estado == "firmado" -> "Firmado"
                    seguimiento.estado == "cancelado" -> "Cancelado"
                    else -> "Esperando confirmación del servidor"
                }
                val fecha = seguimiento.firmado_en?.let { " · $it" }.orEmpty()
                Text("${seguimiento.codigo} · $estado$fecha")
            }
            modelo.errorConexion?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            modelo.aviso?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (modelo.ocupado) Text("Consultando servidor…")
            if (modelo.turno.resultadoIncierto) {
                Text("El envío pudo haberse registrado. Verifica el resultado con la tablet o el historial antes de repetir.")
                TextButton(
                    enabled = editable && modelo.turno.comprobado && activo == null,
                    onClick = { repetir = true },
                ) { Text("Confirmar que puedo repetir el envío") }
            }
        }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when (modelo.pantalla) {
                Pantalla.Rapida, Pantalla.Detallada -> {
                    val detallada = modelo.pantalla == Pantalla.Detallada
                    val borrador = if (detallada) modelo.detallada else modelo.rapida
                    item {
                        Text(
                            if (detallada) "Herramientas asignadas" else "Entrega diaria",
                            style = MaterialTheme.typography.titleLarge,
                        )
                        Campo("Empleado", borrador.empleado, editable) { borrador.empleado = it }
                        Campo("Cédula", borrador.cedula, editable) { borrador.cedula = it }
                        Campo("Departamento", borrador.departamento, editable) { borrador.departamento = it }
                        if (detallada) Campo("Ficha", borrador.ficha, editable) { borrador.ficha = it }
                        Campo("Responsable", borrador.responsable, editable) { borrador.responsable = it }
                    }
                    itemsIndexed(borrador.lineas) { indice, linea ->
                        EditorLinea(indice, linea, if (detallada) detalladas else rapidas, detallada, editable,
                            quitar = if (borrador.lineas.size > 1) {
                                { borrador.lineas = borrador.lineas - linea }
                            } else null)
                    }
                    item {
                        OutlinedButton(enabled = editable, onClick = { borrador.lineas = borrador.lineas + Linea() }) {
                            Text("Añadir herramienta")
                        }
                        Campo("Observaciones generales", borrador.notas, editable, variasLineas = true) {
                            borrador.notas = it
                        }
                        if (detallada) {
                            Campo("Declaración", borrador.declaracion ?: modelo.declaracion.orEmpty(), editable, true) {
                                borrador.declaracion = it
                            }
                            if (modelo.declaracion == null) {
                                TextButton(enabled = editable, onClick = modelo::cargar) { Text("Cargar declaración") }
                            }
                        }
                    }
                }
                Pantalla.Gestion -> {
                    val gestion = modelo.gestion
                    if (gestion == null) {
                        item {
                            Text("Recepciones con herramientas pendientes", style = MaterialTheme.typography.titleLarge)
                            TextButton(enabled = editable, onClick = modelo::cargar) { Text("Actualizar pendientes") }
                            if (modelo.pendientes.isEmpty()) Text("Sin recepciones pendientes en la lista.")
                        }
                        itemsIndexed(modelo.pendientes, key = { _, movimiento -> movimiento.id }) { _, movimiento ->
                            OutlinedButton(
                                enabled = editable,
                                onClick = { modelo.gestion = Gestion(movimiento) },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text("${movimiento.codigo} · ${movimiento.empleado.orEmpty()} · ${movimiento.pendientes.orEmpty().size} pendientes") }
                        }
                    } else {
                        val entrega = gestion.entrega
                        item {
                            TextButton(enabled = editable, onClick = { modelo.gestion = null; modelo.cargar() }) {
                                Text("Volver a pendientes")
                            }
                            Text("${entrega.codigo} · ${entrega.empleado.orEmpty()}", style = MaterialTheme.typography.titleLarge)
                            val detalle = listOfNotNull(
                                entrega.cedula?.takeIf(String::isNotBlank),
                                entrega.codigo_empleado?.takeIf(String::isNotBlank),
                                entrega.departamento?.takeIf(String::isNotBlank),
                            )
                            if (detalle.isNotEmpty()) Text(detalle.joinToString(" · "))
                            entrega.observaciones?.takeIf(String::isNotBlank)?.let { Text(it) }
                            if (gestion.admiteCambio) {
                                Opciones(
                                    "Operación", if (gestion.cambio) "Cambio" else "Devolución",
                                    listOf("Devolución", "Cambio"), editable,
                                ) { gestion.cambio = it == "Cambio" }
                            }
                            Text("Líneas pendientes", style = MaterialTheme.typography.titleMedium)
                        }
                        itemsIndexed(gestion.regresos, key = { _, regreso -> checkNotNull(regreso.herramienta.id) }) { _, regreso ->
                            val herramienta = regreso.herramienta
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(regreso.seleccionado, { regreso.seleccionado = it }, enabled = editable)
                                Text("${herramienta.cantidad ?: "1"} × ${herramienta.descripcion.orEmpty()}")
                            }
                            herramienta.observaciones?.takeIf(String::isNotBlank)?.let { Text(it) }
                            if (regreso.seleccionado) {
                                Opciones("Condición de regreso", regreso.estado, rapidas, editable) { regreso.estado = it }
                                Campo("Observaciones de regreso", regreso.notas, editable) { regreso.notas = it }
                            } else {
                                herramienta.estado?.takeIf(String::isNotBlank)?.let { Text(it) }
                            }
                        }
                        if (gestion.cambio) {
                            item { Text("Herramientas que recibe", style = MaterialTheme.typography.titleMedium) }
                            itemsIndexed(gestion.nuevas) { indice, linea ->
                                EditorLinea(indice, linea, detalladas,
                                    true, editable, quitar = if (gestion.nuevas.size > 1) {
                                        { gestion.nuevas = gestion.nuevas - linea }
                                    } else null)
                            }
                            item {
                                OutlinedButton(enabled = editable, onClick = { gestion.nuevas = gestion.nuevas + Linea() }) {
                                    Text("Añadir herramienta nueva")
                                }
                            }
                        }
                        item {
                            Campo("Responsable", gestion.responsable, editable) { gestion.responsable = it }
                            Campo("Observaciones generales", gestion.notas, editable, true) { gestion.notas = it }
                        }
                    }
                }
            }
        }
        if (modelo.pantalla != Pantalla.Gestion || modelo.gestion != null) {
            Button(
                onClick = modelo::enviar,
                enabled = editable && modelo.turno.permiteAlta,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            ) { Text("Enviar para firma") }
        }
    }

    val id = cancelar
    if (id != null && activo?.id == id) {
        AlertDialog(
            onDismissRequest = { cancelar = null },
            title = { Text("¿Cancelar ${activo.codigo}?") },
            text = { Text("Se liberará el turno si el movimiento todavía espera firma.") },
            confirmButton = {
                TextButton(onClick = { cancelar = null; modelo.cancelar(id) }) { Text("Cancelar movimiento") }
            },
            dismissButton = { TextButton(onClick = { cancelar = null }) { Text("Conservar movimiento") } },
        )
    }
    if (repetir) {
        AlertDialog(
            onDismissRequest = { repetir = false },
            title = { Text("¿Verificaste el envío anterior?") },
            text = { Text("Confirma que el movimiento anterior no quedó registrado antes de permitir otro envío.") },
            confirmButton = {
                TextButton(onClick = { repetir = false; modelo.permitirRepetir() }) { Text("Permitir otro envío") }
            },
            dismissButton = { TextButton(onClick = { repetir = false }) { Text("Volver") } },
        )
    }
}

@Composable
private fun EditorLinea(
    indice: Int, linea: Linea, condiciones: List<String>, notas: Boolean, editable: Boolean, quitar: (() -> Unit)?,
) {
    HorizontalDivider()
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Herramienta ${indice + 1}", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
        if (quitar != null) TextButton(enabled = editable, onClick = quitar) { Text("Quitar") }
    }
    Campo("Descripción", linea.descripcion, editable) { linea.descripcion = it }
    Campo("Cantidad", linea.cantidad, editable) { linea.cantidad = it }
    Opciones("Condición", linea.estado, condiciones, editable) { linea.estado = it }
    if (notas) Campo("Observaciones de la herramienta", linea.notas, editable) { linea.notas = it }
}

@Composable
private fun Campo(
    etiqueta: String, valor: String, editable: Boolean, variasLineas: Boolean = false, cambiar: (String) -> Unit,
) {
    OutlinedTextField(
        value = valor, onValueChange = cambiar, enabled = editable, label = { Text(etiqueta) },
        singleLine = !variasLineas, modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
    )
}

@Composable
private fun Opciones(etiqueta: String, valor: String, opciones: List<String>, editable: Boolean, elegir: (String) -> Unit) {
    var abierto by rememberSaveable { mutableStateOf(false) }
    Box {
        OutlinedButton(enabled = editable, onClick = { abierto = true }) { Text("$etiqueta · $valor") }
        DropdownMenu(expanded = abierto, onDismissRequest = { abierto = false }) {
            (listOf(valor) + opciones).distinct().forEach {
                DropdownMenuItem(text = { Text(it) }, onClick = { elegir(it); abierto = false })
            }
        }
    }
}
