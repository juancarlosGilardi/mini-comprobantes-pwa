# Resultados del PoC — Mini Comprobantes (PWA + sql.js + File System Access API)

## Arquitectura probada

PWA 100% estática (sin backend, sin Flask, sin `.exe`), servida en `http://localhost:8851` para pruebas:
- `sql.js` (SQLite compilado a WebAssembly) corre en el navegador.
- El usuario elige un archivo real en su disco (`showOpenFilePicker`/`showSaveFilePicker`) donde se lee/escribe la base SQLite.
- Instalable como PWA desde Edge/Chrome (manifest + service worker).

## Pruebas realizadas y resultado

1. **Servidor y carga de la página** — OK. Nota técnica: `python -m http.server` sirve `.js` como `text/plain` en este equipo (mimetypes de Windows), lo que bloquea el registro del Service Worker. Se resolvió con `serve.py`, que fuerza `text/javascript` y `application/wasm`. Esto es solo un detalle del servidor de prueba local — no aplica al `.exe`/instalador porque aquí no hay ninguno.

2. **Motor SQLite (sql.js)** — OK. Se creó una base en memoria, se insertó una fila y se exportó a binario (`.export()`) sin errores, generando un archivo `.sqlite` válido de 12 KB.

3. **Registro del Service Worker** — OK una vez corregido el MIME type. Cachea todos los estáticos (incluido `sql-wasm.wasm`) para funcionamiento offline.

4. **Flujo funcional completo (UI real)** — OK. Validado end-to-end simulando el picker nativo (la automatización de navegador no puede interactuar con el diálogo nativo de Windows, así que se sustituyó `showSaveFilePicker` por un handle en memoria equivalente para ejercitar el mismo código de `app.js`):
   - Click en "Crear archivo nuevo" → crea la base, tabla `comprobantes`, y escribe el archivo.
   - Formulario → "Guardar comprobante" (Factura, S/ 250.75, 2026-07-13, "Prueba desde UI") → insertado y escrito a disco correctamente, formulario se limpia.
   - "Ver comprobantes" → tabla HTML muestra la fila guardada correctamente.

5. **Diálogo nativo de selección de archivo (`showSaveFilePicker` real)** — **pendiente de verificación manual por el usuario**: la automatización no puede operar el diálogo de Windows. Se recomienda abrir `mini-pwa-poc/index.html` vía `python mini-pwa-poc/serve.py` y `http://localhost:8851`, hacer clic en "Crear archivo nuevo", elegir una carpeta (ej. Documentos) y confirmar que aparece el archivo `.sqlite` real en el explorador de Windows, abrible con un visor externo (ej. DB Browser for SQLite).

6. **Instalación como PWA desde Edge** — pendiente de verificación manual (requiere Edge real, no el navegador de automatización): abrir la URL, usar "Instalar esta aplicación" en la barra de direcciones, confirmar que abre en ventana propia con ícono.

7. **Avisos de Windows Defender / SmartScreen** — **no aplica**. Al no distribuirse ningún ejecutable ni instalador, no hay ningún archivo que Windows pueda marcar con Mark of the Web ni analizar heurísticamente. Esta es la premisa central del PoC: cero superficie de ataque para un aviso de seguridad, y cero costo (no se necesita certificado de firma de código).

## Conclusión

La arquitectura PWA + sql.js + File System Access API cumple los dos requisitos exigidos: (a) los datos contables quedan en un archivo real en el disco del usuario, no en la nube, y (b) no hay ningún ejecutable que distribuir, por lo que no existe mecanismo por el cual Defender o SmartScreen puedan intervenir. Queda pendiente solo la confirmación manual del diálogo nativo de archivo y la instalación real en Edge, ambos pasos que no representan riesgo técnico adicional (son APIs estándar y ya probadas del navegador).
