'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { FIRMAS_DIR } = require('./db');

const AZUL = 'FF1F4E78';
const AZUL_CLARO = 'FFD9E1F2';
const ROJO = 'FFC00000';
const VERDE = 'FF375623';
const GRIS = 'FFF2F2F2';
const ALTO_FILA = 80;      // puntos
const EMU_POR_PIXEL = 9525;   // la unidad en la que Excel ancla los dibujos

/**
 * Una herramienta en una linea. La nota de la entrega detallada va al final del
 * renglon, que es donde el formulario en papel pone "Observaciones / Notas".
 */
function lineaHerramienta(h) {
  return `${h.cantidad || 1} x ${h.descripcion}` +
    (h.estado ? ` (${h.estado})` : '') +
    (h.observaciones ? ` — ${h.observaciones}` : '');
}

const TIPO_VISIBLE = { ENTREGA: 'RECEPCIÓN', DEVOLUCION: 'DEVOLUCIÓN', CAMBIO: 'CAMBIO' };

/**
 * La celda "Herramientas" de una fila. En un CAMBIO van las dos mitades por
 * separado —lo que devuelve y lo que recibe—, porque leidas en una sola lista no se
 * sabria cual salio y cual entro.
 */
function celdaHerramientas(m) {
  const lista = m.herramientas || [];
  if (m.tipo !== 'CAMBIO') return lista.map(lineaHerramienta).join('\n');
  const mitad = (sentido) => lista.filter((h) => h.sentido === sentido).map(lineaHerramienta).join('; ');
  return `Devuelve: ${mitad('devuelve')}\nRecibe: ${mitad('recibe')}`;
}

/** Dia y hora por separado: el informe los pone en columnas distintas. */
function partes(iso) {
  if (!iso) return { dia: '', hora: '' };
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return {
    dia: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`,
    hora: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

function fecha(iso) {
  const { dia, hora } = partes(iso);
  return dia ? `${dia} ${hora}` : '';
}

/**
 * Genera el registro en el mismo formato de la hoja "Control Diario",
 * con las firmas incrustadas como imagen dentro de la celda.
 */
async function construirLibro(movimientos, grupos = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pantalla de firma de herramientas';
  wb.created = new Date();

  const ws = wb.addWorksheet('Registro de Firmas', {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = [
    { key: 'codigo', width: 16 },
    { key: 'fecha', width: 18 },
    { key: 'tipo', width: 14 },
    { key: 'cierra', width: 16 },
    { key: 'codigoEmpleado', width: 14 },
    { key: 'empleado', width: 26 },
    { key: 'cedula', width: 16 },
    { key: 'departamento', width: 20 },
    { key: 'herramientas', width: 40 },
    { key: 'firmaEmpleado', width: 34 },
    { key: 'responsable', width: 22 },
    { key: 'firmaResponsable', width: 34 },
  ];

  ws.mergeCells('A1:L2');
  const titulo = ws.getCell('A1');
  titulo.value = 'REGISTRO DE RECEPCIÓN Y DEVOLUCIÓN DE HERRAMIENTAS — FIRMAS DIGITALES';
  titulo.font = { bold: true, size: 16, color: { argb: AZUL } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  // Con la hoja protegida toda celda nace bloqueada; se desbloquean para que el
  // registro siga siendo editable y solo las firmas queden fijas.
  titulo.protection = { locked: false };

  const cabeceras = [
    'ID Transacción', 'Fecha / Hora', 'Tipo Movimiento', 'Recepción asociada','Código Empleado',
    'Nombre del Empleado', 'Cédula / ID', 'Departamento', 'Herramientas', 'Firma Empleado',
    'Almacenista', 'Firma Almacenista',
  ];
  const filaCab = ws.getRow(4);
  filaCab.values = cabeceras;
  filaCab.height = 34;
  filaCab.eachCell((celda) => {
    celda.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
    celda.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    celda.border = { top: { style: 'medium' }, bottom: { style: 'medium' }, left: { style: 'medium' }, right: { style: 'medium' } };
    celda.protection = { locked: false };
  });

  // Por clave y no por numero: las firmas se anclan a una columna concreta, y una
  // columna nueva en medio las dejaba encima de la celda de al lado.
  const colFirmaEmpleado = ws.getColumn('firmaEmpleado').number;
  const colFirmaResponsable = ws.getColumn('firmaResponsable').number;

  let n = 5;
  for (const m of movimientos) {
    const fila = ws.getRow(n);
    // Alta a proposito: la firma conserva su proporcion, asi que con una fila baja
    // el alto manda y sobra ancho en la celda. Con 80 la firma lo llena casi entero.
    fila.height = ALTO_FILA;
    fila.values = {
      codigo: m.codigo,
      fecha: fecha(m.firmado_en || m.creado_en),
      tipo: TIPO_VISIBLE[m.tipo] || 'RECEPCIÓN',
      cierra: m.entregaCodigo || '',
      codigoEmpleado: m.codigo_empleado || '',
      empleado: m.empleado,
      cedula: m.cedula,
      departamento: m.departamento,
      herramientas: celdaHerramientas(m),
      firmaEmpleado: '',
      responsable: m.responsable,
      firmaResponsable: '',
    };
    fila.eachCell({ includeEmpty: true }, (celda) => {
      celda.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      celda.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      celda.protection = { locked: false };
    });
    for (const col of [colFirmaEmpleado, colFirmaResponsable]) {
      fila.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } };
    }

    incrustarFirma(wb, ws, m.firma_empleado, colFirmaEmpleado - 1, n - 1, ALTO_FILA);
    incrustarFirma(wb, ws, m.firma_responsable, colFirmaResponsable - 1, n - 1, ALTO_FILA);
    n += 1;
  }

  ws.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: Math.max(4, n - 1), column: cabeceras.length },
  };

  await blindarFirmas(ws);

  agregarInformeDiario(wb, grupos);
  return wb;
}

// ------------------------------------------------------------ informe diario

/**
 * Las dos listas del informe, una linea por herramienta y no por movimiento.
 *
 * Lo pendiente no se lee de ningun campo: `historial()` ya marco cada herramienta
 * con la devolucion que la cerro, y aqui solo se reparte. Mantenerlo asi es lo que
 * evita la columna "devuelta" que el resto del proyecto se niega a guardar.
 *
 * Solo entran las recepciones firmadas: una que sigue esperando en la tablet no ha
 * sacado nada del almacen y contarla como pendiente seria mentir.
 *
 * Los CAMBIOS no son una fila aparte: `historial()` ya los dejo dentro del universo
 * de la recepcion. La herramienta que sale en un cambio cae en "devueltas" como una
 * devuelta mas, con la fecha del cambio (decision cerrada: sin marca especial), y
 * la que entra sale a la calle cuando se firmo el cambio, no cuando la recepcion,
 * asi que su fecha y hora de salida son las de `llegoFecha`.
 */
function listasDelInforme(grupos) {
  const pendientes = [];
  const devueltas = [];

  for (const g of grupos) {
    const e = g.entrega;
    if (e.estado !== 'firmado') continue;

    const recepcion = partes(e.firmado_en || e.creado_en);
    for (const h of e.herramientas) {
      const salida = h.llegoFecha ? partes(h.llegoFecha) : recepcion;
      const linea = lineaHerramienta(h);
      if (h.devuelta) {
        devueltas.push([salida.dia, e.empleado, linea, fecha(h.devueltaFecha)]);
      } else {
        pendientes.push([salida.dia, e.empleado, linea, salida.hora]);
      }
    }
  }

  return { pendientes, devueltas };
}

/**
 * Segunda hoja del libro, calcada de la hoja "Informe Diario" del formulario
 * `Formulario_Control_Herramientas_Compatible.xlsx`: tres contadores arriba y dos
 * bloques enfrentados, lo que sigue fuera a la izquierda y lo que ya regreso a la
 * derecha.
 *
 * Alli son formulas porque la hoja de al lado se llena a mano; aqui van valores.
 * La base ya sabe la respuesta, y una formula escrita desde el servidor tendria
 * ademas el problema del idioma: Excel en espanol no entiende los nombres de
 * funcion en ingles que openpyxl deja pasar.
 *
 * Sin proteger, al reves que la hoja de firmas: aqui no hay ninguna imagen que
 * se pueda arrastrar a la fila de otra persona.
 */
function agregarInformeDiario(wb, grupos) {
  const { pendientes, devueltas } = listasDelInforme(grupos || []);
  const recepciones = (grupos || []).filter((g) => g.entrega.estado === 'firmado').length;

  const ws = wb.addWorksheet('Informe Diario', {
    views: [{ state: 'frozen', ySplit: 9 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // La columna E es el canal entre los dos bloques, no una columna de datos.
  [12, 26, 34, 14, 4, 12, 26, 34, 18].forEach((ancho, i) => {
    ws.getColumn(i + 1).width = ancho;
  });

  ws.mergeCells('A1:I2');
  const titulo = ws.getCell('A1');
  titulo.value = 'INFORME DETALLADO Y RESUMEN DE CONTROL DE HERRAMIENTAS';
  titulo.font = { bold: true, size: 16, color: { argb: AZUL } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };

  // -------------------------------------------------------------- contadores
  const tarjetas = [
    ['A4:C4', 'A5:C5', 'Total de Recepciones', recepciones, AZUL],
    ['D4:F4', 'D5:F5', 'Pendientes de Devolución', pendientes.length, ROJO],
    ['G4:I4', 'G5:I5', 'Herramientas Devueltas', devueltas.length, VERDE],
  ];
  for (const [rangoRotulo, rangoCifra, rotulo, cifra, color] of tarjetas) {
    ws.mergeCells(rangoRotulo);
    const r = ws.getCell(rangoRotulo.split(':')[0]);
    r.value = rotulo;
    r.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
    r.alignment = { horizontal: 'center', vertical: 'middle' };
    r.border = marco('thin');

    ws.mergeCells(rangoCifra);
    const c = ws.getCell(rangoCifra.split(':')[0]);
    c.value = cifra;
    c.font = { bold: true, size: 16, color: { argb: color } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_CLARO } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = marco('thin');
  }
  ws.getRow(4).height = 20;
  ws.getRow(5).height = 28;

  // ----------------------------------------------------------- los dos bloques
  bloque(ws, 'A', 'D', ROJO,
    '⚠️ EMPLEADOS CON HERRAMIENTAS PENDIENTES (NO DEVOLVIERON)',
    ['Fecha', 'Empleado', 'Herramienta', 'Hora salida'],
    pendientes, 'Ninguna herramienta pendiente de devolución.');

  bloque(ws, 'F', 'I', VERDE,
    '✅ EMPLEADOS QUE YA DEVOLVIERON LA HERRAMIENTA',
    ['Fecha', 'Empleado', 'Herramienta', 'Devuelta el'],
    devueltas, 'Todavía no hay devoluciones firmadas.');

  return ws;
}

/** Un bloque del informe: rotulo en la fila 8, cabecera en la 9 y datos desde la 10. */
function bloque(ws, colIni, colFin, color, rotulo, cabeceras, filas, vacio) {
  ws.mergeCells(`${colIni}8:${colFin}8`);
  const r = ws.getCell(`${colIni}8`);
  r.value = rotulo;
  r.font = { bold: true, size: 11, color: { argb: color } };
  r.alignment = { horizontal: 'left', vertical: 'middle' };

  const desde = ws.getColumn(colIni).number;
  const filaCab = ws.getRow(9);
  cabeceras.forEach((texto, i) => {
    const celda = filaCab.getCell(desde + i);
    celda.value = texto;
    celda.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    celda.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    celda.border = marco('thin');
  });
  filaCab.height = 26;

  if (filas.length === 0) {
    ws.mergeCells(`${colIni}10:${colFin}10`);
    const celda = ws.getCell(`${colIni}10`);
    celda.value = vacio;
    celda.font = { italic: true, size: 10, color: { argb: 'FF808080' } };
    celda.alignment = { horizontal: 'center', vertical: 'middle' };
    celda.border = marco('thin');
    return;
  }

  filas.forEach((valores, i) => {
    const fila = ws.getRow(10 + i);
    valores.forEach((valor, j) => {
      const celda = fila.getCell(desde + j);
      celda.value = valor;
      celda.alignment = { horizontal: j === 1 || j === 2 ? 'left' : 'center', vertical: 'middle', wrapText: true };
      celda.border = marco('thin');
    });
  });
}

function marco(estilo) {
  return { top: { style: estilo }, bottom: { style: estilo }, left: { style: estilo }, right: { style: estilo } };
}

/**
 * Ancho y alto de un PNG, leidos de su cabecera IHDR.
 *
 * Son los bytes 16 a 24: 8 de firma PNG, 4 de longitud, 4 del nombre del trozo y
 * ahi vienen los dos enteros. Basta para saber la proporcion de la firma sin
 * decodificar la imagen ni anadir una dependencia.
 */
function tamanoPng(ruta) {
  const cabecera = Buffer.alloc(24);
  const fd = fs.openSync(ruta, 'r');
  try {
    if (fs.readSync(fd, cabecera, 0, 24, 0) < 24) return null;
  } finally {
    fs.closeSync(fd);
  }
  if (cabecera.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { ancho: cabecera.readUInt32BE(16), alto: cabecera.readUInt32BE(20) };
}

/** Ancho de columna de Excel (en caracteres) a pixeles, con la fuente por defecto. */
function anchoAPixeles(caracteres) {
  return Math.round((caracteres || 10) * 7) + 5;
}

/**
 * Coloca la firma ocupando la celda entera, sin deformarla.
 *
 * **No uses `tl: { col: 8.05 }`.** La forma fraccionaria de ExcelJS parece la
 * natural y esta rota para este uso: en `lib/doc/anchor.js` el ancho de columna
 * vale `width * 10000`, o sea 340.000 para una columna de 34, cuando esa columna
 * mide de verdad unos 2.310.000 EMU. El desplazamiento se escribe tal cual en el
 * XML, asi que "el 90% de la celda" acababa siendo 34 px dentro de una celda de
 * 243: por eso la firma salia estrechisima. Aqui se pasan los EMU ya calculados
 * con `nativeColOff` / `nativeRowOff`, que el constructor de `Anchor` respeta.
 *
 * El rango no es la celda entera sino el rectangulo centrado con la misma
 * proporcion que la imagen. Asi `editAs: 'twoCell'` ata la firma a sus dos
 * esquinas —acompana a la celda si cambia de tamano y no se queda flotando— sin
 * que estirarla hasta la caja la achate.
 *
 * El PNG llega ya recortado al trazo desde la tablet (`firma-canvas.js`); si
 * llegara el lienzo entero, la firma volveria a ser un garabato pequeno rodeado
 * de transparencia por mucho que el anclaje sea correcto.
 */
function incrustarFirma(wb, ws, archivo, colBase0, filaBase0, altoFilaPt) {
  if (!archivo) return;
  const ruta = path.join(FIRMAS_DIR, archivo);
  if (!fs.existsSync(ruta)) return;

  const anchoCelda = anchoAPixeles(ws.getColumn(colBase0 + 1).width);
  const altoCelda = (altoFilaPt * 4) / 3;                    // puntos a pixeles

  // Margen minimo: la queja era justamente que la firma quedaba corta de ancho.
  let ancho = anchoCelda * 0.96;
  let alto = altoCelda * 0.90;

  const tam = tamanoPng(ruta);
  if (tam && tam.ancho && tam.alto) {
    const escala = Math.min(ancho / tam.ancho, alto / tam.alto);
    ancho = tam.ancho * escala;
    alto = tam.alto * escala;
  }

  const sobraX = (anchoCelda - ancho) / 2;
  const sobraY = (altoCelda - alto) / 2;
  const emu = (px) => Math.round(px * EMU_POR_PIXEL);

  const id = wb.addImage({ filename: ruta, extension: 'png' });
  ws.addImage(id, {
    tl: {
      nativeCol: colBase0, nativeColOff: emu(sobraX),
      nativeRow: filaBase0, nativeRowOff: emu(sobraY),
    },
    br: {
      nativeCol: colBase0, nativeColOff: emu(sobraX + ancho),
      nativeRow: filaBase0, nativeRowOff: emu(sobraY + alto),
    },
    editAs: 'twoCell',
  });
}

/**
 * Deja las firmas donde estan.
 *
 * Una imagen en Excel es un objeto flotante: por defecto se arrastra fuera de su
 * celda con el raton, y una firma movida de fila es una firma atribuida a otra
 * persona. Excel solo respeta el bloqueo de objetos si la hoja esta protegida, asi
 * que hay que hacer las dos cosas.
 *
 * Ojo con la semantica de ExcelJS: sus banderas dicen que esta *permitido*, y el
 * XML dice lo contrario. `objects: false` es lo que escribe `objects="1"`, que es
 * el atributo que bloquea los dibujos. Todo lo demas se deja permitido, y las
 * celdas van desbloqueadas una a una, para que la hoja siga siendo una hoja de
 * calculo normal: se puede escribir, ordenar, filtrar e imprimir.
 *
 * Esto no contradice la regla de los .xlsx de la raiz. Alli no se puede proteger
 * la hoja porque eso desactiva la pestana *Dibujar* y no se podria firmar; aqui la
 * firma ya viene hecha y lo unico que hace falta es que no se mueva.
 */
async function blindarFirmas(ws) {
  await ws.protect(undefined, {
    objects: false,             // <- unico bloqueo: los dibujos no se tocan
    scenarios: false,
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    insertRows: true,
    insertColumns: true,
    insertHyperlinks: true,
    deleteRows: true,
    deleteColumns: true,
    sort: true,
    autoFilter: true,
    pivotTables: true,
  });
}

module.exports = { construirLibro };
