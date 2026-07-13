// URL de la API que genera el PDF (endpoint sin estado /api/pwa/pdf).
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8850'
  : 'https://facturas-boletas.192.64.87.241.nip.io';

const $ = (id) => document.getElementById(id);
const TIPO_BADGE = { '01': 'b-01', '03': 'b-03', '07': 'b-07', '08': 'b-08' };
const TIPO_CORTO = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de Crédito', '08': 'Nota de Débito' };

let SQL = null;
let db = null;

// ═══════════ Persistencia (IndexedDB, en el disco del equipo) ═══════════
const IDB_NAME = 'mini-comprobantes', IDB_STORE = 'kv', DB_KEY = 'sqlite-db';

function abrirIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function idbGet(k) { return abrirIdb().then((d) => new Promise((res, rej) => { const t = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(k); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); })); }
function idbPut(k, v) { return abrirIdb().then((d) => new Promise((res, rej) => { const tx = d.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }

function crearTablas() {
  db.run(`CREATE TABLE IF NOT EXISTS logos (ruc TEXT PRIMARY KEY, png_blob BLOB NOT NULL, actualizado TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS conversiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, tipo_cod TEXT, serie TEXT, numero TEXT,
    ruc_emisor TEXT, razon_social_emisor TEXT, cliente_doc TEXT, cliente_nombre TEXT,
    moneda TEXT, total REAL, fecha_emision TEXT, fecha_conversion TEXT, pdf_blob BLOB)`);
  for (const col of ['pdf_blob BLOB', 'tipo_cod TEXT']) {
    try { db.run(`ALTER TABLE conversiones ADD COLUMN ${col}`); } catch (_) {}
  }
}
async function persistir() { await idbPut(DB_KEY, db.export()); }

async function inicializar() {
  SQL = await initSqlJs({ locateFile: () => 'sql-wasm.wasm' });
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (_) {} }
  const bytes = await idbGet(DB_KEY);
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  crearTablas();
  if (!bytes) await persistir();
  refrescarTodo();
  router();
}

// ═══════════ Helpers ═══════════
function filasDe(sql, params = []) {
  const r = db.exec(sql, params);
  if (!r.length) return [];
  return r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]])));
}
function numFmt(n, d = 2) { return Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function money(n) { return 'S/ ' + numFmt(n); }
// Comprobantes convertidos antes de guardar tipo_cod no tienen código; se
// infiere del texto completo que sí quedó guardado, para no dejarlos sin badge.
const TIPO_TEXTO_A_COD = { 'FACTURA ELECTRÓNICA': '01', 'BOLETA DE VENTA ELECTRÓNICA': '03', 'NOTA DE CRÉDITO ELECTRÓNICA': '07', 'NOTA DE DÉBITO ELECTRÓNICA': '08' };
function codDeTipo(cod, textoCompleto) { return cod || TIPO_TEXTO_A_COD[(textoCompleto || '').toUpperCase()] || ''; }
function badge(cod, textoCompleto) {
  const c = codDeTipo(cod, textoCompleto);
  return `<span class="badge ${TIPO_BADGE[c] || 'b-def'}">${TIPO_CORTO[c] || textoCompleto || '—'}</span>`;
}
function fechaPe(f) { return (f && f.length === 10 && f[4] === '-') ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : (f || ''); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function toast(msg, tipo = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + tipo;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = 'all .3s'; setTimeout(() => el.remove(), 300); }, 3200);
}

// ═══════════ Render ═══════════
function refrescarTodo() { dashboard(); listarHistorial(); listarEmpresas(); }

function dashboard() {
  const r = filasDe('SELECT COUNT(*) n, COALESCE(SUM(total),0) s, MAX(fecha_conversion) u, COUNT(DISTINCT ruc_emisor) e FROM conversiones')[0];
  $('s-total').textContent = r.n;
  $('s-monto').textContent = money(r.s);
  $('s-empresas').textContent = r.e;
  $('s-ultimo').textContent = r.u ? r.u.slice(0, 10) : '—';
  pintarTabla($('tabla-recientes'), $('recientes-vacio'),
    filasDe('SELECT id, tipo, tipo_cod, serie, numero, cliente_nombre, total FROM conversiones ORDER BY id DESC LIMIT 5'),
    (f) => `<td>${badge(f.tipo_cod, f.tipo)}</td><td><strong>${esc(f.serie)}-${esc(f.numero)}</strong></td><td>${esc(f.cliente_nombre)}</td><td class="r">${money(f.total)}</td><td class="td-ver">Ver ›</td>`);
}

// Comprobantes: agrupados por empresa emisora, con una fila de "quiebre" (separador)
// entre cada RUC distinto, para que sea fácil ver a qué empresa pertenece cada uno.
const COLS_HISTORIAL = 8;
function listarHistorial(filtro = '') {
  let sql = `SELECT id, tipo, tipo_cod, serie, numero, ruc_emisor, razon_social_emisor, cliente_doc, cliente_nombre, moneda, total, fecha_emision FROM conversiones`;
  const p = [];
  if (filtro) { sql += ' WHERE serie LIKE ? OR numero LIKE ? OR ruc_emisor LIKE ? OR cliente_nombre LIKE ? OR cliente_doc LIKE ?'; const l = `%${filtro}%`; p.push(l, l, l, l, l); }
  sql += ' ORDER BY ruc_emisor, id DESC';
  const filas = filasDe(sql, p);

  const tabla = $('tabla-historial'), vacio = $('historial-vacio');
  const tb = tabla.querySelector('tbody');
  tb.innerHTML = '';
  if (!filas.length) {
    tabla.hidden = true; vacio.hidden = false;
    vacio.textContent = filtro ? 'Sin resultados para tu búsqueda.' : 'Aún no has convertido ningún comprobante.';
    return;
  }
  let rucAnterior = null;
  for (const f of filas) {
    if (f.ruc_emisor !== rucAnterior) {
      rucAnterior = f.ruc_emisor;
      const trq = document.createElement('tr');
      trq.className = 'quiebre';
      trq.innerHTML = `<td colspan="${COLS_HISTORIAL}">${esc(f.razon_social_emisor || 'Sin razón social')} <span class="quiebre-ruc">RUC ${esc(f.ruc_emisor || '—')}</span></td>`;
      tb.appendChild(trq);
    }
    const tr = document.createElement('tr');
    tr.dataset.id = f.id;
    tr.innerHTML = `<td>${badge(f.tipo_cod, f.tipo)}</td><td><strong>${esc(f.serie)}-${esc(f.numero)}</strong></td><td>${esc(f.ruc_emisor)}</td><td>${esc(f.cliente_doc)}</td><td class="td-cliente" title="${esc(f.cliente_nombre)}">${esc(f.cliente_nombre)}</td><td class="r">${esc(f.moneda)} ${numFmt(f.total)}</td><td>${fechaPe(f.fecha_emision)}</td><td class="td-ver">Ver PDF ›</td>`;
    tb.appendChild(tr);
  }
  tabla.hidden = false; vacio.hidden = true;
}

function pintarTabla(tabla, vacio, filas, rowHtml, filtro) {
  const tb = tabla.querySelector('tbody');
  tb.innerHTML = '';
  if (!filas.length) {
    tabla.hidden = true; vacio.hidden = false;
    if (filtro !== undefined) vacio.textContent = filtro ? 'Sin resultados para tu búsqueda.' : 'Aún no has convertido ningún comprobante.';
    return;
  }
  for (const f of filas) { const tr = document.createElement('tr'); tr.dataset.id = f.id; tr.innerHTML = rowHtml(f); tb.appendChild(tr); }
  tabla.hidden = false; vacio.hidden = true;
}

// ═══════════ Empresas y logos ═══════════
let empresaUrls = [];
function listarEmpresas() {
  empresaUrls.forEach(URL.revokeObjectURL); empresaUrls = [];
  const filas = filasDe(`SELECT ruc_emisor ruc, MAX(razon_social_emisor) razon, COUNT(*) n, COALESCE(SUM(total),0) total,
    (SELECT COUNT(*) FROM logos l WHERE l.ruc = c.ruc_emisor) tiene_logo
    FROM conversiones c WHERE ruc_emisor <> '' GROUP BY ruc_emisor ORDER BY n DESC`);
  const cont = $('empresas'), vacio = $('empresas-vacio');
  cont.innerHTML = '';
  if (!filas.length) { vacio.hidden = false; return; }
  vacio.hidden = true;
  for (const f of filas) {
    let logoHtml = `<div class="empresa-logo ph"><svg class="ic"><use href="#i-building"/></svg></div>`;
    if (f.tiene_logo) {
      const bytes = obtenerLogoPorRuc(f.ruc);
      if (bytes) { const u = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); empresaUrls.push(u); logoHtml = `<img class="empresa-logo" src="${u}" alt="">`; }
    }
    const card = document.createElement('div');
    card.className = 'empresa';
    card.innerHTML = `<div class="empresa-top">${logoHtml}
      <div class="empresa-info"><div class="empresa-nombre">${esc(f.razon || 'Sin razón social')}</div>
      <div class="empresa-ruc">RUC ${esc(f.ruc)}</div></div></div>
      <div class="empresa-meta">${f.n} comprobante${f.n === 1 ? '' : 's'} · ${money(f.total)}</div>
      <div class="empresa-acc">
        <button class="btn btn-ghost" data-logo="${esc(f.ruc)}"><svg class="ic"><use href="#i-image"/></svg>${f.tiene_logo ? 'Cambiar logo' : 'Agregar logo'}</button>
        ${f.tiene_logo ? `<button class="btn btn-danger-ghost" data-quitar="${esc(f.ruc)}">Quitar</button>` : ''}
      </div>`;
    cont.appendChild(card);
  }
}

let rucEditandoLogo = null;
$('empresas').addEventListener('click', (e) => {
  const cambiar = e.target.closest('[data-logo]');
  const quitar = e.target.closest('[data-quitar]');
  if (cambiar) { rucEditandoLogo = cambiar.dataset.logo; $('in-logo-empresa').click(); }
  if (quitar) {
    db.run('DELETE FROM logos WHERE ruc = ?', [quitar.dataset.quitar]);
    persistir().then(() => { listarEmpresas(); toast('Logo quitado.'); });
  }
});
$('in-logo-empresa').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !rucEditandoLogo) return;
  try {
    const png = await imagenArchivoAPngBytes(file);
    guardarLogoPorRuc(rucEditandoLogo, png);
    await persistir();
    listarEmpresas();
    toast('Logo actualizado para el RUC ' + rucEditandoLogo, 'ok');
  } catch (_) { toast('No pude leer esa imagen.', 'err'); }
  rucEditandoLogo = null;
});

// ═══════════ Logo por RUC (reemplaza siempre) ═══════════
function obtenerLogoPorRuc(ruc) {
  const r = db.exec('SELECT png_blob FROM logos WHERE ruc = ?', [ruc]);
  return (r.length && r[0].values.length) ? new Uint8Array(r[0].values[0][0]) : null;
}
function guardarLogoPorRuc(ruc, png) {
  db.run('INSERT INTO logos (ruc, png_blob, actualizado) VALUES (?,?,?) ON CONFLICT(ruc) DO UPDATE SET png_blob=excluded.png_blob, actualizado=excluded.actualizado', [ruc, png, new Date().toISOString()]);
}

// ═══════════ Archivos ═══════════
async function leerXmlDesdeArchivo(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const esZip = file.name.toLowerCase().endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (esZip) {
    const ents = fflate.unzipSync(bytes);
    const nom = Object.keys(ents).find((n) => n.toLowerCase().endsWith('.xml'));
    if (!nom) throw new Error('El ZIP no contiene ningún .xml.');
    return new TextDecoder('utf-8').decode(ents[nom]);
  }
  return new TextDecoder('utf-8').decode(bytes);
}
async function imagenArchivoAPngBytes(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const b64 = c.toDataURL('image/png').split(',')[1];
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function registrarConversion(parsed, pdfBytes) {
  const em = parsed.emisor || {}, cl = parsed.cliente || {};
  db.run(`INSERT INTO conversiones (tipo, tipo_cod, serie, numero, ruc_emisor, razon_social_emisor, cliente_doc, cliente_nombre, moneda, total, fecha_emision, fecha_conversion, pdf_blob)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    parsed.tipo_desc || parsed.tipo || '', parsed.tipo || '', parsed.serie || '', parsed.numero || '',
    em.ruc || '', em.nombre || em.nombre_comercial || '', cl.doc || '', cl.nombre || '',
    parsed.moneda || '', Number(parsed.total) || 0, parsed.fecha || '', new Date().toISOString(), pdfBytes]);
}
function descargarBlob(blob, nombre) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
}

// ═══════════ Generar 1 PDF vía API ═══════════
async function generarPdf(xmlFile, logoOverride) {
  const xmlTexto = await leerXmlDesdeArchivo(xmlFile);
  const parsed = ublParser.parsearXmlTexto(xmlTexto);
  if (!parsed.ok) throw new Error(parsed.error || 'XML no válido.');
  const ruc = (parsed.emisor && parsed.emisor.ruc) || '';
  let logo = null;
  if (logoOverride) { logo = logoOverride; if (ruc) guardarLogoPorRuc(ruc, logo); }
  else if (ruc) logo = obtenerLogoPorRuc(ruc);

  const fd = new FormData();
  fd.append('xml', xmlFile, xmlFile.name);
  if (logo) fd.append('logo', new Blob([logo], { type: 'image/png' }), 'logo.png');
  const resp = await fetch(`${API_BASE}/api/pwa/pdf`, { method: 'POST', body: fd });
  if (!resp.ok) {
    let d = `La API respondió ${resp.status}.`;
    try { const j = await resp.json(); if (j.detail) d = j.detail; } catch (_) {}
    throw new Error(d);
  }
  const pdfBytes = new Uint8Array(await resp.arrayBuffer());
  registrarConversion(parsed, pdfBytes);
  return { parsed, pdfBytes };
}

// ═══════════ Procesar archivos (1 o lote) ═══════════
async function procesarArchivos(fileList) {
  const archivos = Array.from(fileList).filter((f) => /\.(xml|zip)$/i.test(f.name));
  if (!archivos.length) { toast('No encontré archivos XML o ZIP.', 'err'); return; }

  const logoFile = $('in-logo').files[0];
  const logoOverride = logoFile ? await imagenArchivoAPngBytes(logoFile).catch(() => null) : null;

  const proceso = $('proceso'), log = $('proceso-log'), barFill = $('bar-fill'), txt = $('proceso-txt'), btnZip = $('btn-zip');
  proceso.hidden = false; log.innerHTML = ''; barFill.style.width = '0'; btnZip.hidden = true;

  const generados = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < archivos.length; i++) {
    const f = archivos[i];
    txt.textContent = `Procesando ${i + 1} de ${archivos.length}…`;
    try {
      const { parsed, pdfBytes } = await generarPdf(f, logoOverride);
      const nombre = `${parsed.serie}-${parsed.numero}.pdf`;
      generados.push({ nombre, pdfBytes, parsed });
      ok++;
      log.insertAdjacentHTML('beforeend', `<li><svg class="ic ok"><use href="#i-doc"/></svg><span class="tag-min">${esc(nombre)}</span> · ${esc(parsed.emisor.nombre || '')}</li>`);
    } catch (err) {
      fail++;
      log.insertAdjacentHTML('beforeend', `<li><svg class="ic err"><use href="#i-close"/></svg><span class="err">${esc(f.name)}</span> — ${esc(err.message)}</li>`);
    }
    barFill.style.width = `${Math.round(((i + 1) / archivos.length) * 100)}%`;
  }

  await persistir();
  refrescarTodo();
  txt.textContent = `Listo: ${ok} convertido${ok === 1 ? '' : 's'}${fail ? `, ${fail} con error` : ''}.`;

  if (generados.length === 1) {
    // Uno solo: abre el PDF listo para imprimir.
    const g = generados[0];
    mostrarPdf(g.pdfBytes, `${g.parsed.serie}-${g.parsed.numero}`, g.nombre, true);
    toast('PDF generado.', 'ok');
  } else if (generados.length > 1) {
    btnZip.hidden = false;
    btnZip.onclick = () => {
      const zipObj = {};
      for (const g of generados) zipObj[g.nombre] = g.pdfBytes;
      const zipped = fflate.zipSync(zipObj);
      descargarBlob(new Blob([zipped], { type: 'application/zip' }), `comprobantes-${new Date().toISOString().slice(0, 10)}.zip`);
    };
    toast(`${ok} comprobantes convertidos.`, 'ok');
  }
  // limpia el input de logo para que no se reaplique sin querer
  $('in-logo').value = '';
}

// ── Entradas de archivo / dropzone ──
$('btn-files').addEventListener('click', () => $('in-files').click());
$('btn-folder').addEventListener('click', () => $('in-folder').click());
$('in-files').addEventListener('change', (e) => { if (e.target.files.length) procesarArchivos(e.target.files); e.target.value = ''; });
$('in-folder').addEventListener('change', (e) => { if (e.target.files.length) procesarArchivos(e.target.files); e.target.value = ''; });

const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('drag'); }));
dz.addEventListener('drop', async (e) => {
  const items = e.dataTransfer.items;
  let files = [];
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = Array.from(items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
    for (const en of entries) files = files.concat(await leerEntry(en));
  } else {
    files = Array.from(e.dataTransfer.files);
  }
  if (files.length) procesarArchivos(files);
});
// Lee recursivamente un directorio soltado en la zona.
function leerEntry(entry) {
  return new Promise((resolve) => {
    if (entry.isFile) { entry.file((f) => resolve([f]), () => resolve([])); }
    else if (entry.isDirectory) {
      const rd = entry.createReader(); let all = [];
      const leer = () => rd.readEntries(async (ents) => {
        if (!ents.length) { const res = await Promise.all(all.map(leerEntry)); resolve(res.flat()); return; }
        all = all.concat(ents); leer();
      }, () => resolve([]));
      leer();
    } else resolve([]);
  });
}

// ═══════════ Visor de PDF ═══════════
let visorUrl = null, visorBytes = null, visorNombre = 'comprobante.pdf';
function mostrarPdf(bytes, titulo, nombre, autoImprimir) {
  const frame = $('visor-frame');
  if (visorUrl) URL.revokeObjectURL(visorUrl);
  visorUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  visorBytes = bytes; visorNombre = nombre;
  $('visor-titulo').textContent = titulo;
  frame.onload = () => { if (autoImprimir) { try { frame.contentWindow.print(); } catch (_) {} } };
  frame.src = visorUrl;
  $('visor').hidden = false;
}
function cerrarVisor() { $('visor').hidden = true; const f = $('visor-frame'); f.onload = null; f.src = 'about:blank'; if (visorUrl) { URL.revokeObjectURL(visorUrl); visorUrl = null; } }
$('visor-cerrar').addEventListener('click', cerrarVisor);
$('visor-imprimir').addEventListener('click', () => { try { $('visor-frame').contentWindow.print(); } catch (_) {} });
$('visor-descargar').addEventListener('click', () => { if (visorBytes) descargarBlob(new Blob([visorBytes], { type: 'application/pdf' }), visorNombre); });

function verPdfDeConversion(id) {
  const r = db.exec('SELECT serie, numero, pdf_blob FROM conversiones WHERE id = ?', [id]);
  if (!r.length || !r[0].values.length) return;
  const [serie, numero, blob] = r[0].values[0];
  if (!blob) { toast('Este comprobante se registró antes de guardar el PDF. Vuelve a convertir su XML.', 'err'); return; }
  mostrarPdf(new Uint8Array(blob), `${serie}-${numero}`, `${serie}-${numero}.pdf`, false);
}
[$('tabla-historial'), $('tabla-recientes')].forEach((t) => t.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]'); if (tr) verPdfDeConversion(Number(tr.dataset.id));
}));

// ═══════════ Búsqueda ═══════════
$('buscar').addEventListener('input', (e) => listarHistorial(e.target.value.trim()));

// ═══════════ Respaldo ═══════════
$('btn-exportar').addEventListener('click', () => descargarBlob(new Blob([db.export()], { type: 'application/x-sqlite3' }), `comprobantes-${new Date().toISOString().slice(0, 10)}.sqlite`));
$('btn-importar').addEventListener('click', () => $('in-importar').click());
$('in-importar').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prueba = new SQL.Database(bytes);
    prueba.exec('SELECT 1 FROM conversiones LIMIT 1');
    db = prueba; crearTablas(); await persistir(); refrescarTodo();
    toast('Copia importada correctamente.', 'ok');
  } catch (_) { toast('Ese archivo no es una copia válida de esta app.', 'err'); }
});

// ═══════════ Routing / sidebar ═══════════
const VISTAS = {
  dashboard: ['v-dashboard', 'Dashboard'],
  convertir: ['v-convertir', 'Convertir'],
  comprobantes: ['v-comprobantes', 'Comprobantes'],
  empresas: ['v-empresas', 'Empresas y logos'],
  respaldo: ['v-respaldo', 'Respaldo'],
};
function router() {
  const clave = (location.hash.replace('#', '') || 'dashboard');
  const [vistaId, titulo] = VISTAS[clave] || VISTAS.dashboard;
  Object.values(VISTAS).forEach(([id]) => { $(id).hidden = true; });
  $(vistaId).hidden = false;
  $('titulo-vista').textContent = titulo;
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${clave}`));
  if (clave === 'comprobantes') listarHistorial($('buscar').value.trim());
  if (clave === 'empresas') listarEmpresas();
  // El sidebar completo solo se ve en el Dashboard; en el resto se colapsa
  // y queda accesible con el botón de hamburguesa (más espacio para tablas).
  const app = document.querySelector('.app');
  app.classList.toggle('sidebar-collapsed', clave !== 'dashboard');
  app.classList.remove('nav-open'); // cierra el overlay si estaba abierto
}
window.addEventListener('hashchange', router);

// Menú móvil
$('btn-menu').addEventListener('click', () => document.querySelector('.app').classList.toggle('nav-open'));
$('scrim').addEventListener('click', () => document.querySelector('.app').classList.remove('nav-open'));

// ═══════════ Service worker + arranque ═══════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch((e) => console.error('SW', e)));
}
inicializar().catch((err) => { console.error(err); toast('No se pudo iniciar la base local: ' + err.message, 'err'); });
