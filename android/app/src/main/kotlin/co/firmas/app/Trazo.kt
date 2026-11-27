package co.firmas.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.util.Base64
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.geometry.Offset
import java.io.ByteArrayOutputStream

// El lienzo virtual conserva la misma geometría en cualquier orientación.
internal const val ANCHO = 960f
internal const val ALTO = 360f
private const val GROSOR = 5f

internal class Trazo {
    private val lineas = mutableStateListOf<MutableList<Offset>>()
    val tieneTinta get() = lineas.isNotEmpty()

    fun empezar(punto: Offset) { lineas.add(mutableStateListOf(punto)) }
    fun agregar(punto: Offset) {
        val ultima = lineas.lastOrNull() ?: return
        if (ultima.last() != punto) ultima.add(punto)
    }

    fun borrar() = lineas.clear()

    fun dibujar(canvas: Canvas) {
        val pintura = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(20, 32, 49)
            strokeWidth = GROSOR
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        for (puntos in lineas) {
            val primero = puntos.first()
            if (puntos.size == 1) {
                pintura.style = Paint.Style.FILL
                canvas.drawCircle(primero.x, primero.y, GROSOR / 2, pintura)
                continue
            }
            val camino = Path().apply { moveTo(primero.x, primero.y) }
            for (i in 1 until puntos.size) {
                val anterior = puntos[i - 1]
                val medio = (anterior + puntos[i]) / 2f
                camino.quadTo(anterior.x, anterior.y, medio.x, medio.y)
            }
            val ultimo = puntos.last()
            camino.lineTo(ultimo.x, ultimo.y)
            pintura.style = Paint.Style.STROKE
            canvas.drawPath(camino, pintura)
        }
    }

    fun png(): String {
        check(tieneTinta)
        val imagen = Bitmap.createBitmap(ANCHO.toInt(), ALTO.toInt(), Bitmap.Config.ARGB_8888)
        try {
            dibujar(Canvas(imagen))
            val pixeles = IntArray(imagen.width * imagen.height)
            imagen.getPixels(pixeles, 0, imagen.width, 0, 0, imagen.width, imagen.height)
            var izquierda = imagen.width
            var arriba = imagen.height
            var derecha = 0
            var abajo = 0
            for ((indice, pixel) in pixeles.withIndex()) {
                if (pixel ushr 24 == 0) continue
                val x = indice % imagen.width
                val y = indice / imagen.width
                izquierda = minOf(izquierda, x)
                arriba = minOf(arriba, y)
                derecha = maxOf(derecha, x)
                abajo = maxOf(abajo, y)
            }
            val recorte = Bitmap.createBitmap(imagen, izquierda, arriba, derecha - izquierda + 1, abajo - arriba + 1)
            try {
                val salida = ByteArrayOutputStream()
                check(recorte.compress(Bitmap.CompressFormat.PNG, 100, salida))
                return "data:image/png;base64," + Base64.encodeToString(salida.toByteArray(), Base64.NO_WRAP)
            } finally {
                if (recorte !== imagen) recorte.recycle()
            }
        } finally {
            imagen.recycle()
        }
    }
}
