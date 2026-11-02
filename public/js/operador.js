/**
 * La maquinaria comun de las dos pantallas de operador: / (entrega rapida) y
 * /detallada (la del formulario largo, para el caso raro).
 *
 * Se saco de index.html cuando aparecio la segunda, y no por ahorrar lineas: el
 * velo que tapa el formulario mientras la tablet tiene un movimiento no es
 * cosmetica. Solo puede haber un movimiento activo a la vez y armar otro cancela el
 * anterior en silencio, dejando al empleado que estaba firmando con la pantalla en
 * blanco. Dos copias de esa regla se separan en la primera correccion, que es
 * exactamente la trampa que este proyecto ya evita en firmas-android.
 *
 * Cada pantalla pone su formulario; esto pone el comportamiento. La pagina debe
 * traer estos ids: #formulario, #cuerpoHerr, #btnAgregar, #btnEnviar, #aviso,
 * #estadoTablet, #rotuloEstado, #textoEstado, #btnCancelar, #velo, #veloTexto,
 * #veloDetalle, #tarjetaPendientes, #textoPendientes.
 */
(function (global) {
  'use strict';

  const $ = (s) => document.querySelector(s);

  function escapar(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function montar(opciones) {
    const cfg = Object.assign({
      // Que pantalla arma el movimiento: decide su serie de codigo (TRX / TRXD) y en
      // cual de las dos listas de /registros aparece.
      modo: 'rapida',
      // Los estados del catalogo de la casa. La pantalla detallada trae los del
      // formulario en papel, que no son los mismos.
      estados: ['Excelente', 'Bueno', 'Regular', 'Malo', 'Con daños'],
      // Columna de observaciones por herramienta: solo la entrega detallada.
      conNotas: false,
      // Campos propios de la pantalla, que se anaden al cuerpo del POST.
      leerExtra: () => ({}),
      // Lo que `form.reset()` no deja como estaba.
      limpiarExtra: () => {},
    }, opciones || {});

    let idActivo = null;

    // -------------------------------------------------------------- herramientas
    function filaHerramienta() {
      const tr = document.createElement('tr');
      const opciones = cfg.estados.map((e) => '<option>' + escapar(e) + '</option>').join('');
      tr.innerHTML =
        '<td><input type="text" class="descripcion" placeholder="Ej. Taladro percutor DeWalt 18V" autocomplete="off"></td>' +
        '<td><input type="text" class="cantidad" inputmode="numeric" value="1"></td>' +
        '<td><select class="estado">' + opciones + '</select></td>' +
        (cfg.conNotas
          ? '<td><input type="text" class="observaciones" placeholder="Opcional" autocomplete="off"></td>'
          : '') +
        '<td><button type="button" class="quitar" title="Quitar">&times;</button></td>';
      tr.querySelector('.quitar').addEventListener('click', () => {
        tr.remove();
        if (!$('#cuerpoHerr').children.length) agregarFila();
      });
      return tr;
    }

    function agregarFila() {
      $('#cuerpoHerr').appendChild(filaHerramienta());
    }

    function leerHerramientas() {
      return Array.from($('#cuerpoHerr').querySelectorAll('tr'))
        .map((tr) => {
          const notas = tr.querySelector('.observaciones');
          return {
            descripcion: tr.querySelector('.descripcion').value.trim(),
            cantidad: tr.querySelector('.cantidad').value.trim() || '1',
            estado: tr.querySelector('.estado').value,
            observaciones: notas ? notas.value.trim() : '',
          };
        })
        .filter((h) => h.descripcion);
    }

    // -------------------------------------------------------------------- avisos
    function avisar(texto, clase) {
      const a = $('#aviso');
      a.textContent = texto;
      a.className = 'aviso ' + clase;
      if (clase === 'ok') setTimeout(() => a.classList.add('oculto'), 6000);
    }

    // ----------------------------------------------------------------- pendientes
    /**
     * Aviso de lo que sigue en la calle. Las devoluciones no se arman aqui: se
     * gestionan desde el registro de su recepcion, que es donde se ve que falta.
     */
    async function cargarPendientes() {
      let lista = [];
      try {
        lista = await fetch('/api/entregas-pendientes', { cache: 'no-store' }).then((r) => r.json());
      } catch (e) {
        return;                         // sin conexion no se anuncia nada
      }
      $('#tarjetaPendientes').classList.toggle('oculto', !lista.length);
      if (!lista.length) return;

      const piezas = lista.reduce((n, e) => n + e.pendientes.length, 0);
      const quienes = lista.map((e) => escapar(e.empleado) + ' (' + e.pendientes.length + ')').join(', ');
      $('#textoPendientes').innerHTML =
        '<span class="cuantas">' + piezas + (piezas === 1 ? ' herramienta' : ' herramientas') +
        '</span> sin devolver &mdash; ' + quienes;
    }

    // ------------------------------------------------------------ estado en vivo
    function estado(clase, rotulo, frase) {
      $('#estadoTablet').className = 'estado-tablet ' + clase;
      $('#rotuloEstado').textContent = rotulo;
      $('#textoEstado').innerHTML = frase;
    }

    /**
     * Bloquea el formulario mientras la tablet tiene un movimiento.
     *
     * No es solo cosmetica: solo puede haber un movimiento activo a la vez, y enviar
     * otro cancela el anterior en silencio. Con el formulario tapado no se puede
     * dejar a un empleado con la pantalla en blanco por accidente.
     */
    function bloquear(mov) {
      $('#velo').classList.toggle('oculto', !mov);
      // Fuera del orden de tabulacion: sin esto se seguiria escribiendo a ciegas
      // detras del velo con el teclado.
      $('#formulario').querySelectorAll('input, select, textarea, button')
        .forEach((el) => { el.tabIndex = mov ? -1 : 0; });
      if (mov) {
        $('#veloTexto').textContent = 'Esperando la firma en la tablet';
        $('#veloDetalle').textContent = mov.codigo + ' — ' + mov.empleado;
      }
    }

    function pintarEstado(mov) {
      idActivo = mov ? mov.id : null;
      $('#btnCancelar').classList.toggle('oculto', !mov);
      bloquear(mov);
      if (mov) {
        estado('espera', mov.codigo + ' en la tablet',
          'Esperando la firma de <span class="quien">' + escapar(mov.empleado) + '</span>');
      } else {
        estado('libre', 'Tablet libre', 'Lista para recibir un movimiento');
      }
    }

    // --------------------------------------------------------------------- envio
    $('#btnAgregar').addEventListener('click', agregarFila);
    agregarFila();

    $('#formulario').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      // Las dos pantallas solo arman entregas. La devolucion se gestiona desde el
      // registro de su recepcion, donde se ve que falta por devolver.
      const cuerpo = Object.assign({
        tipo: 'ENTREGA',
        modo: cfg.modo,
        empleado: $('#empleado').value.trim(),
        cedula: $('#cedula').value.trim(),
        departamento: $('#departamento').value.trim(),
        responsable: $('#responsable').value.trim(),
        observaciones: $('#observaciones').value.trim(),
        herramientas: leerHerramientas(),
      }, cfg.leerExtra());

      $('#btnEnviar').disabled = true;
      try {
        const r = await fetch('/api/movimientos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cuerpo),
        });
        const datos = await r.json();
        if (!r.ok) throw new Error(datos.error || 'No se pudo enviar');
        canal.olvidar();
        pintarEstado(datos);
        avisar(datos.codigo + ' enviado a la tablet. Ya puede firmar.', 'ok');
        $('#formulario').reset();
        $('#cuerpoHerr').innerHTML = '';
        agregarFila();
        cfg.limpiarExtra();
      } catch (e) {
        avisar(e.message, 'error');
      } finally {
        $('#btnEnviar').disabled = false;
      }
    });

    $('#btnCancelar').addEventListener('click', async () => {
      if (idActivo) await fetch('/api/movimientos/' + idActivo + '/cancelar', { method: 'POST' });
    });

    // `let` y no `const`: los avisos de conexion pueden llegar antes de que
    // termine la asignacion, y con `const` eso seria un error de zona muerta.
    let canal = null;
    canal = escucharMovimientos({
      alActivo: pintarEstado,
      alFirmado(m) {
        avisar('✔ ' + m.codigo + ' firmado por ' + m.empleado + '.', 'ok');
        // Una entrega firmada suma pendientes; una devolución los resta.
        cargarPendientes();
      },
      alConexion(bien) {
        if (bien) return;
        estado('caido', 'Sin conexión', 'No se llega al servidor, reintentando…');
      },
    });

    cargarPendientes();

    return { avisar, agregarFila, cargarPendientes };
  }

  global.montarOperador = montar;
  global.escaparTexto = escapar;
})(window);
