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

async function conServidor(datos, ejecutar, clave = '', retirarOperacion = '') {
  // El sistema asigna y reserva el puerto en la misma operación de escucha.
  // Interceptamos listen únicamente en el hijo para limitarlo a loopback.
  const arranque = `
    const { Server } = require('node:http');
    const escuchar = Server.prototype.listen;
    Server.prototype.listen = function () {
      this.once('listening', () => process.send(this.address().port));
      return escuchar.call(this, 0, '127.0.0.1');
    };
    require('./server');
  `;
  const hijo = spawn(process.execPath, ['-e', arranque], {
    cwd: raiz,
    env: { DATA_DIR: datos, CLAVE_ACCESO: clave, RETIRAR_OPERACION_WEB: retirarOperacion, TZ: 'America/Bogota' },
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
  }, clave);
});

test('La operación web continúa hasta activar el corte', async (t) => {
  const datos = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-corte-'));
  t.after(() => fs.rm(datos, { recursive: true, force: true }));
  const paginas = ['/rapida', '/detallada', '/detallada.html', '/firmar', '/firmar.html', '/index.html'];

  await conServidor(datos, async (pedir) => {
    for (const ruta of paginas) assert.equal((await pedir(ruta)).status, 200, ruta);
    assert.equal((await json(pedir, '/api/historial?completo=1')).operacionWeb, true);
    await firmar(pedir, (await alta(pedir, rapida)).id);
  });

  await conServidor(datos, async (pedir) => {
    for (const ruta of [...paginas, '/%66irmar.html', '/%2Fdetallada.html', '/%69ndex.html']) {
      assert.equal((await pedir(ruta)).status, 404, ruta);
    }
    const inicio = await pedir('/', { redirect: 'manual' });
    assert.equal(inicio.status, 302);
    assert.equal(inicio.headers.get('location'), '/registros');
    assert.equal((await pedir('/registros')).status, 200);
    assert.equal((await pedir('/registros.html')).status, 200);
    for (const ruta of ['/api/entregas-pendientes', '/api/declaraciones', '/api/activo', '/api/eventos']) {
      assert.equal((await json(pedir, ruta, 404)).codigo, 'RUTA_RETIRADA');
    }
    for (const cuerpo of [rapida, detallada, { tipo: 'DEVOLUCION' }, { tipo: 'CAMBIO' }]) {
      await json(pedir, '/api/movimientos', 404, post(cuerpo));
    }
    await firmar(pedir, 1, firmas, 404);
    await json(pedir, '/api/movimientos/1/cancelar', 404, post({}));
    const historial = await json(pedir, '/api/historial?completo=1');
    assert.equal(historial.operacionWeb, false);
    assert.equal(historial.grupos.length, 1);
    assert.equal((await json(pedir, '/api/movimientos')).length, 1);
    await comprobarArchivos(pedir, historial.grupos[0].entrega);
  }, '', '1');
});

test('Historial completo y descargas con 1.001 recepciones, devolución y cambio en la más antigua', async (t) => {
  const datos = await fs.mkdtemp(path.join(os.tmpdir(), 'firmas-volumen-'));
  t.after(() => fs.rm(datos, { recursive: true, force: true }));
  await conServidor(datos, async (pedir) => {
    const herramientas = Array.from({ length: 100 }, (_, i) => ({
      descripcion: 'Herramienta sintética ' + (i + 1), estado: 'Bueno', observaciones: 'Nota sintética',
    }));
    const antigua = await alta(pedir, { ...detallada, herramientas });
    await firmar(pedir, antigua.id);

    const base = new Database(path.join(datos, 'firmas.db'));
    try {
      const insertar = base.prepare(`
        INSERT INTO movimientos (codigo, tipo, empleado, herramientas, estado, creado_en, firmado_en)
        VALUES (?, 'ENTREGA', 'Empleado sintético de volumen', ?, 'firmado', ?, ?)
      `);
      base.transaction(() => {
        const fecha = '2020-02-01T13:01:00.000Z';
        for (let i = 1; i <= 1000; i++) {
          insertar.run('TRX-2020-' + i, JSON.stringify([{ id: 1, descripcion: 'Martillo sintético' }]), fecha, fecha);
        }
      })();
    } finally {
      base.close();
    }

    const cambio = await alta(pedir, {
      tipo: 'CAMBIO', entregaId: antigua.id, herramientas: [
        { id: 1, sentido: 'devuelve', estado: 'Bueno' },
        { sentido: 'recibe', descripcion: 'Repuesto sintético', estado: 'Bueno' },
      ],
    });
    await firmar(pedir, cambio.id);
    const devolucion = await alta(pedir, {
      tipo: 'DEVOLUCION', entregaId: antigua.id,
      herramientas: [{ id: 101, estado: 'Bueno' }],
    });
    await firmar(pedir, devolucion.id);

    const historial = await json(pedir, '/api/historial');
    assert.equal(historial.grupos.length, 200);
    assert.ok(!historial.grupos.some((g) => g.entrega.id === antigua.id));
    const completo = await json(pedir, '/api/historial?completo=1');
    assert.equal(completo.grupos.length, 1001);
    const grupo = completo.grupos.at(-1);
    assert.equal(grupo.entrega.id, antigua.id);
    assert.deepEqual(grupo.devoluciones.map((d) => d.codigo), [cambio.codigo, devolucion.codigo]);
    assert.equal(grupo.entrega.herramientas[0].cerradaPor, 'CAMBIO');
    assert.equal(grupo.entrega.herramientas.at(-1).cerradaPor, 'DEVOLUCION');
    assert.equal(grupo.pendientes.length, 99);

    const excel = await pedir('/api/export.xlsx');
    assert.equal(excel.status, 200);
    const libro = new Excel.Workbook();
    await libro.xlsx.load(Buffer.from(await excel.arrayBuffer()));
    const registro = libro.getWorksheet('Registro de Firmas');
    const codigos = registro.getColumn(1).values;
    for (const codigo of [antigua.codigo, cambio.codigo, devolucion.codigo]) {
      assert.ok(codigos.includes(codigo), codigo);
    }
    assert.equal(registro.getImages().length, 6);
    assert.ok(registro.sheetProtection.sheet);
    const informe = libro.getWorksheet('Informe Diario');
    assert.equal(informe.getCell('A5').value, 1001);
    assert.equal(informe.getCell('D5').value, 1099);
    assert.equal(informe.getCell('G5').value, 2);
    assert.ok(informe.getColumn('H').values.some((valor) => String(valor).includes('Repuesto sintético')));

    const pdf = await pedir('/api/entregas/' + antigua.id + '/pdf');
    assert.equal(pdf.status, 200);
    const contenido = Buffer.from(await pdf.arrayBuffer());
    assert.equal(contenido.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await pedir('/api/entregas/99999/pdf')).status, 404);
    assert.equal((contenido.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 5);
  });
});
