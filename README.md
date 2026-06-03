<div align="center">

# CodeCanvas AI

### IDE de escritorio para desarrolladores frontend: editor de código, preview visual del proyecto real, terminal e IA asistente, sin perder el control sobre el código.

</div>

---

## Por qué este proyecto

Las herramientas visuales (WordPress, Webflow, Framer) generan sitios desde
plantillas y ocultan el código. CodeCanvas AI hace lo contrario: trabaja sobre
proyectos y archivos reales, muestra la página renderizada y permite editarla
visualmente o con IA, pero **toda modificación pasa por un diff que el usuario
aprueba**, con backup previo. La IA asiste, no reemplaza.

---

## Stack

| Capa             | Tecnología                          |
|------------------|-------------------------------------|
| Shell escritorio | Electron 42                         |
| Frontend         | Angular 21 + TypeScript + Tailwind 4|
| Editor de código | Monaco Editor                       |
| Backend local    | .NET 10 (ASP.NET Core Web API)      |
| Terminal         | xterm.js (+ PTY real, fase futura)  |
| Iconos           | Lucide (via ng-icons)               |

---

## Requisitos previos

- [Node 22+](https://nodejs.org) (probado con Node 24)
- [.NET SDK 10](https://dotnet.microsoft.com/download)
- Git

---

## Instalación

```bash
git clone https://github.com/FaridDevU/CodeCanvas-AI.git
cd "CodeCanvas AI"
npm run install:all
```

`install:all` instala las dependencias de la raíz, de la app Angular y del shell
de Electron. El backend .NET restaura sus paquetes la primera vez que se compila.

---

## Uso

Levanta los tres runtimes (Angular + .NET + Electron) con un solo comando:

```bash
npm run dev
```

Esto arranca el servidor de desarrollo de Angular (`http://localhost:4200`),
abre la ventana de Electron y lanza el backend .NET (`http://localhost:5064`),
que Electron administra como proceso hijo. La ventana carga la UI y el panel
derecho permite comprobar la conexión con el backend.

> Si el puerto 4200 o 5064 estuviera ocupado, cierra el proceso que lo use
> antes de arrancar.

---

## API

El backend expone su documentación OpenAPI en desarrollo:

- OpenAPI JSON: `http://localhost:5064/openapi/v1.json`

| Método | Ruta        | Descripción                  | Auth |
|--------|-------------|------------------------------|------|
| GET    | /api/ping   | Estado de salud del backend  | No   |

Ejemplo de respuesta de `GET /api/ping`:

```json
{
  "status": "ok",
  "service": "CodeCanvas.LocalServer",
  "version": "1.0.0.0",
  "utcTime": "2026-06-03T23:26:53.97+00:00"
}
```

---

## Tests

```bash
npm run test:web        # Angular (Vitest)
npm run test:backend    # .NET (xUnit)
```

---

## Estructura del proyecto

```
.
├── apps/
│   ├── desktop/
│   │   ├── electron/   # main, preload, window-manager, backend-process
│   │   └── angular/    # UI: core/ layout/ features/
│   └── backend/
│       └── CodeCanvas.LocalServer/   # Controllers/ Services/ Models/
├── packages/           # shared-types, dom-inspector, ai-prompts, project-detector
├── docs/
└── README.md
```

---

## Roadmap

El proyecto se construye por fases. Estado actual:

- [x] **Fase 1 — Fundaciones:** la app arranca, los tres runtimes se comunican,
  layout IDE con paneles redimensionables.
- [ ] **Fase 2 — Abrir proyecto:** selector de carpeta, árbol de archivos,
  detección de tipo de proyecto.
- [ ] **Fase 3 — Editor Monaco:** abrir/editar/guardar archivos en pestañas.
- [ ] **Fase 4 — Preview web:** renderizar el proyecto real (fin del MVP).
- [ ] **Fases 5-8:** inspector del DOM, edición visual con diffs, terminal, IA.

---

## Licencia

Por definir.
