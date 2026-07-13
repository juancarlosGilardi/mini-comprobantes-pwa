"""Servidor estático de prueba local para el PoC (no es parte de la PWA)."""
import http.server
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

Handler = http.server.SimpleHTTPRequestHandler
Handler.extensions_map.update({
    ".js": "text/javascript",
    ".wasm": "application/wasm",
})

http.server.test(HandlerClass=Handler, port=8851, bind="127.0.0.1")
