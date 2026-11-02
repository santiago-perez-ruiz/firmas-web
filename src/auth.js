'use strict';

/**
 * Puerta de acceso opcional.
 *
 * Sin CLAVE_ACCESO la aplicacion queda abierta: es lo razonable dentro de la red
 * de la empresa. En cuanto se publica por un tunel, la variable pasa a ser
 * obligatoria, porque /registros muestra nombres y cedulas de los empleados.
 *
 * La pantalla de entrada es un teclado numerico en pantalla: la tablet no
 * necesita levantar el teclado del sistema para escribir el codigo.
 */

const crypto = require('crypto');

const CLAVE = String(process.env.CLAVE_ACCESO || '').trim();
const DIAS_SESION = 30;
const COOKIE = 'sesion_firmas';

// Secreto derivado de la clave: al cambiar la clave caducan todas las sesiones.
const SECRETO = crypto.createHash('sha256').update('firmas|' + CLAVE).digest();

// Freno a la fuerza bruta: un codigo corto en una URL publica se adivina rapido.
const intentos = new Map();
const MAX_INTENTOS = 8;
const VENTANA_MS = 10 * 60 * 1000;

function activo() {
  return CLAVE.length > 0;
}

function firmar(caduca) {
  return crypto.createHmac('sha256', SECRETO).update(String(caduca)).digest('hex');
}

function crearTicket() {
  const caduca = Date.now() + DIAS_SESION * 24 * 60 * 60 * 1000;
  return caduca + '.' + firmar(caduca);
}

function ticketValido(valor) {
  if (!valor || typeof valor !== 'string') return false;
  const [caduca, firma] = valor.split('.');
  if (!caduca || !firma) return false;
  if (Number(caduca) < Date.now()) return false;
  const esperada = Buffer.from(firmar(caduca));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

function leerCookie(req) {
  const crudo = req.headers.cookie;
  if (!crudo) return null;
  for (const parte of crudo.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === COOKIE) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function registrarIntento(ip) {
  const ahora = Date.now();
  const previo = intentos.get(ip);
  if (!previo || ahora - previo.desde > VENTANA_MS) {
    intentos.set(ip, { n: 1, desde: ahora });
    return true;
  }
  previo.n += 1;
  return previo.n <= MAX_INTENTOS;
}

function bloqueado(ip) {
  const previo = intentos.get(ip);
  return !!previo && Date.now() - previo.desde <= VENTANA_MS && previo.n > MAX_INTENTOS;
}

const PAGINA = (aviso) => `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Acceso — Control de Herramientas</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f172a; color:#f8fafc; font-family:"Segoe UI",system-ui,Arial,sans-serif;
         user-select:none; -webkit-user-select:none; }
  .caja { width:340px; max-width:92vw; text-align:center; }
  h1 { font-size:20px; margin:0 0 6px; }
  p  { font-size:14px; color:#94a3b8; margin:0 0 22px; }
  .puntos { display:flex; gap:12px; justify-content:center; height:20px; margin-bottom:22px; }
  .punto { width:14px; height:14px; border-radius:50%; border:2px solid #475569; }
  .punto.lleno { background:#60a5fa; border-color:#60a5fa; }
  .teclado { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  button { padding:20px 0; font-size:22px; font-weight:600; font-family:inherit;
           color:#f8fafc; background:#1e293b; border:1px solid #334155; border-radius:12px;
           cursor:pointer; touch-action:manipulation; }
  button:active { background:#334155; }
  button.tenue { font-size:15px; color:#94a3b8; }
  .aviso { min-height:22px; margin-top:18px; font-size:14px; color:#f87171; }
</style></head><body>
<div class="caja">
  <h1>Control de Herramientas</h1>
  <p>Introduzca el código de acceso</p>
  <div class="puntos" id="puntos"></div>
  <div class="teclado">
    <button data-t="1">1</button><button data-t="2">2</button><button data-t="3">3</button>
    <button data-t="4">4</button><button data-t="5">5</button><button data-t="6">6</button>
    <button data-t="7">7</button><button data-t="8">8</button><button data-t="9">9</button>
    <button class="tenue" id="borrar">Borrar</button>
    <button data-t="0">0</button>
    <button class="tenue" id="entrar">Entrar</button>
  </div>
  <div class="aviso" id="aviso">${aviso || ''}</div>
</div>
<script>
  let clave = '';
  const puntos = document.getElementById('puntos');
  const aviso = document.getElementById('aviso');
  function pintar() {
    puntos.innerHTML = Array.from(clave).map(() => '<span class="punto lleno"></span>').join('');
  }
  document.querySelectorAll('[data-t]').forEach((b) =>
    b.addEventListener('click', () => { if (clave.length < 24) { clave += b.dataset.t; pintar(); } }));
  document.getElementById('borrar').addEventListener('click', () => { clave = clave.slice(0, -1); pintar(); });
  document.getElementById('entrar').addEventListener('click', enviar);
  document.addEventListener('keydown', (e) => {
    if (/^[0-9]$/.test(e.key) && clave.length < 24) { clave += e.key; pintar(); }
    else if (e.key === 'Backspace') { clave = clave.slice(0, -1); pintar(); }
    else if (e.key === 'Enter') enviar();
  });
  async function enviar() {
    if (!clave) return;
    aviso.textContent = '';
    const r = await fetch('/entrar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave: clave }),
    });
    if (r.ok) { location.replace(new URLSearchParams(location.search).get('destino') || '/'); return; }
    const d = await r.json().catch(() => ({}));
    aviso.textContent = d.error || 'Código incorrecto';
    clave = ''; pintar();
  }
</script>
</body></html>`;

/** Rutas de entrada + middleware. Sin CLAVE_ACCESO no hace nada. */
function instalar(app) {
  if (!activo()) {
    console.log('  Acceso   : ABIERTO (sin CLAVE_ACCESO). Correcto solo en red interna.');
    return;
  }
  console.log('  Acceso   : protegido con codigo (CLAVE_ACCESO)');

  // Detras del tunel la IP real llega en X-Forwarded-For.
  app.set('trust proxy', true);

  app.get('/entrar', (req, res) => {
    res.type('html').send(PAGINA(''));
  });

  app.post('/entrar', (req, res) => {
    const ip = req.ip || 'desconocida';
    if (bloqueado(ip)) {
      return res.status(429).json({ error: 'Demasiados intentos. Espere unos minutos.' });
    }
    const enviada = String((req.body && req.body.clave) || '');
    const a = Buffer.from(enviada);
    const b = Buffer.from(CLAVE);
    const correcta = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!correcta) {
      registrarIntento(ip);
      return res.status(401).json({ error: 'Código incorrecto' });
    }
    intentos.delete(ip);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${crearTicket()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DIAS_SESION * 24 * 3600}`
    );
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (req.path === '/entrar' || req.path === '/api/salud') return next();
    if (ticketValido(leerCookie(req))) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesión caducada' });
    res.redirect('/entrar?destino=' + encodeURIComponent(req.originalUrl));
  });
}

module.exports = { instalar, activo };
