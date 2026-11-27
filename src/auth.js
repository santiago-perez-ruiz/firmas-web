'use strict';

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
    if (parte.slice(0, i).trim() === COOKIE) return parte.slice(i + 1).trim();
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
<title>Acceso | Control de Herramientas</title>
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
    if (r.ok) {
      const destino = new URL(new URLSearchParams(location.search).get('destino') || '/', location.origin);
      location.replace(destino.origin === location.origin ? destino.href : '/');
      return;
    }
    const d = await r.json().catch(() => ({}));
    aviso.textContent = d.error || 'Código incorrecto';
    clave = ''; pintar();
  }
</script>
</body></html>`;

/** Puerta de contingencia para el cliente web anterior. */
function instalarLegado(app) {
  console.log('  Acceso   : protegido con codigo (CLAVE_ACCESO)');

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


const ROLES = {
  ADMIN: 'administracion',
  OPERADOR: 'operacion',
  TABLET: 'tablet',
};
const { ADMIN, OPERADOR, TABLET } = ROLES;
const hash = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

function error(res, estado, codigo, mensaje) {
  return res.status(estado).json({ codigo, error: mensaje });
}

function auditar(accion, identidad, dispositivoId, movimientoId) {
  console.log(JSON.stringify({ accion, rol: identidad.rol, sujeto: identidad.sujeto, dispositivoId, movimientoId }));
}

function prepararDispositivos(db) {
  const disponible = db.prepare(`
    SELECT id FROM dispositivos
    WHERE revocado_en IS NULL AND (credencial_hash IS NOT NULL OR codigo_caduca > ?)
  `);
  const insertar = db.prepare('INSERT INTO dispositivos (id, codigo_hash, codigo_caduca) VALUES (?, ?, ?)');
  const consumir = db.prepare(`
    UPDATE dispositivos
    SET credencial_hash = ?, codigo_hash = NULL, codigo_caduca = NULL,
        primer_movimiento = (SELECT COALESCE(MAX(id), 0) + 1 FROM movimientos)
    WHERE codigo_hash = ? AND codigo_caduca > ? AND revocado_en IS NULL
    RETURNING id
  `);
  const buscar = db.prepare(`
    SELECT id, primer_movimiento FROM dispositivos
    WHERE credencial_hash = ? AND revocado_en IS NULL
  `);
  const vigente = db.prepare('SELECT 1 FROM dispositivos WHERE id = ? AND credencial_hash IS NOT NULL');
  const revocar = db.prepare(`
    UPDATE dispositivos SET revocado_en = ?, credencial_hash = NULL, codigo_hash = NULL, codigo_caduca = NULL
    WHERE id = ? AND revocado_en IS NULL
  `);

  const emitir = db.transaction(() => {
    const ahora = Date.now();
    if (disponible.get(ahora)) return null;
    const dispositivoId = crypto.randomUUID();
    const codigo = crypto.randomBytes(12).toString('base64url');
    const caduca = ahora + 10 * 60 * 1000;
    insertar.run(dispositivoId, hash(codigo), caduca);
    return { dispositivoId, codigo, caduca: new Date(caduca).toISOString() };
  });

  return {
    emitir: () => emitir.immediate(),
    vincular(codigo) {
      const credencial = crypto.randomBytes(32).toString('base64url');
      const fila = consumir.get(hash(credencial), hash(codigo), Date.now());
      return fila && { dispositivoId: fila.id, credencial };
    },
    identificar(credencial) {
      const fila = buscar.get(hash(credencial));
      return fila && { rol: TABLET, dispositivoId: fila.id, primerMovimiento: fila.primer_movimiento };
    },
    vigente: (id) => Boolean(vigente.get(id)),
    revocar: (id) => revocar.run(Date.now(), id).changes > 0,
  };
}

function prepararAccess() {
  const emisor = process.env.ACCESS_EMISOR;
  const audiencia = process.env.ACCESS_AUDIENCIA;
  const cuentas = (variable) => new Set((process.env[variable] || '').split(',')
    .map((email) => email.trim().toLowerCase()).filter(Boolean));
  const administradores = cuentas('ACCESS_ADMINISTRADORES');
  const operadores = cuentas('ACCESS_OPERADORES');

  if (!emisor && !audiencia) return async () => null;
  if (!audiencia || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(emisor || '')) {
    throw new Error('Configure el emisor HTTPS de Cloudflare Access y la audiencia de la aplicación');
  }
  if ([...administradores].some((email) => operadores.has(email))) {
    throw new Error('Cada cuenta de Access debe tener un solo rol');
  }
  const verificador = import('jose').then(({ createRemoteJWKSet, jwtVerify }) => {
    const claves = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', emisor));
    return (token) => jwtVerify(token, claves, {
      issuer: emisor,
      audience: audiencia,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'sub'],
    });
  });

  return async (token) => {
    if (!token) return null;
    let payload;
    try {
      ({ payload } = await (await verificador)(token));
    } catch {
      return null;
    }
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub) return null;
    const email = payload.email.toLowerCase();
    const rol = administradores.has(email) ? ADMIN : operadores.has(email) ? OPERADOR : null;
    return { rol, sujeto: payload.sub, caduca: payload.exp * 1000 };
  };
}

const estadoMovimiento = /^\/api\/movimientos\/[1-9]\d*\/estado$/;
const firmarMovimiento = /^\/api\/movimientos\/[1-9]\d*\/firmar$/;
const cancelarMovimiento = /^\/api\/movimientos\/[1-9]\d*\/cancelar$/;
const pngFirma = /^\/firmas\/[\w.-]+\.png$/;
const recursos = /^\/(css|js)\/[\w.-]+\.(css|js)$/;

const lecturasOperacion = new Set(['/api/declaraciones', '/api/entregas-pendientes']);
const lecturasAdmin = new Set(['/api/historial', '/api/movimientos', '/api/export.xlsx']);
const pantallasOperacion = new Set(['/', '/index', '/index.html', '/detallada', '/detallada.html']);
const pantallasAdmin = new Set(['/registros', '/registros.html']);

function permiso(ruta, metodo) {
  if (metodo === 'GET' || metodo === 'HEAD') {
    if (ruta === '/api/dispositivos/sesion') return [TABLET, OPERADOR];
    if (ruta === '/api/activo' || estadoMovimiento.test(ruta)) return [OPERADOR, TABLET];
    if ((ruta === '/api/eventos' && metodo === 'GET') || recursos.test(ruta)) return [ADMIN, OPERADOR];
    if (lecturasOperacion.has(ruta) || pantallasOperacion.has(ruta)) return [OPERADOR];
    if (lecturasAdmin.has(ruta) || pantallasAdmin.has(ruta) || pngFirma.test(ruta) ||
        /^\/api\/entregas\/[1-9]\d*\/pdf$/.test(ruta)) return [ADMIN];
  }
  if (metodo === 'POST') {
    if (firmarMovimiento.test(ruta)) return [TABLET];
    if (ruta === '/api/movimientos' || cancelarMovimiento.test(ruta)) return [OPERADOR];
    if (ruta === '/api/dispositivos/codigos' ||
        /^\/api\/dispositivos\/[a-f0-9-]{36}\/revocar$/.test(ruta)) return [ADMIN];
  }
  return [];
}

function instalarRoles(app, store, json) {
  const dispositivos = prepararDispositivos(store.db);
  const identificarAccess = prepararAccess();
  const panel = process.env.HOST_PANEL;
  const movil = process.env.HOST_MOVIL;
  if (panel && panel === movil) throw new Error('El panel y la API móvil requieren hosts distintos');
  const firmaReferenciada = store.db.prepare(`
    SELECT 1 FROM movimientos WHERE estado = 'firmado'
    AND (firma_empleado = ? OR firma_responsable = ?) LIMIT 1
  `);
  const vinculacion = '/api/dispositivos/vincular';
  let intentosVinculacion = 0;
  let ventana = 0;

  app.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const ruta = req.path;
    const metodo = req.method;
    if (ruta === '/api/salud' && ['GET', 'HEAD'].includes(metodo)) return next();

    const host = req.hostname;
    const esMovil = Boolean(movil && host === movil);
    if (esMovil) {
      const visible = (ruta === vinculacion && metodo === 'POST') ||
        (permiso(ruta, metodo).some((rol) => rol !== ADMIN) && ruta.startsWith('/api/') && ruta !== '/api/eventos');
      if (!visible) return error(res, 404, 'NO_ENCONTRADO', 'Recurso no disponible');
    } else if ((panel && host !== panel) || (movil && ruta === vinculacion)) {
      return error(res, 404, 'NO_ENCONTRADO', 'Recurso no disponible');
    }

    if (metodo === 'POST' && (req.get('Sec-Fetch-Site') === 'cross-site' ||
        (req.get('Origin') && req.get('Origin') !== `https://${req.get('Host')}`))) {
      return error(res, 403, 'PERMISO_DENEGADO', 'Origen de la solicitud no autorizado');
    }
    if (ruta === vinculacion && metodo === 'POST') {
      if (Date.now() >= ventana) {
        ventana = Date.now() + 60_000;
        intentosVinculacion = 0;
      }
      if (++intentosVinculacion > 12) {
        res.set('Retry-After', String(Math.ceil((ventana - Date.now()) / 1000)));
        return error(res, 429, 'DEMASIADOS_INTENTOS', 'Espere antes de volver a intentar la vinculación');
      }
      return next();
    }

    try {
      const autorizacion = req.get('Authorization');
      const bearer = autorizacion?.match(/^Bearer ([\w.-]+)$/i)?.[1];
      const identidad = bearer && /^[\w-]{43}$/.test(bearer)
        ? dispositivos.identificar(bearer)
        : await identificarAccess(autorizacion ? bearer : req.get('Cf-Access-Jwt-Assertion'));
      if (!identidad) return error(res, 401, 'SESION_REQUERIDA', 'Se requiere una sesión válida');
      if (identidad.rol === ADMIN && ruta === '/' && metodo === 'GET') return res.redirect('/registros');
      if (!permiso(ruta, metodo).includes(identidad.rol) || (esMovil && identidad.rol === ADMIN)) {
        return error(res, 403, 'PERMISO_DENEGADO', 'El rol no tiene permiso para este recurso');
      }
      if (identidad.rol === TABLET && (estadoMovimiento.test(ruta) || firmarMovimiento.test(ruta))) {
        const id = Number(ruta.split('/')[3]);
        if (!Number.isSafeInteger(id) || id < identidad.primerMovimiento || !store.obtener(id)) {
          return error(res, 404, 'NO_ENCONTRADO', 'Movimiento no disponible para este dispositivo');
        }
      }
      if (pngFirma.test(ruta)) {
        const archivo = ruta.slice('/firmas/'.length);
        if (!firmaReferenciada.get(archivo, archivo)) {
          return error(res, 404, 'NO_ENCONTRADO', 'Firma no disponible');
        }
      }
      req.identidad = identidad;
      if (metodo === 'POST' && ruta.startsWith('/api/movimientos')) {
        const accion = firmarMovimiento.test(ruta) ? 'firmar' : cancelarMovimiento.test(ruta) ? 'cancelar' : 'crear';
        res.once('finish', () => {
          if (res.statusCode < 300) {
            const id = Number(ruta.split('/')[3]) || res.locals.movimientoId;
            auditar(accion, identidad, identidad.dispositivoId, id);
          }
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  app.post(vinculacion, json, (req, res) => {
    const codigo = req.body?.codigo;
    if (typeof codigo !== 'string' || !/^[\w-]{16}$/.test(codigo)) {
      return error(res, 400, 'VALIDACION', 'Código de vinculación inválido');
    }
    const resultado = dispositivos.vincular(codigo);
    if (!resultado) return error(res, 401, 'SESION_REQUERIDA', 'Código usado, vencido o inválido');
    auditar('vincular', { rol: TABLET }, resultado.dispositivoId);
    res.json(resultado);
  });

  app.post('/api/dispositivos/codigos', (req, res) => {
    const resultado = dispositivos.emitir();
    if (!resultado) {
      return error(res, 409, 'DISPOSITIVO_OCUPADO', 'Ya hay una tablet vinculada o un código vigente');
    }
    auditar('emitir código', req.identidad, resultado.dispositivoId);
    res.status(201).json(resultado);
  });
  app.post('/api/dispositivos/:id/revocar', (req, res) => {
    if (!dispositivos.revocar(req.params.id)) {
      return error(res, 404, 'NO_ENCONTRADO', 'Dispositivo no disponible');
    }
    auditar('revocar', req.identidad, req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/dispositivos/sesion', (req, res) => {
    const { rol, dispositivoId = null } = req.identidad;
    res.json({ rol, dispositivoId });
  });

  return (req, res, next) => {
    const identidad = req.identidad;
    if (identidad?.caduca <= Date.now() ||
        (identidad?.rol === TABLET && !dispositivos.vigente(identidad.dispositivoId))) {
      return error(res, 401, 'SESION_REQUERIDA', 'Se requiere una sesión válida');
    }
    next();
  };
}

function instalar(app, store, json) {
  const modo = process.env.ACCESO_MODO || (activo() ? 'legado' : 'roles');
  if (modo === 'roles') return instalarRoles(app, store, json);
  if (modo !== 'legado' || !activo()) throw new Error('El modo legado requiere CLAVE_ACCESO');
  app.use('/entrar', json);
  instalarLegado(app);
  return (req, res, next) => next();
}

function movimientoVisible(req, mov) {
  if (req.identidad?.rol !== TABLET || !mov) return mov;
  return mov.id >= req.identidad.primerMovimiento ? mov : null;
}

function errorSolicitud(err, req, res, next) {
  if (err.status === 413) return error(res, 413, 'VALIDACION', 'El cuerpo supera el tamaño permitido');
  if (err.status >= 400 && err.status < 500) {
    return error(res, err.status, 'VALIDACION', 'No se pudo leer la solicitud');
  }
  console.error('Error interno en la puerta de acceso');
  return error(res, 500, 'ERROR_INTERNO', 'No se pudo procesar la solicitud');
}

module.exports = { instalar, movimientoVisible, errorSolicitud };
