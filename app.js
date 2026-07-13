// URL de la API que genera el PDF (endpoint sin estado /api/pwa/pdf).
// Local: http://127.0.0.1:8850. Producción: el VPS con nginx + HTTPS.
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8850'
  : 'https://facturas-boletas.192.64.87.241.nip.io';

let SQL = null;
let db = null;
let fileHandle = null;

const estadoArchivo = document.getElementById('estado-archivo');
const seccionForm = document.getElementById('seccion-form');
const seccionLista = document.getElementById('seccion-lista');
const mensajeGuardado = document.getElementById('mensaje-guardado');
const tabla = document.getElementById('tabla-comprobantes');
const seccionXml = document.getElementById('seccion-xml');
const seccionHistorial = document.getElementById('seccion-historial');
const mensajeXml = document.getElementById('mensaje-xml');
const tablaHistorial = document.getElementById('tabla-historial');

const DB_NAME = 'mini-pwa-poc';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'archivo-datos';

function abrirIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function guardarHandleEnIndexedDB(handle) {
  const idb = await abrirIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function leerHandleDeIndexedDB() {
  const idb = await abrirIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function asegurarPermiso(handle) {
  const opciones = { mode: 'readwrite' };
  if ((await handle.queryPermission(opciones)) === 'granted') return true;
  return (await handle.requestPermission(opciones)) === 'granted';
}

async function inicializarSQL() {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: () => 'sql-wasm.wasm' });
  }
}

function crearTablaSiNoExiste() {
  db.run(`CREATE TABLE IF NOT EXISTS comprobantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    monto REAL NOT NULL,
    fecha TEXT NOT NULL,
    descripcion TEXT
  )`);
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

async function cargarDbDesdeArchivo(handle) {
  const archivo = await handle.getFile();
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  db = bytes.length > 0 ? new SQL.Database(bytes) : new SQL.Database();
  crearTablaSiNoExiste();
}

async function escribirDbEnArchivo() {
  const bytes = db.export();
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function activarUI(nombreArchivo) {
  estadoArchivo.textContent = `Archivo activo: ${nombreArchivo}`;
  seccionXml.hidden = false;
  seccionHistorial.hidden = false;
  seccionForm.hidden = false;
  seccionLista.hidden = false;
  document.getElementById('fecha').valueAsDate = new Date();
}

async function abrirArchivoExistente() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Base SQLite', accept: { 'application/x-sqlite3': ['.sqlite', '.db'] } }],
    });
    await inicializarSQL();
    await cargarDbDesdeArchivo(handle);
    fileHandle = handle;
    await guardarHandleEnIndexedDB(handle);
    await activarUI(handle.name);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
}

async function crearArchivoNuevo() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'comprobantes.sqlite',
      types: [{ description: 'Base SQLite', accept: { 'application/x-sqlite3': ['.sqlite'] } }],
    });
    await inicializarSQL();
    db = new SQL.Database();
    crearTablaSiNoExiste();
    fileHandle = handle;
    await escribirDbEnArchivo();
    await guardarHandleEnIndexedDB(handle);
    await activarUI(handle.name);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
}

async function intentarRestaurarSesionAnterior() {
  const handle = await leerHandleDeIndexedDB();
  if (!handle) return;
  const permitido = await asegurarPermiso(handle);
  if (!permitido) return;
  await inicializarSQL();
  await cargarDbDesdeArchivo(handle);
  fileHandle = handle;
  await activarUI(handle.name);
}

function pintarTabla(filas) {
  const tbody = tabla.querySelector('tbody');
  tbody.innerHTML = '';
  for (const fila of filas) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fila.id}</td><td>${fila.tipo}</td><td>S/ ${fila.monto.toFixed(2)}</td><td>${fila.fecha}</td><td>${fila.descripcion ?? ''}</td>`;
    tbody.appendChild(tr);
  }
  tabla.hidden = false;
}

function listarComprobantes() {
  const resultado = db.exec('SELECT id, tipo, monto, fecha, descripcion FROM comprobantes ORDER BY id DESC');
  if (resultado.length === 0) {
    pintarTabla([]);
    return;
  }
  const columnas = resultado[0].columns;
  const filas = resultado[0].values.map((valores) => Object.fromEntries(columnas.map((col, i) => [col, valores[i]])));
  pintarTabla(filas);
}

document.getElementById('btn-abrir').addEventListener('click', abrirArchivoExistente);
document.getElementById('btn-crear').addEventListener('click', crearArchivoNuevo);
document.getElementById('btn-listar').addEventListener('click', listarComprobantes);

document.getElementById('form-comprobante').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const tipo = document.getElementById('tipo').value;
  const monto = parseFloat(document.getElementById('monto').value);
  const fecha = document.getElementById('fecha').value;
  const descripcion = document.getElementById('descripcion').value;

  db.run('INSERT INTO comprobantes (tipo, monto, fecha, descripcion) VALUES (?, ?, ?, ?)', [tipo, monto, fecha, descripcion]);
  await escribirDbEnArchivo();

  mensajeGuardado.textContent = 'Comprobante guardado correctamente.';
  evento.target.reset();
  document.getElementById('fecha').valueAsDate = new Date();
  document.getElementById('tipo').focus();
  setTimeout(() => { mensajeGuardado.textContent = ''; }, 3000);

  if (!tabla.hidden) listarComprobantes();
});

// ═══ Conversión XML (Clave SOL) → PDF ═══

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

function obtenerLogoPorRuc(ruc) {
  const res = db.exec('SELECT png_blob FROM logos WHERE ruc = ?', [ruc]);
  if (!res.length || !res[0].values.length) return null;
  return new Uint8Array(res[0].values[0][0]);
}

async function guardarLogoPorRuc(ruc, pngBytes) {
  db.run('INSERT INTO logos (ruc, png_blob, actualizado) VALUES (?, ?, ?) ON CONFLICT(ruc) DO UPDATE SET png_blob = excluded.png_blob, actualizado = excluded.actualizado', [ruc, pngBytes, new Date().toISOString()]);
  await escribirDbEnArchivo();
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
  await escribirDbEnArchivo();
}

function pintarTablaHistorial(filas) {
  const tbody = tablaHistorial.querySelector('tbody');
  tbody.innerHTML = '';
  for (const fila of filas) {
    const tr = document.createElement('tr');
    const convertido = (fila.fecha_conversion || '').slice(0, 16).replace('T', ' ');
    tr.innerHTML = `<td>${fila.tipo}</td><td>${fila.serie}-${fila.numero}</td><td>${fila.ruc_emisor}</td><td>${fila.cliente_nombre}</td><td>${fila.moneda} ${Number(fila.total).toFixed(2)}</td><td>${fila.fecha_emision}</td><td>${convertido}</td>`;
    tbody.appendChild(tr);
  }
  tablaHistorial.hidden = false;
}

function listarHistorial() {
  const resultado = db.exec('SELECT tipo, serie, numero, ruc_emisor, cliente_nombre, moneda, total, fecha_emision, fecha_conversion FROM conversiones ORDER BY id DESC');
  if (resultado.length === 0) {
    pintarTablaHistorial([]);
    return;
  }
  const columnas = resultado[0].columns;
  const filas = resultado[0].values.map((valores) => Object.fromEntries(columnas.map((col, i) => [col, valores[i]])));
  pintarTablaHistorial(filas);
}

document.getElementById('btn-historial').addEventListener('click', listarHistorial);

document.getElementById('form-xml').addEventListener('submit', async (evento) => {
  evento.preventDefault();
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

    // El PDF lo genera la API sin estado (reutiliza el motor Python probado).
    // Se envía el archivo original (XML o ZIP) tal cual; el logo va aparte.
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
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `${parsed.serie}-${parsed.numero}.pdf`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);

    await registrarConversion(parsed);

    mensajeXml.textContent = `PDF generado: ${parsed.serie}-${parsed.numero}.pdf`;
    evento.target.reset();
    if (!tablaHistorial.hidden) listarHistorial();
  } catch (err) {
    console.error(err);
    mensajeXml.textContent = `Error: ${err.message}`;
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => console.error('SW error:', err));
  });
}

intentarRestaurarSesionAnterior();
