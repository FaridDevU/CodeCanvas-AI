<div align="center">

# CodeCanvas AI

### Editor de código de escritorio con preview visual, terminal e IA, construido como fork de Visual Studio Code OSS.

</div>

---

## Qué es

CodeCanvas AI es un IDE de escritorio para desarrolladores frontend. Está basado
en un fork de [Visual Studio Code - Open Source ("Code - OSS")](https://github.com/microsoft/vscode),
sobre el que se construyen las funciones propias del proyecto: preview visual del
proyecto real, inspector y edición visual del DOM con diffs aprobados por el usuario,
y asistencia de IA a través de la terminal integrada (Claude Code, Codex, Gemini CLI).

La IA propone, no reemplaza: todo cambio importante pasa por un diff que el usuario
aprueba, con backup previo.

---

## Stack

| Capa            | Tecnología                          |
|-----------------|-------------------------------------|
| Base            | VS Code OSS (fork)                  |
| Lenguaje        | TypeScript (núcleo) + CSS           |
| Shell           | Electron                            |
| CLI / túneles   | Rust (`cli/`)                       |
| Editor          | Monaco (incluido en VS Code)        |
| Iconos          | Codicons (`@vscode/codicons`)       |

---

## Requisitos para compilar

VS Code se compila desde fuente; en Windows necesitas su toolchain:

- [Node.js](https://nodejs.org) (ver `.nvmrc`)
- Python 3
- Herramientas de build de C++ (Visual Studio Build Tools) para módulos nativos
- Git

---

## Desarrollo

```bash
npm install          # instala dependencias y compila módulos nativos
npm run watch        # compila en modo vigilancia (cliente + extensiones)
./scripts/code.bat   # lanza CodeCanvas AI (en Windows)
```

En macOS/Linux se lanza con `./scripts/code.sh`. Ver la documentación de
contribución de VS Code para el detalle del flujo de build.

---

## Roadmap

El proyecto se rebrandea y luego se le añaden funciones propias:

- [ ] Rebranding completo (nombre, iconos, telemetría desactivada)
- [ ] Preview visual del proyecto real
- [ ] Inspector y edición visual del DOM con diffs
- [ ] Integración del flujo de IA (vía terminal/CLIs) con bloqueo de elementos

---

## Licencia y atribución

CodeCanvas AI es un derivado de Visual Studio Code - Open Source ("Code - OSS"),
Copyright (c) Microsoft Corporation, distribuido bajo licencia MIT. Se conservan
`LICENSE.txt` y `ThirdPartyNotices.txt`. El código añadido por CodeCanvas AI se
distribuye igualmente bajo MIT.

Este proyecto no está afiliado ni respaldado por Microsoft.
