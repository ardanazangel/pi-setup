---
name: "capture-browser-console-via-cdp"
description: "Capturar errores/console reales del navegador (Next.js dev, runtime client) sin verlos a mano, vía Chrome headless + CDP por WebSocket en Node"
version: 1
created: "2026-06-18"
updated: "2026-06-18"
---
## When to Use
Cuando hay un error de runtime en el cliente (React/Next dev overlay, "Cannot read properties of undefined", etc.) y necesitas el STACK REAL (frames de la librería minificada) que el overlay no muestra del todo, o quieres verificar estado del DOM/JS tras montar. Node 22+ tiene WebSocket global, no hace falta dep.

## Procedure
1. Identificar el puerto del dev server (curl http://localhost:PORT/ruta y grep <title>).
2. Lanzar Chrome headless con debugging: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --disable-gpu --no-sandbox --remote-debugging-port=9222 about:blank & ; esperar 2s.
3. Abrir target nuevo apuntando a la URL: fetch('http://localhost:9222/json/new?URL',{method:'PUT'}) (OJO: /json/new requiere verbo PUT, no GET) → da webSocketDebuggerUrl.
4. Conectar new WebSocket(wsUrl); send Runtime.enable, Log.enable, Page.enable.
5. Escuchar Runtime.exceptionThrown (params.exceptionDetails.exception.description = stack completo), Runtime.consoleAPICalled (type error), Log.entryAdded.
6. Para inspeccionar estado: Runtime.evaluate con expression que devuelva JSON.stringify({...}) (returnByValue implícito vía .result.value).
7. setTimeout ~5-7s tras carga antes de leer (los useEffect/passive effects de React montan async).

## Pitfalls
- /json/new exige método PUT; con GET devuelve texto 'Using unsafe HTTP verb' que rompe el JSON.parse.
- Errores de WebGL en headless (three.js/r3f 'Error creating WebGL context') son ruido por no haber GPU, ignóralos.
- ScrollTrigger u otras libs NO están en window por defecto; verifica su efecto indirecto (p.ej. markers .gsap-marker-* en el DOM) en vez de window.ScrollTrigger.
- Espera a que monten los effects antes de evaluar; si lees demasiado pronto ves estado pre-mount.

## Verification
1. El stack de exceptionThrown apunta al frame real de la lib (no solo a tu línea), revelando la causa raíz.
2. Runtime.evaluate confirma el DOM/estado esperado tras el fix (ej. ausencia de exceptionThrown, presencia de elementos generados).