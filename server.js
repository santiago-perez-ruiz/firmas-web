'use strict';

const path = require('path');
const express = require('express');
const store = require('./src/db');
const auth = require('./src/auth');
const { construirLibro } = require('./src/excel');
const { construirPdf } = require('./src/pdf');

const app = express();
const PUERTO = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '8mb' }));      // las firmas viajan como data URL PNG

// La puerta va antes que los estaticos: si no, /firmar y el CSS se servirian sin pasar por ella.
auth.instalar(app);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/firmas', express.static(store.FIRMAS_DIR));

// ------------------------------------------------------- avisos en vivo (SSE)
const clientes = new Set();

function avisar(evento, datos) {
  const carga = `event: ${evento}\ndata: ${JSON.stringify(datos ?? null)}\n\n`;
  for (const res of clientes) res.write(carga);
}

app.get('/api/eventos', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Relleno inicial: algunos proxies (Cloudflare entre ellos) retienen la respuesta
  // hasta juntar unos kilobytes. Estos bytes de comentario la empujan fuera.
  res.write(':' + ' '.repeat(2048) + '\n\n');
  res.write('retry: 3000\n\n');
  clientes.add(res);

  // El latido es un evento con nombre y no un comentario: EventSource descarta los
  // comentarios, y el cliente necesita ver senales para distinguir un flujo vivo de
  // uno que se quedo atascado en un proxy.
  const latir = () => res.write('event: latido\ndata: {}\n\n');
  latir();
  const latido = setInterval(latir, 8000);
  req.on('close', () => {
    clearInterval(latido);
    clientes.delete(res);
    res.end();
  });
});

// ------------------------------------------------------------------- API
function manejar(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  };
}

app.get('/api/activo', (req, res) => res.json(store.activo()));

app.get('/api/movimientos', (req, res) => res.json(store.listar()));

// Lo mismo, pero cada entrega con las devoluciones que la cierran. Es lo que pinta
// /registros; /api/movimientos sigue plano porque de ahi sale el Excel.
app.get('/api/historial', (req, res) => res.json(store.historial()));

// Entregas firmadas con herramientas sin devolver: es la lista de la que se elige
// al registrar una devolucion.
app.get('/api/entregas-pendientes', (req, res) => res.json(store.entregasPendientes()));

app.post(
  '/api/movimientos',
  manejar((req, res) => {
    const { tipo } = req.body || {};
    if (!['ENTREGA', 'DEVOLUCION', 'CAMBIO'].includes(tipo)) {
      throw new Error('Tipo debe ser ENTREGA, DEVOLUCION o CAMBIO');
    }

    let herramientas = req.body.herramientas || [];
    if (!Array.isArray(herramientas)) throw new Error('La lista de herramientas no es válida');
    if (tipo === 'ENTREGA') {
      // En una entrega los datos se escriben a mano; en una devolucion o un cambio
      // salen de la entrega elegida, y de validarlos se encarga la capa de datos.
      if (!req.body.empleado || !String(req.body.empleado).trim()) {
        throw new Error('Falta el nombre del empleado');
      }
      herramientas = herramientas.filter((h) => h && String(h.descripcion || '').trim());
      if (herramientas.length === 0) throw new Error('Agregue al menos una herramienta');
    }

    const mov = store.crearYActivar({ ...req.body, herramientas });
    avisar('activo', mov);
    res.status(201).json(mov);
  })
);

app.post(
  '/api/movimientos/:id/firmar',
  manejar((req, res) => {
    const { firmaEmpleado, firmaResponsable } = req.body || {};
    if (!firmaEmpleado) throw new Error('Falta la firma del empleado');
    const mov = store.firmar(Number(req.params.id), firmaEmpleado, firmaResponsable || null);
    avisar('firmado', mov);
    avisar('activo', null);
    res.json(mov);
  })
);

app.post(
  '/api/movimientos/:id/cancelar',
  manejar((req, res) => {
    store.cancelar(Number(req.params.id));
    avisar('activo', null);
    res.json({ ok: true });
  })
);

// Comprobante de un solo registro: la entrega con sus devoluciones. El Excel sigue
// siendo la salida del histórico completo.
app.get(
  '/api/entregas/:id/pdf',
  manejar((req, res) => {
    const id = Number(req.params.id);
    const grupo = store.historial(1000).grupos.find((g) => g.entrega.id === id);
    if (!grupo) throw new Error('No existe ese registro');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${grupo.entrega.codigo}.pdf"`);
    construirPdf(grupo, res);
  })
);

app.get(
  '/api/export.xlsx',
  manejar(async (req, res) => {
    // Dos vistas del mismo historico: la lista plana llena la hoja de firmas y los
    // grupos, la del informe, que necesita saber que herramienta volvio y cual no.
    const firmados = store.listar(1000).filter((m) => m.estado === 'firmado').reverse();
    const libro = await construirLibro(firmados, store.historial(1000).grupos);
    const hoy = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Registro_Firmas_${hoy}.xlsx"`);
    await libro.xlsx.write(res);
    res.end();
  })
);

// El texto por defecto, para que la entrega detallada pueda partir de el en vez de
// llevar una copia escrita en el HTML.
app.get('/api/declaraciones', (req, res) => res.json(store.DECLARACIONES));

app.get('/api/salud', (req, res) => res.json({ ok: true, conectados: clientes.size }));

app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`Pantalla de firma escuchando en http://0.0.0.0:${PUERTO}`);
  console.log(`  Operador : http://localhost:${PUERTO}/`);
  console.log(`  Tablet   : http://localhost:${PUERTO}/firmar`);
});
