'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FIRMAS_DIR = path.join(DATA_DIR, 'firmas');

fs.mkdirSync(FIRMAS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'firmas.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS movimientos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo             TEXT    NOT NULL,
    tipo               TEXT    NOT NULL,              -- ENTREGA | DEVOLUCION
    empleado           TEXT    NOT NULL,
    cedula             TEXT    NOT NULL DEFAULT '',
    departamento       TEXT    NOT NULL DEFAULT '',
    responsable        TEXT    NOT NULL DEFAULT '',
    herramientas       TEXT    NOT NULL DEFAULT '[]', -- JSON
    observaciones      TEXT    NOT NULL DEFAULT '',
    estado             TEXT    NOT NULL DEFAULT 'esperando', -- esperando | firmado | cancelado
    firma_empleado     TEXT,
    firma_responsable  TEXT,
    creado_en          TEXT    NOT NULL,
    firmado_en         TEXT,
    entrega_id         INTEGER REFERENCES movimientos(id), -- solo en DEVOLUCION
    codigo_empleado    TEXT    NOT NULL DEFAULT '',        -- ficha del empleado (EMP-042)
    declaracion        TEXT    NOT NULL DEFAULT '',        -- texto que firma; vacio = el de siempre
    modo               TEXT    NOT NULL DEFAULT 'rapida'   -- rapida | detallada, la pantalla que lo armo
  );
  CREATE INDEX IF NOT EXISTS idx_estado ON movimientos(estado);
`);

// Sobre una base que ya existe el CREATE TABLE de arriba no hace nada, asi que cada
// columna anadida despues hay que traerla con su ALTER. `entrega_id` llego con las
// devoluciones atadas; `codigo_empleado`, `declaracion` y `modo`, con la detallada.
// El `DEFAULT 'rapida'` de `modo` es lo que deja el historico anterior entero en la
// lista correcta: todo lo de antes se armo en la pantalla rapida, que era la unica.
const columnas = db.prepare(`PRAGMA table_info(movimientos)`).all().map((c) => c.name);
for (const [columna, tipo] of [
  ['entrega_id', 'INTEGER REFERENCES movimientos(id)'],
  ['codigo_empleado', "TEXT NOT NULL DEFAULT ''"],
  ['declaracion', "TEXT NOT NULL DEFAULT ''"],
  ['modo', "TEXT NOT NULL DEFAULT 'rapida'"],
]) {
  if (!columnas.includes(columna)) {
    db.exec(`ALTER TABLE movimientos ADD COLUMN ${columna} ${tipo}`);
  }
}

// El indice va despues de la migracion: sobre una base antigua, crearlo junto al
// CREATE TABLE fallaria porque la columna todavia no existe.
db.exec(`CREATE INDEX IF NOT EXISTS idx_entrega ON movimientos(entrega_id)`);

// Las entregas guardadas antes de este cambio tienen las herramientas sin numerar, y
// sin id no hay forma de saber cual volvio. Se numeran una sola vez, respetando el
// orden en que quedaron guardadas.
{
  const sinNumerar = db
    .prepare(`SELECT id, herramientas FROM movimientos WHERE tipo = 'ENTREGA'`)
    .all()
    .map((f) => ({ id: f.id, herramientas: JSON.parse(f.herramientas || '[]') }))
    .filter((f) => f.herramientas.some((h) => h.id === undefined || h.id === null));

  if (sinNumerar.length) {
    const actualizar = db.prepare(`UPDATE movimientos SET herramientas = ? WHERE id = ?`);
    const tx = db.transaction((filas) => {
      for (const f of filas) {
        const numeradas = f.herramientas.map((h, i) => ({ ...h, id: h.id != null ? h.id : i + 1 }));
        actualizar.run(JSON.stringify(numeradas), f.id);
      }
    });
    tx(sinNumerar);
    console.log(`Migracion: numeradas las herramientas de ${sinNumerar.length} entrega(s) antigua(s).`);
  }
}

// ---------------------------------------------------------------- utilidades

/**
 * Lo que firma el empleado, por tipo de movimiento.
 *
 * Vive en la capa de datos y no en la pantalla porque lo leen tres sitios: la
 * tablet, el comprobante en PDF y la entrega detallada, que deja reescribirlo. Tres
 * copias de un texto que compromete a alguien se desincronizan en la primera
 * corrección, y la que quedaría vieja es justo la del papel que se archiva.
 *
 * En la base solo se guarda lo que el almacenista escribió: si dejó la casilla en
 * blanco, la fila queda vacía y `normalizar` pone el de aquí. Así una corrección de
 * redacción alcanza también a los movimientos ya firmados con el texto de siempre.
 */
/** Cada pantalla numera en su propia serie: el codigo dice de que tipo es el registro. */
const PREFIJO = { rapida: 'TRX', detallada: 'TRXD' };

const DECLARACIONES = {
  ENTREGA: 'Declaro haber recibido las herramientas relacionadas en el estado de conservación indicado y me comprometo a su uso adecuado, cuidado y devolución oportuna.',
  DEVOLUCION: 'Declaro haber devuelto las herramientas relacionadas en el estado de conservación indicado.',
};

function ahora() {
  return new Date().toISOString();
}

/**
 * El correlativo del ano, con una serie por modo.
 *
 * `TRX-2026-014` sale de la pantalla rapida y `TRXD-2026-003` de la detallada, asi
 * que el codigo dice a que lista pertenece un registro sin tener que abrirlo. Los dos
 * patrones son ajenos para el `LIKE` —tras "TRX" viene "-" en uno y "D" en el otro—,
 * de modo que cada serie cuenta solo los suyos y ninguna arrastra a la otra.
 *
 * Lo pone siempre el servidor. La pantalla detallada llego a dejarlo escribir a mano
 * y se quito: obligaba a defender la unicidad de una columna que no es UNIQUE, y el
 * numero que toca no se lo sabe nadie de memoria.
 */
function siguienteCodigo(modo) {
  const anio = new Date().getFullYear();
  const raiz = `${PREFIJO[modo] || PREFIJO.rapida}-${anio}-`;
  const fila = db
    .prepare(`SELECT COUNT(*) AS n FROM movimientos WHERE codigo LIKE ?`)
    .get(`${raiz}%`);
  return raiz + String(fila.n + 1).padStart(3, '0');
}

function normalizar(fila) {
  if (!fila) return null;
  return {
    ...fila,
    herramientas: JSON.parse(fila.herramientas || '[]'),
    firmaEmpleadoUrl: fila.firma_empleado ? `/firmas/${fila.firma_empleado}` : null,
    firmaResponsableUrl: fila.firma_responsable ? `/firmas/${fila.firma_responsable}` : null,
    entregaCodigo: fila.entrega_id ? codigoDe(fila.entrega_id) : null,
    declaracion: fila.declaracion || DECLARACIONES[fila.tipo] || '',
  };
}

/** Codigo legible de la entrega que cierra una devolucion. */
function codigoDe(id) {
  const fila = db.prepare(`SELECT codigo FROM movimientos WHERE id = ?`).get(id);
  return fila ? fila.codigo : null;
}

/**
 * Herramientas de una entrega que todavia no han vuelto.
 *
 * No se guarda un campo "devuelta" en la entrega: se calcula a partir de las
 * devoluciones firmadas que la referencian. Asi no hay dos versiones de la verdad
 * que se puedan desincronizar, y las devoluciones parciales salen solas.
 */
function pendientesDe(entrega, devoluciones) {
  const devueltas = new Set();
  for (const d of devoluciones) {
    for (const h of d.herramientas) devueltas.add(h.id);
  }
  return entrega.herramientas.filter((h) => !devueltas.has(h.id));
}

/** Entregas firmadas a las que les falta devolver al menos una herramienta. */
function entregasPendientes() {
  const entregas = db
    .prepare(`SELECT * FROM movimientos WHERE tipo = 'ENTREGA' AND estado = 'firmado' ORDER BY id DESC`)
    .all()
    .map(normalizar);
  if (entregas.length === 0) return [];

  const devoluciones = db
    .prepare(`SELECT * FROM movimientos WHERE tipo = 'DEVOLUCION' AND estado = 'firmado' AND entrega_id IS NOT NULL`)
    .all()
    .map(normalizar);

  const porEntrega = new Map();
  for (const d of devoluciones) {
    if (!porEntrega.has(d.entrega_id)) porEntrega.set(d.entrega_id, []);
    porEntrega.get(d.entrega_id).push(d);
  }

  return entregas
    .map((e) => ({ ...e, pendientes: pendientesDe(e, porEntrega.get(e.id) || []) }))
    .filter((e) => e.pendientes.length > 0);
}

/**
 * El historico agrupado: cada entrega con las devoluciones que la cierran.
 *
 * Se arma al vuelo, como pendientesDe. Guardar el vinculo ya resuelto en una
 * columna seria la misma trampa que un campo "devuelta": dos versiones de la
 * verdad que se separan en cuanto una devolucion se cancela antes de firmarse.
 *
 * Cada herramienta de la entrega sale marcada con la devolucion que la cerro, de
 * modo que la pantalla no tiene que cruzar nada por su cuenta.
 */
function historial(limite = 200) {
  const entregas = db
    .prepare(`SELECT * FROM movimientos WHERE tipo = 'ENTREGA' AND estado <> 'cancelado' ORDER BY id DESC LIMIT ?`)
    .all(limite)
    .map(normalizar);

  const devoluciones = db
    .prepare(`SELECT * FROM movimientos WHERE tipo = 'DEVOLUCION' AND estado <> 'cancelado' ORDER BY id`)
    .all()
    .map(normalizar);

  const porEntrega = new Map();
  const sueltas = [];   // devoluciones de bases antiguas, sin entrega a la que colgar
  for (const d of devoluciones) {
    if (d.entrega_id == null) {
      sueltas.push(d);
      continue;
    }
    if (!porEntrega.has(d.entrega_id)) porEntrega.set(d.entrega_id, []);
    porEntrega.get(d.entrega_id).push(d);
  }

  const grupos = entregas.map((e) => {
    const suyas = porEntrega.get(e.id) || [];
    // Solo las firmadas cierran herramientas: una devolucion todavia en la tablet
    // no ha devuelto nada aunque ya este creada.
    const firmadas = suyas.filter((d) => d.estado === 'firmado');

    const cerradaPor = new Map();
    for (const d of firmadas) {
      for (const h of d.herramientas) cerradaPor.set(h.id, d);
    }

    const herramientas = e.herramientas.map((h) => {
      const d = cerradaPor.get(h.id);
      return {
        ...h,
        devuelta: !!d,
        devueltaEn: d ? d.codigo : null,
        devueltaFecha: d ? d.firmado_en : null,
      };
    });

    const pendientes = herramientas.filter((h) => !h.devuelta);
    const ciclo =
      e.estado !== 'firmado' ? 'esperando'
        : pendientes.length === 0 ? 'completa'
          : pendientes.length === herramientas.length ? 'sin-devolver'
            : 'parcial';

    return { entrega: { ...e, herramientas }, devoluciones: suyas, pendientes, ciclo };
  });

  return { grupos, sueltas };
}

// ---------------------------------------------------------------- operaciones

/**
 * Prepara un movimiento antes de guardarlo.
 *
 * En una ENTREGA se numeran las herramientas: ese id es lo que despues permite saber
 * cual volvio y cual no. En una DEVOLUCION se comprueba que lo que se devuelve
 * pertenece de verdad a la entrega y sigue pendiente, para que no se pueda cerrar dos
 * veces la misma herramienta ni devolver algo que nunca se entrego.
 */
function prepararMovimiento(d) {
  if (d.tipo === 'ENTREGA') {
    const herramientas = (d.herramientas || []).map((h, i) => ({
      id: i + 1,
      descripcion: String(h.descripcion || '').trim(),
      cantidad: String(h.cantidad || '1'),
      estado: h.estado || '',
      observaciones: String(h.observaciones || '').trim(),
    }));

    // `modo` decide en que lista de /registros cae y de que serie sale el codigo.
    // Se normaliza aqui y no se confia en el cuerpo: cualquier otro valor es 'rapida'.
    // Los otros dos campos solo los llena la pantalla detallada; en la rapida van
    // vacios y nada los necesita.
    return {
      ...d,
      modo: d.modo === 'detallada' ? 'detallada' : 'rapida',
      codigoEmpleado: String(d.codigoEmpleado || '').trim(),
      declaracion: String(d.declaracion || '').trim(),
      herramientas,
      entregaId: null,
    };
  }

  // DEVOLUCION
  const entrega = obtener(Number(d.entregaId));
  if (!entrega) throw new Error('Seleccione la recepción que se está devolviendo');
  if (entrega.tipo !== 'ENTREGA' || entrega.estado !== 'firmado') {
    throw new Error('El movimiento indicado no es una recepción firmada');
  }

  const devoluciones = db
    .prepare(`SELECT * FROM movimientos WHERE tipo = 'DEVOLUCION' AND estado = 'firmado' AND entrega_id = ?`)
    .all(entrega.id)
    .map(normalizar);
  const pendientes = pendientesDe(entrega, devoluciones);
  const porId = new Map(pendientes.map((h) => [h.id, h]));

  const herramientas = (d.herramientas || []).map((h) => {
    const original = porId.get(Number(h.id));
    if (!original) {
      throw new Error(`La herramienta "${h.descripcion || h.id}" no está pendiente en ${entrega.codigo}`);
    }
    return {
      id: original.id,
      descripcion: original.descripcion,
      cantidad: original.cantidad,
      estado: h.estado || original.estado,        // condicion con la que regresa
      observaciones: h.observaciones || '',
    };
  });
  if (herramientas.length === 0) throw new Error('Marque al menos una herramienta a devolver');

  // Los datos del empleado salen de la entrega: no se reescriben a mano. El `modo`
  // tambien, y por eso una devolucion aparece siempre en la misma lista que la
  // recepcion que cierra: separarlas dejaria media pareja en cada pestana.
  return {
    ...d,
    modo: entrega.modo || 'rapida',
    empleado: entrega.empleado,
    cedula: entrega.cedula,
    departamento: entrega.departamento,
    codigoEmpleado: entrega.codigo_empleado || '',
    declaracion: '',
    herramientas,
    entregaId: entrega.id,
  };
}

/** Crea el movimiento y lo deja en pantalla de la tablet. Solo puede haber uno esperando. */
function crearYActivar(entrada) {
  const datos = prepararMovimiento(entrada);
  const tx = db.transaction((d) => {
    db.prepare(`UPDATE movimientos SET estado = 'cancelado' WHERE estado = 'esperando'`).run();
    const info = db
      .prepare(
        `INSERT INTO movimientos
           (codigo, tipo, modo, empleado, cedula, departamento, codigo_empleado, responsable, herramientas, observaciones, declaracion, entrega_id, estado, creado_en)
         VALUES (@codigo, @tipo, @modo, @empleado, @cedula, @departamento, @codigo_empleado, @responsable, @herramientas, @observaciones, @declaracion, @entrega_id, 'esperando', @creado_en)`
      )
      .run({
        codigo: siguienteCodigo(d.modo),
        tipo: d.tipo,
        modo: d.modo || 'rapida',
        empleado: d.empleado,
        cedula: d.cedula || '',
        departamento: d.departamento || '',
        codigo_empleado: d.codigoEmpleado || '',
        responsable: d.responsable || '',
        herramientas: JSON.stringify(d.herramientas || []),
        observaciones: d.observaciones || '',
        declaracion: d.declaracion || '',
        entrega_id: d.entregaId || null,
        creado_en: ahora(),
      });
    return info.lastInsertRowid;
  });
  return obtener(tx(datos));
}

function obtener(id) {
  return normalizar(db.prepare(`SELECT * FROM movimientos WHERE id = ?`).get(id));
}

function activo() {
  return normalizar(
    db.prepare(`SELECT * FROM movimientos WHERE estado = 'esperando' ORDER BY id DESC LIMIT 1`).get()
  );
}

function listar(limite = 200) {
  return db
    .prepare(`SELECT * FROM movimientos WHERE estado <> 'cancelado' ORDER BY id DESC LIMIT ?`)
    .all(limite)
    .map(normalizar);
}

/** Guarda un data URL PNG en disco y devuelve el nombre de archivo. */
function guardarFirma(id, quien, dataUrl) {
  const base64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
  if (!base64) throw new Error('Firma vacia');
  const nombre = `${id}-${quien}.png`;
  fs.writeFileSync(path.join(FIRMAS_DIR, nombre), Buffer.from(base64, 'base64'));
  return nombre;
}

function firmar(id, firmaEmpleado, firmaResponsable) {
  const mov = obtener(id);
  if (!mov) throw new Error('Movimiento no encontrado');
  if (mov.estado === 'firmado') throw new Error('Este movimiento ya fue firmado');

  const archivoEmpleado = guardarFirma(id, 'empleado', firmaEmpleado);
  const archivoResponsable = firmaResponsable ? guardarFirma(id, 'responsable', firmaResponsable) : null;

  db.prepare(
    `UPDATE movimientos
        SET firma_empleado = ?, firma_responsable = ?, estado = 'firmado', firmado_en = ?
      WHERE id = ?`
  ).run(archivoEmpleado, archivoResponsable, ahora(), id);

  return obtener(id);
}

function cancelar(id) {
  db.prepare(`UPDATE movimientos SET estado = 'cancelado' WHERE id = ? AND estado = 'esperando'`).run(id);
}

module.exports = {
  db, DATA_DIR, FIRMAS_DIR, DECLARACIONES,
  crearYActivar, obtener, activo, listar, firmar, cancelar,
  entregasPendientes, historial,
};
