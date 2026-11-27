plugins { kotlin("jvm") }
kotlin { jvmToolchain(17) }
dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation("junit:junit:4.13.2")
}
tasks.test {
    inputs.property("servidorPruebas", providers.environmentVariable("FIRMAS_URL_PRUEBAS").orElse(""))
}
