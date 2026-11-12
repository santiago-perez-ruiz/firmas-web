'use strict';

/**
 * Comprobante en PDF de un registro: la recepción y las devoluciones y cambios que
 * la cierran.
 *
 * Es el equivalente de una fila del Excel, pero para una sola transacción y en
 * formato de papel: lo que se archiva o se le entrega al empleado. El Excel sigue
 * siendo la salida del histórico completo.
 *
 * Se escribe directo sobre la respuesta HTTP, así que el documento no se arma
 * entero en memoria antes de enviarlo.
 *
 * Todo se dibuja con **x e y explícitos**. pdfkit arrastra un cursor interno, y
 * después de escribir en columnas ese cursor se queda en la última columna usada:
 * un `doc.text()` sin coordenadas aparece entonces en mitad de la página. Ya pasó
 * con los títulos de sección.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { FIRMAS_DIR } = require('./db');

const AZUL = '#1f4e78';
const TINTA = '#0f172a';
const TENUE = '#64748b';
const LINEA = '#cbd5e1';
const VERDE = '#15803d';
const AMBAR = '#b45309';
const ROJO = '#b91c1c';

const MARGEN = 42;
const ALTO_FIRMA = 74;
const ALTO_LINEA = 15;

function fecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ROTULO_CICLO = {
  completa: 'DEVUELTA',
  parcial: 'DEVOLUCIÓN PARCIAL',
  'sin-devolver': 'SIN DEVOLVER',
  esperando: 'ESPERANDO FIRMA',
};

const COLOR_CICLO = {
  completa: VERDE,
  parcial: AMBAR,
  'sin-devolver': ROJO,
  esperando: '#1d4ed8',
};

function construirPdf(grupo, res) {
  const e = grupo.entrega;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
    info: {
      Title: 'Comprobante ' + e.codigo,
      Author: 'Control de Herramientas',
      Subject: 'Recepción y devolución de herramientas',
    },
  });
  doc.pipe(res);

  const util = doc.page.width - MARGEN * 2;
  let y = MARGEN;

  /** Escribe y devuelve la y siguiente. Nunca deja que pdfkit decida la posición. */
  function escribir(texto, x, yy, opciones) {
    doc.text(String(texto == null ? '' : texto), x, yy, Object.assign({ width: util }, opciones));
    const fin = doc.y;
    doc.x = MARGEN;
    return fin;
  }

  function seccion(titulo, yy) {
    const arriba = yy + 10;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(TENUE);
    const fin = escribir(titulo.toUpperCase(), MARGEN, arriba, { characterSpacing: 0.8 });
    doc.moveTo(MARGEN, fin + 3).lineTo(MARGEN + util, fin + 3)
      .lineWidth(0.5).strokeColor(LINEA).stroke();
    return fin + 10;
  }

  /** Rótulo tenue encima, valor debajo. Devuelve la y del final del par. */
  function dato(rotulo, valor, x, ancho, yy) {
    doc.font('Helvetica').fontSize(7.5).fillColor(TENUE);
    doc.text(rotulo.toUpperCase(), x, yy, { width: ancho, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(TINTA);
    doc.text(valor || '—', x, yy + 10, { width: ancho, lineBreak: false });
    doc.x = MARGEN;
    return yy + 25;
  }

  /**
   * Una firma en su recuadro. El PNG llega recortado al trazo desde la tablet, así
   * que `fit` lo encaja aprovechando la caja sin deformarlo.
   */
  function firma(archivo, x, yy, ancho, pie) {
    doc.roundedRect(x, yy, ancho, ALTO_FIRMA, 6).lineWidth(0.7).strokeColor(LINEA).stroke();
    const ruta = archivo ? path.join(FIRMAS_DIR, archivo) : null;
    if (ruta && fs.existsSync(ruta)) {
      try {
        doc.image(ruta, x + 7, yy + 6, {
          fit: [ancho - 14, ALTO_FIRMA - 12], align: 'center', valign: 'center',
        });
      } catch (err) {
        // Un PNG ilegible no debe tumbar el comprobante entero.
      }
    } else {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(TENUE);
      doc.text('Sin firma', x, yy + ALTO_FIRMA / 2 - 4, { width: ancho, align: 'center', lineBreak: false });
    }
    doc.font('Helvetica').fontSize(7.5).fillColor(TENUE);
    doc.text(pie, x, yy + ALTO_FIRMA + 5, { width: ancho, lineBreak: false });
    doc.x = MARGEN;
    return yy + ALTO_FIRMA + 18;
  }

  function parDeFirmas(mov, yy) {
    const ancho = (util - 18) / 2;
    firma(mov.firma_empleado, MARGEN, yy, ancho,
      'Firma del empleado' + (mov.empleado ? ' — ' + mov.empleado : ''));
    return firma(mov.firma_responsable, MARGEN + ancho + 18, yy, ancho,
      'Firma del almacenista' + (mov.responsable ? ' — ' + mov.responsable : ''));
  }

  /**
   * La marca de cada herramienta, dibujada como vector.
   *
   * Nada de escribir "✓": las fuentes base de PDF usan WinAnsi, que no tiene ese
   * carácter, y salía un apóstrofo. Dibujarlo evita además tener que empotrar una
   * fuente entera por un solo glifo.
   */
  function marca(h, yy) {
    doc.save();
    if (h.cerradaPor === 'CAMBIO') {
      // Salio en un cambio: dos flechas opuestas, una por cada sentido.
      doc.strokeColor(AZUL).lineWidth(1.1).lineCap('round').lineJoin('round');
      doc.moveTo(MARGEN, yy + 3).lineTo(MARGEN + 9, yy + 3)
        .moveTo(MARGEN + 7, yy + 1).lineTo(MARGEN + 9, yy + 3).lineTo(MARGEN + 7, yy + 5)
        .moveTo(MARGEN + 9, yy + 7.5).lineTo(MARGEN, yy + 7.5)
        .moveTo(MARGEN + 2, yy + 5.5).lineTo(MARGEN, yy + 7.5).lineTo(MARGEN + 2, yy + 9.5)
        .stroke();
    } else if (h.devuelta) {
      doc.strokeColor(VERDE).lineWidth(1.5).lineCap('round').lineJoin('round')
        .moveTo(MARGEN + 1, yy + 5.4).lineTo(MARGEN + 4, yy + 8.4).lineTo(MARGEN + 9, yy + 1.8)
        .stroke();
    } else {
      doc.fillColor(AMBAR).circle(MARGEN + 4.5, yy + 5.2, 2.4).fill();
    }
    doc.restore();
  }

  /**
   * Una herramienta: marca, descripción y, a la derecha, si volvió o no. La nota de
   * la entrega detallada baja a su propio renglón: en el mismo cabía media palabra
   * antes de chocar con la columna de estado, que no se puede estrechar. Por el
   * mismo motivo, el "entró en …" de una herramienta incorporada en un cambio va
   * en ese segundo renglón, delante de la nota.
   */
  function lineaHerramienta(h, yy) {
    const anchoEstado = 155;
    marca(h, yy);

    doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
    doc.text(`${h.cantidad || 1} × ${h.descripcion}` + (h.estado ? `  (${h.estado})` : ''),
      MARGEN + 16, yy, { width: util - anchoEstado - 20, lineBreak: false });

    const estado = !h.devuelta ? 'PENDIENTE'
      : (h.cerradaPor === 'CAMBIO' ? 'cambiada en ' : 'devuelta en ') + h.devueltaEn;
    doc.font('Helvetica').fontSize(8).fillColor(h.devuelta ? TENUE : AMBAR);
    doc.text(estado,
      MARGEN + util - anchoEstado, yy + 1, { width: anchoEstado, align: 'right', lineBreak: false });

    doc.x = MARGEN;
    const nota = [h.llegoEn ? 'entró en ' + h.llegoEn : '', h.observaciones || '']
      .filter(Boolean).join('  —  ');
    if (!nota) return yy + ALTO_LINEA;

    doc.font('Helvetica-Oblique').fontSize(8).fillColor(TENUE);
    doc.text(nota, MARGEN + 16, yy + ALTO_LINEA - 3,
      { width: util - anchoEstado - 20, lineBreak: false });
    doc.x = MARGEN;
    return yy + ALTO_LINEA + 11;
  }

  // ------------------------------------------------------------- encabezado
  doc.font('Helvetica-Bold').fontSize(15).fillColor(AZUL);
  y = escribir('RECEPCIÓN Y DEVOLUCIÓN DE HERRAMIENTAS', MARGEN, y);
  doc.font('Helvetica').fontSize(9).fillColor(TENUE);
  y = escribir('Comprobante de firmas', MARGEN, y + 1);

  y += 12;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(TINTA);
  doc.text(e.codigo, MARGEN, y, { width: util / 2, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_CICLO[grupo.ciclo] || TENUE);
  doc.text(ROTULO_CICLO[grupo.ciclo] || '', MARGEN, y + 7, { width: util, align: 'right', lineBreak: false });
  doc.x = MARGEN;
  y += 30;

  doc.moveTo(MARGEN, y).lineTo(MARGEN + util, y).lineWidth(1).strokeColor(LINEA).stroke();
  y += 12;

  // ------------------------------------------------------------- quién
  const col = (util - 20) / 3;
  dato('Empleado', e.empleado, MARGEN, col, y);
  dato('Cédula / ID', e.cedula, MARGEN + col + 10, col, y);
  y = dato('Departamento', e.departamento, MARGEN + (col + 10) * 2, col, y);

  y += 4;
  dato('Recibido', fecha(e.firmado_en || e.creado_en), MARGEN, col, y);
  dato('Almacenista', e.responsable, MARGEN + col + 10, col, y);
  y = dato('Código de empleado', e.codigo_empleado, MARGEN + (col + 10) * 2, col, y);

  if (e.observaciones) {
    y = dato('Observaciones', e.observaciones, MARGEN, util, y + 4);
  }

  // ------------------------------------------------------------- herramientas
  y = seccion('Herramientas recibidas', y);
  for (const h of e.herramientas) y = lineaHerramienta(h, y);

  // ------------------------------------------------------------- firmas
  if (e.estado === 'firmado') {
    // Lo que el empleado firmo, tal cual salio en la tablet. La entrega detallada
    // deja cambiarlo, asi que el comprobante no puede dar por hecho el de siempre.
    y = seccion('Firmas de la recepción', y);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(TENUE);
    doc.text(e.declaracion, MARGEN, y, { width: util });
    y = doc.y + 8;
    doc.x = MARGEN;
    y = parDeFirmas(e, y);
  }

  /**
   * Un CAMBIO: lo que devuelve y lo que recibe, en dos listas, con su par de firmas.
   * Como una devolución, no se parte entre dos páginas; `necesario` suma además los
   * dos rótulos y la nota de cada línea que la lleve.
   */
  function cambio(d, yy) {
    const devuelve = d.herramientas.filter((h) => h.sentido === 'devuelve');
    const recibe = d.herramientas.filter((h) => h.sentido === 'recibe');
    const lineas = [
      ['Devuelve', devuelve, (h) => (h.estado ? `  —  regresa ${h.estado}` : '')],
      ['Recibe', recibe, (h) => (h.estado ? `  (${h.estado})` : '')],
    ];

    const conNota = d.herramientas.filter((h) => h.observaciones).length;
    const necesario = 46 + d.herramientas.length * ALTO_LINEA + conNota * 11 + 2 * 14 +
      (d.observaciones ? 14 : 0) + ALTO_FIRMA + 40;
    if (yy + necesario > doc.page.height - MARGEN - 30) {
      doc.addPage();
      yy = MARGEN;
    }

    yy = seccion('Cambio ' + d.codigo, yy);
    doc.font('Helvetica').fontSize(8.5).fillColor(TENUE);
    doc.text('Realizado el ' + fecha(d.firmado_en) + (d.responsable ? ' por ' + d.responsable : ''),
      MARGEN, yy, { width: util, lineBreak: false });
    doc.x = MARGEN;
    yy += 16;

    for (const [rotulo, lista, cola] of lineas) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(TENUE);
      doc.text(rotulo.toUpperCase(), MARGEN + 16, yy, { width: util - 16, lineBreak: false, characterSpacing: 0.6 });
      doc.x = MARGEN;
      yy += 14;
      for (const h of lista) {
        doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
        doc.text(`${h.cantidad || 1} × ${h.descripcion}` + cola(h),
          MARGEN + 16, yy, { width: util - 16, lineBreak: false });
        doc.x = MARGEN;
        yy += ALTO_LINEA;
        if (h.observaciones) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(TENUE);
          doc.text(h.observaciones, MARGEN + 16, yy - 3, { width: util - 16, lineBreak: false });
          doc.x = MARGEN;
          yy += 11;
        }
      }
    }

    if (d.observaciones) {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(TENUE);
      doc.text(d.observaciones, MARGEN + 16, yy, { width: util - 16, lineBreak: false });
      doc.x = MARGEN;
      yy += 14;
    }

    return parDeFirmas(d, yy + 6);
  }

  // ------------------------------------------------------- devoluciones y cambios
  for (const d of grupo.devoluciones.filter((x) => x.estado === 'firmado')) {
    if (d.tipo === 'CAMBIO') {
      y = cambio(d, y);
      continue;
    }

    // Una devolución no debe partirse entre dos páginas.
    const necesario = 46 + d.herramientas.length * ALTO_LINEA + ALTO_FIRMA + 40;
    if (y + necesario > doc.page.height - MARGEN - 30) {
      doc.addPage();
      y = MARGEN;
    }

    y = seccion('Devolución ' + d.codigo, y);
    doc.font('Helvetica').fontSize(8.5).fillColor(TENUE);
    doc.text('Recibida el ' + fecha(d.firmado_en) + (d.responsable ? ' por ' + d.responsable : ''),
      MARGEN, y, { width: util, lineBreak: false });
    doc.x = MARGEN;
    y += 16;

    for (const h of d.herramientas) {
      doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
      doc.text(`${h.cantidad || 1} × ${h.descripcion}` + (h.estado ? `  —  regresa ${h.estado}` : ''),
        MARGEN + 16, y, { width: util - 16, lineBreak: false });
      doc.x = MARGEN;
      y += ALTO_LINEA;
    }

    if (d.observaciones) {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(TENUE);
      doc.text(d.observaciones, MARGEN + 16, y, { width: util - 16, lineBreak: false });
      doc.x = MARGEN;
      y += 14;
    }

    y = parDeFirmas(d, y + 6);
  }

  // ------------------------------------------------------------- pie
  // El margen inferior se anula un momento: escribir por debajo de el hace que
  // pdfkit abra una pagina nueva, y salia un folio en blanco al final.
  const margenAbajo = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(7.5).fillColor(TENUE);
  doc.text('Generado el ' + fecha(new Date().toISOString()) +
    '  ·  Las firmas se capturaron en tablet y se conservan en el sistema.',
    MARGEN, doc.page.height - MARGEN + 4, { width: util, align: 'center', lineBreak: false });
  doc.page.margins.bottom = margenAbajo;

  doc.end();
}

module.exports = { construirPdf };
