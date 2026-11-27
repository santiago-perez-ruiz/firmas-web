package co.firmas.comun

data class Herramienta(
    val id: Long? = null,
    val descripcion: String? = null,
    val cantidad: String? = null,
    val estado: String? = null,
    val observaciones: String? = null,
    val sentido: String? = null,
)

data class Alta(
    val tipo: String,
    val herramientas: List<Herramienta>,
    val modo: String? = null,
    val empleado: String? = null,
    val cedula: String? = null,
    val departamento: String? = null,
    val codigoEmpleado: String? = null,
    val responsable: String? = null,
    val observaciones: String? = null,
    val declaracion: String? = null,
    val entregaId: Long? = null,
)

data class Movimiento(
    val id: Long,
    val codigo: String,
    val estado: String,
    val firmado_en: String?,
    val tipo: String?,
    val modo: String?,
    val empleado: String?,
    val cedula: String?,
    val departamento: String?,
    val codigo_empleado: String?,
    val responsable: String?,
    val observaciones: String?,
    val declaracion: String?,
    val creado_en: String?,
    val herramientas: List<Herramienta>?,
    val pendientes: List<Herramienta>?,
)

data class Turno(
    val comprobado: Boolean = false,
    val activo: Movimiento? = null,
    val resultadoIncierto: Boolean = false,
) {
    val permiteAlta get() = comprobado && activo == null && !resultadoIncierto

    fun trasLectura(activo: Movimiento?) = copy(comprobado = true, activo = activo)

    fun trasFalloAlta(error: Exception) = copy(
        comprobado = false,
        resultadoIncierto = error !is ErrorApi || error.http !in 400..499,
    )

    fun permitirRepetir() = copy(resultadoIncierto = false)
}
