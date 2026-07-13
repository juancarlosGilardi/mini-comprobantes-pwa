// URL de la API que genera el PDF (endpoint sin estado /api/pwa/pdf).
// Local: http://127.0.0.1:8850. Producción: el VPS con nginx + HTTPS.
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8850'
  : 'https://facturas-boletas.192.64.87.241.nip.io';

let SQL = null;
let db = null;

// ── Persistencia automática: la base SQLite vive en IndexedDB (en el disco del
//    equipo, nunca en la nube). Sin selector de archivo, sin volver a pedir permiso. ──
const IDB_NAME = 'mini-comprobantes';
const IDB_STORE = 'kv';
const DB_KEY = 'sqlite-db';

function abrirIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return abrirIdb().then((idb) => new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbPut(key, value) {
  return abrirIdb().then((idb) => new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function crearTablas() {
  db.run(`CREATE TABLE IF NOT EXISTS logos (
    ruc TEXT PRIMARY KEY,
    png_blob BLOB NOT NULL,
    actualizado TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS conversiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT,
    serie TEXT,
    numero TEXT,
    ruc_emisor TEXT,
    razon_social_emisor TEXT,
    cliente_doc TEXT,
    cliente_nombre TEXT,
    moneda TEXT,
    total REAL,
    fecha_emision TEXT,
    fecha_conversion TEXT
  )`);
}

async function persistir() {
  await idbPut(DB_KEY, db.export());
}

async function inicializar() {
  SQL = await initSqlJs({ locateFile: () => 'sql-wasm.wasm' });
  // Pide almacenamiento persistente (evita que el navegador borre los datos).
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) {}
  }
  const bytes = await idbGet(DB_KEY);
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  crearTablas();
  if (!bytes) await persistir();
  refrescar();
}

// ── Consultas / render ──

function filasDe(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

function refrescar(filtro = '') {
  actualizarDashboard();
  listarHistorial(filtro);
}

function actualizarDashboard() {
  const r = filasDe('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS suma, MAX(fecha_conversion) AS ult FROM conversiones')[0];
  document.getElementById('stat-total').textContent = r.n;
  document.getElementById('stat-monto').textContent = 'S/ ' + Number(r.suma).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('stat-ultimo').textContent = r.ult ? r.ult.slice(0, 10) : '—';
}

function listarHistorial(filtro = '') {
  let sql = 'SELECT tipo, serie, numero, ruc_emisor, cliente_nombre, moneda, total, fecha_emision, fecha_conversion FROM conversiones';
  const params = [];
  if (filtro) {
    sql += ` WHERE serie LIKE ? OR numero LIKE ? OR ruc_emisor LIKE ? OR cliente_nombre LIKE ?`;
    const like = `%${filtro}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY id DESC';
  const filas = filasDe(sql, params);

  const tabla = document.getElementById('tabla-historial');
  const vacio = document.getElementById('historial-vacio');
  const tbody = tabla.querySelector('tbody');
  tbody.innerHTML = '';
  if (!filas.length) {
    tabla.hidden = true;
    vacio.hidden = false;
    vacio.textContent = filtro ? 'Sin resultados para tu búsqueda.' : 'Aún no has convertido ningún comprobante.';
    return;
  }
  for (const f of filas) {
    const tr = document.createElement('tr');
    const conv = (f.fecha_conversion || '').slice(0, 16).replace('T', ' ');
    tr.innerHTML = `<td>${f.tipo || ''}</td><td>${f.serie}-${f.numero}</td><td>${f.ruc_emisor || ''}</td><td>${f.cliente_nombre || ''}</td><td>${f.moneda || ''} ${Number(f.total).toFixed(2)}</td><td>${f.fecha_emision || ''}</td><td>${conv}</td>`;
    tbody.appendChild(tr);
  }
  tabla.hidden = false;
  vacio.hidden = true;
}

// ── Logo por RUC ──

function obtenerLogoPorRuc(ruc) {
  const res = db.exec('SELECT png_blob FROM logos WHERE ruc = ?', [ruc]);
  if (!res.length || !res[0].values.length) return null;
  return new Uint8Array(res[0].values[0][0]);
}

async function guardarLogoPorRuc(ruc, pngBytes) {
  db.run('INSERT INTO logos (ruc, png_blob, actualizado) VALUES (?, ?, ?) ON CONFLICT(ruc) DO UPDATE SET png_blob = excluded.png_blob, actualizado = excluded.actualizado', [ruc, pngBytes, new Date().toISOString()]);
}

// ── Utilidades de archivo ──

async function leerXmlDesdeArchivo(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const esZip = file.name.toLowerCase().endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (esZip) {
    const entradas = fflate.unzipSync(bytes);
    const nombreXml = Object.keys(entradas).find((n) => n.toLowerCase().endsWith('.xml'));
    if (!nombreXml) throw new Error('El ZIP no contiene ningún archivo .xml.');
    return new TextDecoder('utf-8').decode(entradas[nombreXml]);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function imagenArchivoAPngBytes(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function registrarConversion(parsed) {
  const emisor = parsed.emisor || {};
  const cliente = parsed.cliente || {};
  db.run(`INSERT INTO conversiones (tipo, serie, numero, ruc_emisor, razon_social_emisor, cliente_doc, cliente_nombre, moneda, total, fecha_emision, fecha_conversion)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    parsed.tipo_desc || parsed.tipo || '', parsed.serie || '', parsed.numero || '',
    emisor.ruc || '', emisor.nombre || emisor.nombre_comercial || '',
    cliente.doc || '', cliente.nombre || '',
    parsed.moneda || '', Number(parsed.total) || 0,
    parsed.fecha || '', new Date().toISOString(),
  ]);
}

function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Convertir XML → PDF ──

document.getElementById('form-xml').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const mensajeXml = document.getElementById('mensaje-xml');
  mensajeXml.textContent = 'Procesando…';
  try {
    const xmlFile = document.getElementById('xml-archivo').files[0];
    const logoFile = document.getElementById('logo-archivo').files[0];
    if (!xmlFile) throw new Error('Selecciona un archivo XML o ZIP.');

    const xmlTexto = await leerXmlDesdeArchivo(xmlFile);
    const parsed = ublParser.parsearXmlTexto(xmlTexto);
    if (!parsed.ok) throw new Error(parsed.error || 'No se pudo interpretar el XML.');

    const ruc = (parsed.emisor && parsed.emisor.ruc) || '';
    let logoPngBytes = null;
    if (logoFile) {
      logoPngBytes = await imagenArchivoAPngBytes(logoFile);
      if (ruc) await guardarLogoPorRuc(ruc, logoPngBytes);
    } else if (ruc) {
      logoPngBytes = obtenerLogoPorRuc(ruc);
    }

    // El PDF lo genera la API sin estado (motor Python probado).
    const formData = new FormData();
    formData.append('xml', xmlFile, xmlFile.name);
    if (logoPngBytes) {
      formData.append('logo', new Blob([logoPngBytes], { type: 'image/png' }), 'logo.png');
    }
    const respuesta = await fetch(`${API_BASE}/api/pwa/pdf`, { method: 'POST', body: formData });
    if (!respuesta.ok) {
      let detalle = `La API respondió ${respuesta.status}.`;
      try { const j = await respuesta.json(); if (j.detail) detalle = j.detail; } catch (_) {}
      throw new Error(detalle);
    }
    const blob = await respuesta.blob();
    descargarBlob(blob, `${parsed.serie}-${parsed.numero}.pdf`);

    await registrarConversion(parsed);
    await persistir();
    refrescar(document.getElementById('buscar').value.trim());

    mensajeXml.textContent = `PDF generado: ${parsed.serie}-${parsed.numero}.pdf`;
    evento.target.reset();
    setTimeout(() => { mensajeXml.textContent = ''; }, 4000);
  } catch (err) {
    console.error(err);
    mensajeXml.textContent = `Error: ${err.message}`;
  }
});

// ── Búsqueda en el historial ──
document.getElementById('buscar').addEventListener('input', (e) => {
  listarHistorial(e.target.value.trim());
});

// ── Exportar / importar copia .sqlite ──
document.getElementById('btn-exportar').addEventListener('click', () => {
  const blob = new Blob([db.export()], { type: 'application/x-sqlite3' });
  const fecha = new Date().toISOString().slice(0, 10);
  descargarBlob(blob, `comprobantes-${fecha}.sqlite`);
});

document.getElementById('btn-importar').addEventListener('click', () => {
  document.getElementById('importar-archivo').click();
});

document.getElementById('importar-archivo').addEventListener('change', async (e) => {
  const mensajeDatos = document.getElementById('mensaje-datos');
  const file = e.target.files[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prueba = new SQL.Database(bytes);
    prueba.exec('SELECT 1 FROM conversiones LIMIT 1'); // valida que sea una base compatible
    db = prueba;
    crearTablas();
    await persistir();
    refrescar();
    mensajeDatos.textContent = 'Copia importada correctamente.';
  } catch (err) {
    mensajeDatos.textContent = 'Ese archivo no es una copia válida de esta app.';
  }
  e.target.value = '';
  setTimeout(() => { mensajeDatos.textContent = ''; }, 4000);
});

// ── Service worker + arranque ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => console.error('SW error:', err));
  });
}

inicializar().catch((err) => {
  console.error(err);
  document.getElementById('mensaje-xml').textContent = 'No se pudo iniciar la base de datos local: ' + err.message;
});
