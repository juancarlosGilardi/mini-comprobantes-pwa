let SQL = null;
let db = null;
let fileHandle = null;

const estadoArchivo = document.getElementById('estado-archivo');
const seccionForm = document.getElementById('seccion-form');
const seccionLista = document.getElementById('seccion-lista');
const mensajeGuardado = document.getElementById('mensaje-guardado');
const tabla = document.getElementById('tabla-comprobantes');

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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => console.error('SW error:', err));
  });
}

intentarRestaurarSesionAnterior();
