'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const Database = require('better-sqlite3');
const Excel = require('exceljs');

const raiz = path.resolve(__dirname, '../..');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==',
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

async function conServidor(datos, ejecutar, clave = '', preparar = '') {
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
    env: { DATA_DIR: datos, CLAVE_ACCESO: clave, TZ: 'America/Bogota' },
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
    await ejecutar((ruta, opciones) => fetch(base + ruta, {
      signal: AbortSignal.timeout(10_000), ...opciones,
    }));
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
    assert.deepEqual(await json(pedir, '/api/salud'), { ok: true, conectados: 0 });
    const declaraciones = await json(pedir, '/api/declaraciones');
    assert.deepEqual(Object.keys(declaraciones).sort(), ['CAMBIO', 'DEVOLUCION', 'ENTREGA']);
    assert.equal(await json(pedir, '/api/activo'), null);
    assert.deepEqual(await json(pedir, '/api/historial'), { grupos: [], sueltas: [] });

    const invalida = await json(pedir, '/api/movimientos', 400, post({ tipo: 'ENTREGA' }));
    assert.match(invalida.error, /nombre del empleado/);

    const altas = await Promise.all([
      pedir('/api/movimientos', post(rapida)), pedir('/api/movimientos', post(rapida)),
    ]);
    altas.sort((a, b) => a.status - b.status);
    assert.deepEqual(altas.map((r) => r.status), [201, 409]);
    const [anterior, conflicto] = await Promise.all(altas.map((r) => r.json()));
    assert.equal(conflicto.codigo, 'MOVIMIENTO_ACTIVO');
    assert.match(anterior.codigo, /^TRX-\d{4}-001$/);
    assert.deepEqual((await json(pedir, '/api/movimientos')).map((m) => m.id), [anterior.id]);
    assert.equal((await json(pedir, '/api/activo')).id, anterior.id);
    const rutaAnterior = `/api/movimientos/${anterior.id}/estado`;
    const estado = await pedir(rutaAnterior);
    assert.equal(estado.status, 200);
    assert.equal(estado.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await estado.json(), {
      id: anterior.id, codigo: anterior.codigo, estado: 'esperando', firmado_en: null,
    });
    assert.equal((await json(pedir, '/api/movimientos/999/estado', 404)).codigo, 'NO_ENCONTRADO');
    assert.equal((await json(pedir, '/api/movimientos/0/estado', 400)).codigo, 'VALIDACION');
    assert.deepEqual(await cancelar(pedir, anterior.id), { ok: true });
    assert.equal((await json(pedir, rutaAnterior)).estado, 'cancelado');

    const activo = await alta(pedir, rapida);
    assert.match(activo.codigo, /^TRX-\d{4}-002$/);
    assert.equal(activo.modo, 'rapida');
    assert.equal(activo.declaracion, declaraciones.ENTREGA);
    assert.match((await firmar(pedir, anterior.id, firmas, 409)).error, /ya no está activo/);
    assert.deepEqual(await cancelar(pedir, anterior.id), { ok: true });
    assert.equal((await json(pedir, '/api/activo')).id, activo.id);
    assert.match((await firmar(pedir, activo.id, {}, 400)).error, /Falta la firma/);
    assert.match((await firmar(pedir, activo.id, { firmaEmpleado: firma }, 400)).error, /del responsable/);
    assert.match((await firmar(pedir, activo.id, {
      ...firmas, firmaResponsable: 'data:image/jpeg;base64,YQ==',
    }, 400)).error, /PNG/);
    assert.match((await firmar(pedir, activo.id, {
      ...firmas, firmaResponsable: 'data:image/png;base64,YQ==',
    }, 400)).error, /PNG válido/);
    assert.match((await firmar(pedir, activo.id, {
      ...firmas, firmaResponsable: 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'),
    }, 400)).error, /supera el límite/);
    assert.equal((await json(pedir, `/api/movimientos/${activo.id}/firmar`, 413,
      post({ firmaEmpleado: 'a'.repeat(8 * 1024 * 1024) }))).codigo, 'CUERPO_DEMASIADO_GRANDE');
    assert.deepEqual(await fs.readdir(path.join(datos, 'firmas')), []);
    const firmada = await firmar(pedir, activo.id);
    assert.ok(firmada.firmaResponsableUrl);
    assert.equal(firmada.estado, 'firmado');
    assert.equal(await json(pedir, '/api/activo'), null);
    assert.deepEqual(await json(pedir, `/api/movimientos/${activo.id}/estado`), {
      id: activo.id, codigo: activo.codigo, estado: 'firmado', firmado_en: firmada.firmado_en,
    });
    assert.equal((await firmar(pedir, activo.id, firmas, 409)).codigo, 'ESTADO_INCOMPATIBLE');

    const recepcion = await alta(pedir, detallada);
    assert.match(recepcion.codigo, /^TRXD-\d{4}-001$/);
    assert.equal(recepcion.codigo_empleado, detallada.codigoEmpleado);
    assert.equal(recepcion.declaracion, detallada.declaracion);
    assert.deepEqual(recepcion.herramientas.map((h) => h.id), [1, 2, 3]);
    await firmar(pedir, recepcion.id);

    const gestion = { entregaId: recepcion.id, empleado: 'Valor ignorado', modo: 'rapida' };
    assert.match((await json(pedir, '/api/movimientos', 400, post({
      ...gestion, tipo: 'DEVOLUCION', herramientas: [{ id: 1 }, { id: 1 }],
    }))).error, /no está pendiente/);
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
    assert.match((await firmar(pedir, descartado.id, firmas, 409)).error, /ya no está activo/);
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
    for (let i = 0; i < 9; i++) {
      assert.match((await json(pedir, '/entrar', 401, post({ clave: '654321' }))).error, /incorrecto/);
    }
    assert.match((await json(pedir, '/entrar', 429, post({ clave }))).error, /Demasiados intentos/);
  }, clave);
});

test('Fallo al guardar el segundo PNG y reinicio durante la publicación', async (t) => {
  const datos = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-fallo-'));
  t.after(() => fs.rm(datos, { recursive: true, force: true }));
  const imagenes = path.join(datos, 'firmas');
  let pendiente;
  let publicadas;
  await conServidor(datos, async (pedir) => {
    const anterior = await alta(pedir, rapida);
    const firmado = await firmar(pedir, anterior.id);
    publicadas = [firmado.firma_empleado, firmado.firma_responsable].sort();
    pendiente = await alta(pedir, rapida);
    assert.equal((await firmar(pedir, pendiente.id, firmas, 500)).codigo, 'ERROR_GUARDADO');
    assert.deepEqual((await fs.readdir(imagenes)).sort(), publicadas);
    assert.equal((await json(pedir, '/api/activo')).id, pendiente.id);
  }, '', `
    const fs = require('node:fs');
    const escribir = fs.writeFileSync;
    let escrituras = 0;
    fs.writeFileSync = function (ruta, ...args) {
      if (String(ruta).endsWith('.tmp') && ++escrituras === 4) {
        escribir(ruta, Buffer.from('escritura parcial'), { flag: 'wx' });
        throw Object.assign(new Error('Fallo sintético'), { code: 'EIO' });
      }
      return escribir(ruta, ...args);
    };
  `);

  await conServidor(datos, async (pedir) => {
    await assert.rejects(pedir(`/api/movimientos/${pendiente.id}/firmar`, post(firmas)), /fetch failed/);
  }, '', `
    const fs = require('node:fs');
    const renombrar = fs.renameSync;
    fs.renameSync = function (origen, destino) {
      renombrar(origen, destino);
      if (String(origen).endsWith('.tmp')) process.kill(process.pid, 'SIGKILL');
    };
  `);
  const restos = (await fs.readdir(imagenes)).filter((nombre) => !publicadas.includes(nombre));
  assert.equal(restos.length, 2);
  assert.equal(restos.filter((nombre) => nombre.endsWith('.tmp')).length, 1);
  assert.equal(restos.filter((nombre) => nombre.endsWith('.png')).length, 1);
  assert.equal(revisarBase(datos).at(-1).estado, 'esperando');

  await conServidor(datos, async (pedir) => {
    assert.deepEqual((await fs.readdir(imagenes)).sort(), publicadas);
    assert.equal((await json(pedir, `/api/movimientos/${pendiente.id}/estado`)).estado, 'esperando');
    for (const nombre of publicadas) {
      const respuesta = await pedir('/firmas/' + nombre);
      assert.equal(respuesta.status, 200);
      assert.deepEqual(Buffer.from(await respuesta.arrayBuffer()), png);
    }
    assert.equal((await firmar(pedir, pendiente.id)).estado, 'firmado');
  });
});
