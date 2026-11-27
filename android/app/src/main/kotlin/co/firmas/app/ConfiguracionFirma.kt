package co.firmas.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec

internal class ConfiguracionFirma(context: Context) {
    private val preferencias = context.getSharedPreferences("configuracion_firma", Context.MODE_PRIVATE)
    val activa get() = preferencias.getBoolean("activa", false)
    val origen get() = preferencias.getString("origen", "").orEmpty()
    val tienePin get() = preferencias.contains("huella")

    fun credencial(): String {
        val dato = preferencias.getString("credencial", null) ?: return ""
        val bytes = Base64.decode(dato, Base64.NO_WRAP)
        val cifrado = Cipher.getInstance("AES/GCM/NoPadding")
        cifrado.init(Cipher.DECRYPT_MODE, clave(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cifrado.updateAAD(origen.toByteArray())
        return cifrado.doFinal(bytes, 12, bytes.size - 12).toString(Charsets.UTF_8)
    }

    fun guardar(origen: String, credencial: String, pinNuevo: String?) {
        val cifrado = Cipher.getInstance("AES/GCM/NoPadding")
        cifrado.init(Cipher.ENCRYPT_MODE, clave())
        cifrado.updateAAD(origen.toByteArray())
        val dato = cifrado.iv + cifrado.doFinal(credencial.toByteArray())
        val cambio = preferencias.edit().putBoolean("activa", true).putString("origen", origen)
            .putString("credencial", codificar(dato))
        if (!tienePin) {
            require(pinNuevo != null && pinNuevo.matches(Regex("[0-9]{6,12}"))) {
                "El PIN de soporte debe tener entre 6 y 12 dígitos."
            }
            val sal = ByteArray(16).also(SecureRandom()::nextBytes)
            cambio.putString("sal", codificar(sal)).putString("huella", codificar(derivar(pinNuevo, sal)))
        }
        check(cambio.commit()) { "No se pudo guardar la configuración de Firma." }
    }

    fun autenticar(pin: String): Boolean {
        val ahora = System.currentTimeMillis()
        check(ahora >= preferencias.getLong("bloqueado_hasta", 0L)) {
            "Demasiados intentos. Espera un minuto."
        }
        val sal = Base64.decode(checkNotNull(preferencias.getString("sal", null)), Base64.NO_WRAP)
        val huella = Base64.decode(checkNotNull(preferencias.getString("huella", null)), Base64.NO_WRAP)
        val correcto = pin.length in 6..12 && MessageDigest.isEqual(huella, derivar(pin, sal))
        val intentos = if (correcto) 0 else preferencias.getInt("intentos", 0) + 1
        check(preferencias.edit().putInt("intentos", intentos % 5)
            .putLong("bloqueado_hasta", if (intentos >= 5) ahora + 60_000 else 0).commit()) {
            "No se pudo comprobar el PIN."
        }
        return correcto
    }

    fun salir() {
        check(preferencias.edit().putBoolean("activa", false).commit()) {
            "No se pudo salir del modo Firma."
        }
    }

    private fun clave(): SecretKey {
        val nombre = "credencial_tablet_firma"
        val almacen = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (almacen.getKey(nombre, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(nombre,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    private fun derivar(pin: String, sal: ByteArray): ByteArray {
        val clave = PBEKeySpec(pin.toCharArray(), sal, 210_000, 256)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(clave).encoded
        } finally {
            clave.clearPassword()
        }
    }

    private fun codificar(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
}
