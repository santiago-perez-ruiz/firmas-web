/**
 * Lienzo de firma para pantalla tactil.
 * Usa Pointer Events (dedo, lapiz digital y mouse con el mismo codigo) y
 * desactiva el gesto de scroll sobre el area para que arrastrar el dedo dibuje
 * en lugar de mover la pagina.
 */
(function (global) {
  'use strict';

  /**
   * Devuelve el PNG recortado al rectangulo que de verdad tiene trazo.
   *
   * El lienzo ocupa todo el ancho de la tablet y la firma solo una parte, asi que
   * guardar el lienzo entero deja la firma diminuta en cualquier sitio donde se
   * muestre a tamano fijo: en el Excel, dentro de su celda, se veia estrecha y
   * perdida. Recortando aqui el archivo nace ya ajustado, y no hace falta que cada
   * consumidor sepa encuadrarlo.
   *
   * Se recorta al exportar y no mientras se dibuja: el lienzo de trabajo no se
   * toca, que es lo que permite seguir firmando despues de un "Borrar".
   */
  function recortarAlTrazo(canvas) {
    const entero = canvas.toDataURL('image/png');
    try {
      const ancho = canvas.width;
      const alto = canvas.height;
      if (!ancho || !alto) return entero;

      const pixeles = canvas.getContext('2d').getImageData(0, 0, ancho, alto).data;
      let x0 = ancho, y0 = alto, x1 = -1, y1 = -1;
      for (let y = 0; y < alto; y++) {
        for (let x = 0; x < ancho; x++) {
          if (pixeles[(y * ancho + x) * 4 + 3] > 24) {      // alfa: aqui hay tinta
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return entero;                            // sin tinta: nada que recortar

      // Un respiro proporcional al trazo, para que no quede pegado al borde.
      const margen = Math.max(6, Math.round(Math.min(x1 - x0, y1 - y0) * 0.06));
      x0 = Math.max(0, x0 - margen);
      y0 = Math.max(0, y0 - margen);
      x1 = Math.min(ancho - 1, x1 + margen);
      y1 = Math.min(alto - 1, y1 + margen);

      const recorte = document.createElement('canvas');
      recorte.width = x1 - x0 + 1;
      recorte.height = y1 - y0 + 1;
      recorte.getContext('2d').drawImage(canvas, x0, y0, recorte.width, recorte.height,
                                        0, 0, recorte.width, recorte.height);
      return recorte.toDataURL('image/png');
    } catch (e) {
      return entero;      // ante cualquier fallo, la firma completa sigue siendo valida
    }
  }

  function LienzoFirma(canvas, opciones) {
    const cfg = Object.assign({ color: '#0f172a', grosor: 2.6, alMarcar: null }, opciones || {});
    const ctx = canvas.getContext('2d');

    let dibujando = false;
    let hayTrazo = false;
    let ultimo = null;
    let ultimoMedio = null;
    let punteroActivo = null;

    let anchoCss = 0;
    let altoCss = 0;

    function ajustarResolucion() {
      const rect = canvas.getBoundingClientRect();
      const dpr = global.devicePixelRatio || 1;

      // Mientras el lienzo esta oculto mide 0: reescalar ahi dejaria el buffer
      // desincronizado del tamano en pantalla y el trazo saldria desplazado del dedo.
      if (rect.width < 1 || rect.height < 1) return;
      if (Math.abs(rect.width - anchoCss) < 0.5 && Math.abs(rect.height - altoCss) < 0.5) return;
      anchoCss = rect.width;
      altoCss = rect.height;

      // Conserva lo dibujado al reescalar (rotacion de la tablet, cambio de tamano).
      const previo = hayTrazo ? canvas.toDataURL('image/png') : null;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = cfg.grosor;
      if (previo) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
        img.src = previo;
      }
    }

    function posicion(ev) {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function iniciar(ev) {
      if (punteroActivo !== null) return;          // ignora un segundo dedo apoyado
      punteroActivo = ev.pointerId;
      dibujando = true;
      ultimo = posicion(ev);
      ultimoMedio = ultimo;
      // Un toque seco tambien deja marca: punto del grosor del trazo.
      ctx.beginPath();
      ctx.arc(ultimo.x, ultimo.y, cfg.grosor / 2, 0, Math.PI * 2);
      ctx.fillStyle = cfg.color;
      ctx.fill();
      marcar();
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }

    function mover(ev) {
      if (!dibujando || ev.pointerId !== punteroActivo) return;
      // getCoalescedEvents recupera los puntos intermedios que el navegador agrupo:
      // sin esto, un trazo rapido con el dedo sale poligonal. Puede devolver lista
      // vacia (Safari, eventos sinteticos), asi que siempre queda el evento suelto.
      let eventos = [];
      if (typeof ev.getCoalescedEvents === 'function') {
        try { eventos = ev.getCoalescedEvents(); } catch (e) { eventos = []; }
      }
      if (!eventos || eventos.length === 0) eventos = [ev];
      for (const e of eventos) {
        const p = posicion(e);
        // Curva de Bezier entre puntos medios consecutivos, con el punto capturado
        // como control: da un trazo continuo y suave. Arrancar cada tramo en el
        // punto medio anterior (y no en `ultimo`) es lo que evita los huecos.
        const medio = { x: (ultimo.x + p.x) / 2, y: (ultimo.y + p.y) / 2 };
        ctx.beginPath();
        ctx.moveTo(ultimoMedio.x, ultimoMedio.y);
        ctx.quadraticCurveTo(ultimo.x, ultimo.y, medio.x, medio.y);
        ctx.stroke();
        ultimoMedio = medio;
        ultimo = p;
      }
      ev.preventDefault();
    }

    function terminar(ev) {
      if (ev.pointerId !== punteroActivo) return;
      dibujando = false;
      punteroActivo = null;
      ultimo = null;
      ultimoMedio = null;
    }

    function marcar() {
      if (!hayTrazo) {
        hayTrazo = true;
        if (cfg.alMarcar) cfg.alMarcar(true);
      }
    }

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', iniciar);
    canvas.addEventListener('pointermove', mover);
    canvas.addEventListener('pointerup', terminar);
    canvas.addEventListener('pointercancel', terminar);
    canvas.addEventListener('pointerleave', terminar);
    // Safari/iOS todavia dispara gestos propios sobre el canvas.
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    global.addEventListener('resize', ajustarResolucion);
    global.addEventListener('orientationchange', ajustarResolucion);

    // Dispara en cuanto el lienzo recibe tamano real (al mostrarse la pantalla de
    // firma) y en cada rotacion de la tablet, sin depender del orden de las llamadas.
    if (global.ResizeObserver) {
      new global.ResizeObserver(ajustarResolucion).observe(canvas);
    }
    ajustarResolucion();

    return {
      limpiar() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hayTrazo = false;
        if (cfg.alMarcar) cfg.alMarcar(false);
      },
      get vacio() {
        return !hayTrazo;
      },
      ajustar: ajustarResolucion,
      /** PNG con fondo transparente, recortado al trazo, listo para el Excel. */
      aPng() {
        return hayTrazo ? recortarAlTrazo(canvas) : null;
      },
    };
  }

  global.LienzoFirma = LienzoFirma;
})(window);
