'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const Database = require('better-sqlite3');
const Excel = require('exceljs');

const raiz = path.resolve(__dirname, '../..');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXWQAAAAASUVORK5CYII=',
  'base64'
);
const firma = 'data:image/png;base64,' + png.toString('base64');
const firmas = { firmaEmpleado: firma, firmaResponsable: firma };
const rapida = {
  tipo: 'ENTREGA',
  empleado: 'Empleado sintético rápido',
  herramientas: [{ descripcion: 'Martillo sintético' }],
};
const detallada = {
  tipo: 'ENTREGA',
  modo: 'detallada',
  empleado: 'Empleado sintético detallado',
  cedula: 'CEDULA-SINTETICA',
  departamento: 'Área de prueba',
  codigoEmpleado: 'FICHA-SINTETICA',
  responsable: 'Responsable sintético',
  declaracion: 'Declaración sintética editable.',
  observaciones: 'Observación general de prueba',
  herramientas: [
    { descripcion: 'Taladro sintético', cantidad: '2', estado: 'Bueno', observaciones: 'Línea de prueba' },
    { descripcion: 'Pinza sintética', estado: 'Mantenimiento' },
    { descripcion: 'Llave sintética', estado: 'Regular' },
  ],
};

async function conServidor(datos, ejecutar, { clave = '982741', entrar = true, env = {}, preparar = '' } = {}) {
  // El sistema asigna y reserva el puerto en la misma operación de escucha.
  // Interceptamos listen únicamente en el hijo para limitarlo a loopback.
  const arranque = `
    const { Server } = require('node:http');
    const escuchar = Server.prototype.listen;
    Server.prototype.listen = function () {
      this.once('listening', () => process.send(this.address().port));
      return escuchar.call(this, 0, '127.0.0.1');
    };
    ${preparar}
    require('./server');
  `;
  const hijo = spawn(process.execPath, ['-e', arranque], {
    cwd: raiz,
    env: { DATA_DIR: datos, CLAVE_ACCESO: clave, TZ: 'America/Bogota', ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errores = '';
  hijo.stderr.on('data', (dato) => { errores += dato; });
  const cerrado = once(hijo, 'close');
  const espera = AbortSignal.timeout(10_000);
  try {
    const puerto = await Promise.race([
      once(hijo, 'message', { signal: espera }).then(([valor]) => valor),
      cerrado.then(([codigo]) => { throw new Error(`Servidor terminó (${codigo})\n${errores}`); }),
    ]);
    assert.ok(puerto > 0 && ![3000, 8090].includes(puerto));
    const base = `http://127.0.0.1:${puerto}`;
    let cookie;
    const pedir = (ruta, opciones) => {
      const headers = { ...(cookie ? { cookie } : {}), ...opciones?.headers };
      const signal = AbortSignal.timeout(10_000);
      if (!headers.host) return fetch(base + ruta, { signal, ...opciones, headers });
      // fetch sustituye Host por el de la URL de loopback. HTTP permite probar el enrutamiento.
      return new Promise((resolve, reject) => {
        const solicitud = http.request(base + ruta, { ...opciones, signal, headers }, (respuesta) => {
          resolve(new Response(Readable.toWeb(respuesta), {
            status: respuesta.statusCode, headers: respuesta.headers,
          }));
        });
        solicitud.on('error', reject);
        solicitud.end(opciones?.body);
      });
    };
    if (entrar) {
      const entrada = await pedir('/entrar', post({ clave }));
      assert.equal(entrada.status, 200);
      cookie = entrada.headers.get('set-cookie').split(';')[0];
    }
    await ejecutar(pedir);
  } finally {
    hijo.kill();
    await cerrado;
  }
}

function post(cuerpo) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  };
}

async function json(pedir, ruta, estado = 200, opciones) {
  const respuesta = await pedir(ruta, opciones);
  assert.equal(respuesta.status, estado, ruta);
  assert.match(respuesta.headers.get('content-type'), /^application\/json/);
  return respuesta.json();
}

const alta = (pedir, cuerpo) => json(pedir, '/api/movimientos', 201, post(cuerpo));
const firmar = (pedir, id, cuerpo = firmas, estado = 200) =>
  json(pedir, `/api/movimientos/${id}/firmar`, estado, post(cuerpo));
const cancelar = (pedir, id) =>
  json(pedir, `/api/movimientos/${id}/cancelar`, 200, post({}));

function revisarBase(datos) {
  const base = new Database(path.join(datos, 'firmas.db'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(base.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(base.pragma('foreign_key_check'), []);
    return base.prepare('SELECT * FROM movimientos ORDER BY id').all();
  } finally {
    base.close();
  }
}

test('Contrato actual desde una base vacía', async (t) => {
  const datos = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-vacia-'));
  t.after(() => fs.rm(datos, { recursive: true, force: true }));

  await conServidor(datos, async (pedir) => {
    assert.deepEqual(await json(pedir, '/api/salud'), { ok: true });
    const declaraciones = await json(pedir, '/api/declaraciones');
    assert.deepEqual(Object.keys(declaraciones).sort(), ['CAMBIO', 'DEVOLUCION', 'ENTREGA']);
    assert.equal(await json(pedir, '/api/activo'), null);
    assert.deepEqual(await json(pedir, '/api/historial'), { grupos: [], sueltas: [] });

    const invalida = await json(pedir, '/api/movimientos', 400, post({ tipo: 'ENTREGA' }));
    assert.match(invalida.error, /nombre del empleado/);

    // Línea base de #14: las dos altas pueden prosperar y la última sustituye la primera.
    const altas = await Promise.all([alta(pedir, rapida), alta(pedir, rapida)]);
    altas.sort((a, b) => a.id - b.id);
    const [anterior, activo] = altas;
    assert.match(activo.codigo, /^TRX-\d{4}-002$/);
    assert.equal(activo.modo, 'rapida');
    assert.equal(activo.declaracion, declaraciones.ENTREGA);
    assert.deepEqual((await json(pedir, '/api/movimientos')).map((m) => m.id), [activo.id]);
    assert.equal((await json(pedir, '/api/activo')).id, activo.id);
    assert.equal((await pedir(`/api/movimientos/${activo.id}/estado`)).status, 404);
    assert.match((await firmar(pedir, anterior.id, firmas, 400)).error, /ya no está activo/);
    assert.deepEqual(await cancelar(pedir, anterior.id), { ok: true });
    assert.equal((await json(pedir, '/api/activo')).id, activo.id);
    assert.match((await firmar(pedir, activo.id, {}, 400)).error, /Falta la firma/);
    const firmada = await firmar(pedir, activo.id, { firmaEmpleado: firma });
    assert.equal(firmada.firmaResponsableUrl, null);
    assert.equal(firmada.estado, 'firmado');
    assert.equal(await json(pedir, '/api/activo'), null);

    const recepcion = await alta(pedir, detallada);
    assert.match(recepcion.codigo, /^TRXD-\d{4}-001$/);
    assert.equal(recepcion.codigo_empleado, detallada.codigoEmpleado);
    assert.equal(recepcion.declaracion, detallada.declaracion);
    assert.deepEqual(recepcion.herramientas.map((h) => h.id), [1, 2, 3]);
    await firmar(pedir, recepcion.id);

    const gestion = { entregaId: recepcion.id, empleado: 'Valor ignorado', modo: 'rapida' };
    const devolucion = await alta(pedir, {
      ...gestion, tipo: 'DEVOLUCION', herramientas: [{ id: 1, cantidad: '1', estado: 'Regular' }],
    });
    assert.equal(devolucion.empleado, detallada.empleado);
    assert.equal(devolucion.modo, 'detallada');
    assert.equal(devolucion.entregaCodigo, recepcion.codigo);
    assert.equal(devolucion.herramientas[0].cantidad, '2');
    const pendientes = async () => {
      const lista = await json(pedir, '/api/entregas-pendientes');
      return lista.find((m) => m.id === recepcion.id)?.pendientes.map((h) => h.id) || [];
    };
    assert.deepEqual(await pendientes(), [1, 2, 3]);
    await firmar(pedir, devolucion.id);
    assert.deepEqual(await pendientes(), [2, 3]);

    const cambio = {
      ...gestion, tipo: 'CAMBIO',
      herramientas: [
        { id: 2, sentido: 'devuelve' },
        { descripcion: 'Repuesto sintético', sentido: 'recibe', estado: 'Excelente' },
      ],
    };
    const duplicado = { ...cambio, herramientas: [...cambio.herramientas, cambio.herramientas[0]] };
    assert.match((await json(pedir, '/api/movimientos', 400, post(duplicado))).error, /no está pendiente/);
    const descartado = await alta(pedir, cambio);
    assert.deepEqual(descartado.herramientas.map((h) => h.id), [2, 4]);
    assert.deepEqual(await cancelar(pedir, descartado.id), { ok: true });
    assert.match((await firmar(pedir, descartado.id, firmas, 400)).error, /ya no está activo/);
    assert.deepEqual(await pendientes(), [2, 3]);
    const aceptado = await alta(pedir, cambio);
    assert.deepEqual(aceptado.herramientas.map((h) => h.id), [2, 5]);
    await firmar(pedir, aceptado.id);
    assert.deepEqual(await pendientes(), [3, 5]);

    const cierre = await alta(pedir, {
      ...gestion, tipo: 'DEVOLUCION', herramientas: [{ id: 3 }, { id: 5 }],
    });
    await firmar(pedir, cierre.id);
    assert.deepEqual(await pendientes(), []);
    const { grupos } = await json(pedir, '/api/historial');
    const grupo = grupos.find((g) => g.entrega.id === recepcion.id);
    assert.equal(grupo.ciclo, 'completa');
    assert.deepEqual(grupo.devoluciones.map((m) => m.id), [devolucion.id, aceptado.id, cierre.id]);
    assert.deepEqual(grupo.entrega.herramientas.map((h) => [h.id, h.cerradaPor, h.llegoEn]), [
      [1, 'DEVOLUCION', null], [2, 'CAMBIO', null],
      [3, 'DEVOLUCION', null], [5, 'DEVOLUCION', aceptado.codigo],
    ]);
    await comprobarArchivos(pedir, grupo.entrega);
  });
  const filas = revisarBase(datos);
  assert.deepEqual(filas.map((m) => m.estado), [
    'cancelado', 'firmado', 'firmado', 'firmado', 'cancelado', 'firmado', 'firmado',
  ]);
});

async function comprobarArchivos(pedir, movimiento) {
  for (const url of [movimiento.firmaEmpleadoUrl, movimiento.firmaResponsableUrl]) {
    const respuesta = await pedir(url);
    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers.get('content-type'), /^image\/png/);
    assert.deepEqual(Buffer.from(await respuesta.arrayBuffer()), png);
  }
  const pdf = await pedir(`/api/entregas/${movimiento.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('content-disposition'), `attachment; filename="${movimiento.codigo}.pdf"`);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  const excel = await pedir('/api/export.xlsx');
  assert.equal(excel.status, 200);
  assert.match(excel.headers.get('content-type'), /spreadsheetml\.sheet/);
  const libro = new Excel.Workbook();
  await libro.xlsx.load(Buffer.from(await excel.arrayBuffer()));
  assert.deepEqual(libro.worksheets.map((hoja) => hoja.name), ['Registro de Firmas', 'Informe Diario']);
  const registro = libro.getWorksheet('Registro de Firmas');
  assert.ok(registro.getImages().length >= 2);
}

test('Migración y restauración de una base sintética antigua con sus firmas', async (t) => {
  const temporal = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-antigua-'));
  t.after(() => fs.rm(temporal, { recursive: true, force: true }));
  const datos = path.join(temporal, 'data');
  const imagenes = path.join(datos, 'firmas');
  await fs.mkdir(imagenes, { recursive: true });
  const base = new Database(path.join(datos, 'firmas.db'));
  try {
    base.exec(await fs.readFile(path.join(__dirname, 'antigua.sql'), 'utf8'));
  } finally {
    base.close();
  }
  for (const nombre of ['1-empleado.png', '1-responsable.png', '2-empleado.png']) {
    await fs.writeFile(path.join(imagenes, nombre), png);
  }

  let historial;
  await conServidor(datos, async (pedir) => {
    historial = await json(pedir, '/api/historial');
    const { entrega, pendientes, ciclo } = historial.grupos[0];
    assert.equal(entrega.codigo, 'TRX-2020-001');
    assert.equal(entrega.modo, 'rapida');
    assert.equal(entrega.codigo_empleado, '');
    assert.equal(entrega.firmado_en, '2020-02-01T13:01:00.000Z');
    assert.equal(entrega.declaracion, (await json(pedir, '/api/declaraciones')).ENTREGA);
    assert.deepEqual(pendientes.map((h) => h.id), [1, 2]);
    assert.equal(ciclo, 'sin-devolver');
    assert.equal(historial.sueltas.length, 1);
    assert.equal(historial.sueltas[0].entrega_id, null);
    assert.equal(historial.sueltas[0].codigo, 'TRX-2020-002');
    assert.equal(historial.sueltas[0].firmaResponsableUrl, null);
    await comprobarArchivos(pedir, entrega);
  });

  // Copia de la carpeta completa con el servidor detenido y lectura desde otra ruta.
  const respaldo = path.join(temporal, 'respaldo');
  const restaurada = path.join(temporal, 'restaurada');
  await fs.cp(datos, respaldo, { recursive: true });
  await fs.cp(respaldo, restaurada, { recursive: true });
  await conServidor(restaurada, async (pedir) => {
    assert.deepEqual(await json(pedir, '/api/historial'), historial);
    await comprobarArchivos(pedir, historial.grupos[0].entrega);
    const suelta = historial.sueltas[0];
    const imagen = await pedir(suelta.firmaEmpleadoUrl);
    assert.equal(imagen.status, 200);
    assert.deepEqual(Buffer.from(await imagen.arrayBuffer()), png);
  });
  assert.deepEqual(revisarBase(restaurada), revisarBase(datos));
});

test('Acceso actual con clave sintética compartida', async (t) => {
  const datos = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-acceso-'));
  t.after(() => fs.rm(datos, { recursive: true, force: true }));
  const clave = '123456';
  await conServidor(datos, async (pedir) => {
    assert.equal((await json(pedir, '/api/salud')).ok, true);
    assert.deepEqual(await json(pedir, '/api/activo', 401), { error: 'Sesión caducada' });
    assert.equal((await pedir('/firmar', { redirect: 'manual' })).status, 302);
    const entrada = await pedir('/entrar', post({ clave }));
    assert.equal(entrada.status, 200);
    const cookie = entrada.headers.get('set-cookie').split(';')[0];
    assert.equal(await json(pedir, '/api/activo', 200, { headers: { cookie } }), null);

    const eventos = await pedir('/api/eventos', { headers: { cookie } });
    assert.match(eventos.headers.get('content-type'), /^text\/event-stream/);
    const lector = eventos.body.getReader();
    try {
      let texto = '';
      while (!texto.includes('event: latido\ndata: {}\n\n')) {
        const fragmento = await lector.read();
        assert.equal(fragmento.done, false);
        texto += Buffer.from(fragmento.value).toString();
      }
    } finally {
      await lector.cancel();
    }
  }, { clave, entrar: false });
});

test('Roles, vinculación de un solo uso, persistencia y revocación', async (t) => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'sintetica', alg: 'RS256' };
  const emisor = 'https://contrato-sintetico.cloudflareaccess.com';
  const audiencia = 'audiencia-sintetica';
  const admin = 'administracion@contrato.invalid';
  const operador = 'operacion@contrato.invalid';
  const token = (email, aud = audiencia, exp = '5m') => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(emisor).setAudience(aud).setSubject('sujeto-sintetico-' + email.split('@')[0])
    .setExpirationTime(exp).sign(privateKey);
  const [jwtAdmin, jwtOperador, jwtSinRol, jwtOtraAudiencia, jwtVencido] = await Promise.all([
    token(admin), token(operador), token('sin-rol@contrato.invalid'),
    token(admin, 'otra-audiencia'), token(admin, audiencia, '0s'),
  ]);
  const datos = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-roles-'));
  t.after(() => fs.rm(datos, { recursive: true, force: true }));
  const panel = 'panel.contrato.invalid';
  const movil = 'movil.contrato.invalid';
  const configuracion = {
    entrar: false,
    env: {
      ACCESO_MODO: 'roles', ACCESS_EMISOR: emisor, ACCESS_AUDIENCIA: audiencia,
      ACCESS_ADMINISTRADORES: admin, ACCESS_OPERADORES: operador,
      HOST_PANEL: panel, HOST_MOVIL: movil,
    },
    preparar: `
      global.fetch = async (url) => {
        if (String(url) !== ${JSON.stringify(emisor + '/cdn-cgi/access/certs')}) throw new Error('URL inesperada');
        return Response.json({ keys: [${JSON.stringify(jwk)}] });
      };
    `,
  };
  const cliente = (pedir, host, headers = {}) => (ruta, opciones) =>
    pedir(ruta, { ...opciones, headers: { host, ...headers, ...opciones?.headers } });
  let vinculada;
  let movimiento;
  await conServidor(datos, async (pedir) => {
    const administrar = cliente(pedir, panel, { 'Cf-Access-Jwt-Assertion': jwtAdmin });
    const operar = cliente(pedir, movil, { authorization: 'Bearer ' + jwtOperador });
    const anonimo = cliente(pedir, movil);
    const sinSesionPanel = cliente(pedir, panel);
    assert.deepEqual(await json(anonimo, '/api/salud'), { ok: true });
    assert.equal((await sinSesionPanel('/registros.html')).status, 401);
    assert.equal((await sinSesionPanel('/js/flujo.js')).status, 401);
    assert.equal((await administrar('/registros.html')).status, 200);
    assert.equal((await administrar('/js/flujo.js')).status, 200);
    assert.equal((await administrar('/detallada.html')).status, 403);
    assert.equal((await administrar('/%64etallada.html')).status, 403);
    assert.equal((await administrar('/api/activo')).status, 403);
    assert.equal((await administrar('/api/movimientos', post(rapida))).status, 403);
    assert.equal((await operar('/api/historial')).status, 404);
    assert.equal((await operar('/api/export.xlsx')).status, 404);
    assert.equal((await operar('/api/entregas/1/pdf')).status, 404);
    assert.equal((await operar('/registros.html')).status, 404);
    assert.equal((await operar('/api/eventos')).status, 404);
    const operarWeb = cliente(pedir, panel, { 'Cf-Access-Jwt-Assertion': jwtOperador });
    assert.equal((await operarWeb('/detallada.html')).status, 200);
    assert.equal((await operarWeb('/registros.html')).status, 403);
    assert.equal((await operarWeb('/api/export.xlsx')).status, 403);
    assert.equal((await operarWeb('/api/entregas/1/pdf')).status, 403);

    const consultarHistorial = (jwt) => administrar('/api/historial', {
      headers: { 'Cf-Access-Jwt-Assertion': jwt },
    });
    assert.equal((await consultarHistorial(jwtOtraAudiencia)).status, 401);
    assert.equal((await consultarHistorial(jwtVencido)).status, 401);
    assert.equal((await consultarHistorial(jwtSinRol)).status, 403);
    const [cabecera, contenido, firmaJwt] = jwtAdmin.split('.');
    const modificada = (firmaJwt[0] === 'A' ? 'B' : 'A') + firmaJwt.slice(1);
    assert.equal((await consultarHistorial([cabecera, contenido, modificada].join('.'))).status, 401);
    assert.equal((await sinSesionPanel('/api/historial', {
      headers: { 'Cf-Access-Authenticated-User-Email': admin },
    })).status, 401);
    assert.equal((await administrar('/api/dispositivos/codigos', {
      method: 'POST', headers: { origin: 'https://ajeno.contrato.invalid' },
    })).status, 403);
    assert.deepEqual(await json(operar, '/api/dispositivos/sesion'), { rol: 'operacion', dispositivoId: null });
    const anterior = await alta(operar, rapida);

    const provision = await json(administrar, '/api/dispositivos/codigos', 201, post({}));
    assert.equal((await administrar('/api/dispositivos/codigos', post({}))).status, 409);
    const vincular = '/api/dispositivos/vincular';
    assert.equal((await administrar(vincular, post({ codigo: provision.codigo }))).status, 404);
    const solicitudes = await Promise.all([
      anonimo(vincular, post({ codigo: provision.codigo })),
      anonimo(vincular, post({ codigo: provision.codigo })),
    ]);
    assert.deepEqual(solicitudes.map((r) => r.status).sort(), [200, 401]);
    vinculada = await solicitudes.find((r) => r.ok).json();
    assert.equal(vinculada.dispositivoId, provision.dispositivoId);
    const tablet = cliente(pedir, movil, { authorization: 'Bearer ' + vinculada.credencial });
    assert.deepEqual(await json(tablet, '/api/dispositivos/sesion'), {
      rol: 'tablet', dispositivoId: vinculada.dispositivoId,
    });
    const respuestaActivo = await tablet('/api/activo');
    assert.equal(respuestaActivo.headers.get('cache-control'), 'no-store');
    assert.equal(await respuestaActivo.json(), null);
    assert.equal((await firmar(tablet, anterior.id, firmas, 404)).codigo, 'NO_ENCONTRADO');
    assert.equal((await tablet(`/api/movimientos/${anterior.id}/estado`)).status, 404);
    assert.equal((await tablet('/api/movimientos', post(rapida))).status, 403);
    assert.equal((await tablet('/api/declaraciones')).status, 403);
    assert.equal((await tablet('/firmar.html')).status, 404);

    await cancelar(operar, anterior.id);
    movimiento = await alta(operar, detallada);
    assert.equal((await json(tablet, '/api/activo')).id, movimiento.id);
    assert.equal((await firmar(operar, movimiento.id, firmas, 403)).codigo, 'PERMISO_DENEGADO');
    const firmado = await firmar(tablet, movimiento.id);
    assert.equal((await administrar(firmado.firmaEmpleadoUrl)).status, 200);
    assert.equal((await operarWeb(firmado.firmaEmpleadoUrl)).status, 403);
    assert.equal((await tablet(firmado.firmaEmpleadoUrl)).status, 404);
    assert.equal((await administrar('/api/export.xlsx')).status, 200);
    assert.equal((await administrar(`/api/entregas/${movimiento.id}/pdf`)).status, 200);
    assert.equal((await administrar('/firmas/inexistente.png')).status, 404);
    const base = new Database(path.join(datos, 'firmas.db'), { readonly: true });
    try {
      const fila = base.prepare('SELECT * FROM dispositivos WHERE id = ?').get(vinculada.dispositivoId);
      assert.equal(fila.codigo_hash, null);
      assert.match(fila.credencial_hash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(fila).includes(vinculada.credencial));
    } finally {
      base.close();
    }
  }, configuracion);

  await conServidor(datos, async (pedir) => {
    const administrar = cliente(pedir, panel, { 'Cf-Access-Jwt-Assertion': jwtAdmin });
    const tablet = cliente(pedir, movil, { authorization: 'Bearer ' + vinculada.credencial });
    assert.equal((await tablet('/api/dispositivos/sesion')).status, 200);
    assert.deepEqual(await json(administrar, `/api/dispositivos/${vinculada.dispositivoId}/revocar`, 200, post({})), { ok: true });
    for (const ruta of ['/api/dispositivos/sesion', '/api/activo', `/api/movimientos/${movimiento.id}/estado`]) {
      assert.equal((await json(tablet, ruta, 401)).codigo, 'SESION_REQUERIDA');
    }
    await firmar(tablet, movimiento.id, firmas, 401);
    const reemplazo = await json(administrar, '/api/dispositivos/codigos', 201, post({}));
    const base = new Database(path.join(datos, 'firmas.db'));
    try {
      base.prepare('UPDATE dispositivos SET codigo_caduca = ? WHERE id = ?').run(1, reemplazo.dispositivoId);
    } finally {
      base.close();
    }

    const anonimo = cliente(pedir, movil);
    assert.equal((await anonimo('/api/dispositivos/vincular', post({ codigo: reemplazo.codigo }))).status, 401);
    assert.equal((await administrar('/api/dispositivos/codigos', post({}))).status, 201);
    for (let i = 0; i < 11; i++) {
      assert.equal((await anonimo('/api/dispositivos/vincular', post({ codigo: 'invalido' }))).status, 400);
    }
    const limitada = await anonimo('/api/dispositivos/vincular', post({ codigo: 'invalido' }));
    assert.equal(limitada.status, 429);
    assert.ok(Number(limitada.headers.get('retry-after')) > 0);
  }, configuracion);
});
