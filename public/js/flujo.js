/**
 * Canal de avisos entre el servidor y las pantallas.
 *
 * Lo normal es Server-Sent Events, que llega en milisegundos. Pero cuando la
 * aplicacion se publica por un tunel, el proxy puede retener el flujo: la conexion
 * figura abierta y no llega ni un byte. Por eso el canal se vigila con el latido
 * que manda el servidor y, si no se recibe nada, se pasa solo a preguntar cada
 * pocos segundos. La pantalla sigue funcionando, solo que con unos segundos de
 * retraso en vez de al instante.
 */
(function (global) {
  'use strict';

  const SIN_SENAL_MS = 14000;  // el servidor late cada 8 s
  const SONDEO_MS = 3000;

  function escuchar(opciones) {
    const cfg = Object.assign({ alActivo: null, alFirmado: null, alConexion: null }, opciones || {});

    let ultimaSenal = Date.now();
    let sondeo = null;
    let sondeando = false;
    let ultimoActivoId = undefined;

    function senal() {
      ultimaSenal = Date.now();
      if (sondeando) detenerSondeo();
      if (cfg.alConexion) cfg.alConexion(true);
    }

    // El mismo movimiento puede llegar por las dos vias; solo se avisa si cambio.
    function publicarActivo(mov) {
      const id = mov ? mov.id : null;
      if (id === ultimoActivoId) return;
      ultimoActivoId = id;
      if (cfg.alActivo) cfg.alActivo(mov);
    }

    async function consultar() {
      try {
        const r = await fetch('/api/activo', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        publicarActivo(await r.json());
        if (cfg.alConexion) cfg.alConexion(true);
      } catch (e) {
        if (cfg.alConexion) cfg.alConexion(false);
      }
    }

    function iniciarSondeo() {
      if (sondeo) return;
      sondeando = true;
      consultar();
      sondeo = setInterval(consultar, SONDEO_MS);
    }

    function detenerSondeo() {
      if (sondeo) clearInterval(sondeo);
      sondeo = null;
      sondeando = false;
    }

    const fuente = new EventSource('/api/eventos');
    fuente.addEventListener('latido', senal);
    fuente.addEventListener('activo', (e) => {
      senal();
      publicarActivo(JSON.parse(e.data));
    });
    fuente.addEventListener('firmado', (e) => {
      senal();
      if (cfg.alFirmado) cfg.alFirmado(JSON.parse(e.data));
    });
    fuente.onerror = () => {
      // EventSource reintenta solo; mientras tanto se pregunta por HTTP.
      iniciarSondeo();
      if (cfg.alConexion) cfg.alConexion(false);
    };

    // Vigilante: la conexion puede figurar abierta y no entregar nada.
    setInterval(() => {
      if (Date.now() - ultimaSenal > SIN_SENAL_MS) iniciarSondeo();
    }, 4000);

    // Una tablet que despierta puede haberse perdido avisos.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) consultar();
    });

    consultar();

    return {
      consultar,
      get porSondeo() {
        return sondeando;
      },
      /** Reinicia el recuerdo del ultimo movimiento (tras firmar, por ejemplo). */
      olvidar() {
        ultimoActivoId = undefined;
      },
    };
  }

  global.escucharMovimientos = escuchar;
})(window);
