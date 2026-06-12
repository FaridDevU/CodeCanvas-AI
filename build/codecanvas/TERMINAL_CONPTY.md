# Terminal integrada en Windows — fix de `conpty.node`

## Síntoma

Al abrir la terminal integrada falla con:

```
The terminal process failed to launch: A native exception occurred during launch
(Failed to load native module: conpty.node ...)
```

## Causa

`node-pty` (el backend de la terminal) compila dos módulos nativos en Windows:
`conpty.node` y `conpty_console_list.node`. Su `binding.gyp` pide a MSVC las librerías de
runtime con **mitigación Spectre** (`'SpectreMitigation': 'Spectre'`).

Si en Visual Studio Build Tools **no** está instalado el componente
**"MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs"**, `npm rebuild node-pty` falla con
`MSB8040` y los `.node` nunca se generan, así que la terminal no arranca.

> **Mismo problema, otro módulo:** `native-is-elevated` (`iselevated.node`, el check de admin/UAC)
> tiene el mismo `SpectreMitigation` en su `binding.gyp` y falla igual (warning
> `Cannot find module './build/Release/iselevated'`). El script y el `postinstall` de abajo cubren
> **ambos** módulos nativos (node-pty + native-is-elevated) con la misma lógica.

> El parche temporal que vivía dentro de `node_modules/node-pty/binding.gyp` no es válido como
> solución: se pierde en cada `npm install`. Abajo están las dos formas correctas.

---

## Automático: `postinstall`

El `postinstall` del repo (`build/npm/postinstall.ts`) ya ejecuta el fix **automáticamente después
de cada `npm install`** en Windows (no-op en Linux/macOS). Normaliza `binding.gyp` y, **solo si
faltan** los binarios, recompila contra Electron. Es *best-effort*: **nunca rompe el install**; si
el rebuild falla, imprime una advertencia con el comando exacto de recuperación:

```
[node-pty] WARNING: integrated terminal not ready: ...
[node-pty] Fix it with:  npm run fix-terminal   (see build/codecanvas/TERMINAL_CONPTY.md)
```

Así, tras `npm install` el repo genera `conpty.node` automáticamente o avisa con el comando exacto.
Si necesitas forzar el rebuild manualmente (o el postinstall avisó), usa `npm run fix-terminal`.

---

## Opción A — Recomendada: instalar las librerías Spectre

Es la solución limpia, sin tocar `node-pty`.

1. Abre **Visual Studio Installer** → *Modify* en tus Build Tools 2022.
2. Pestaña **Individual components** → busca **"Spectre"**.
3. Marca **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs** (la versión que coincida con
   tu toolset MSVC v143) y, si usas ARM64, su variante.
4. Instala y luego:

```powershell
npm rebuild node-pty
```

Verifica que se generaron los binarios y que apuntan a Electron:

```powershell
node build/codecanvas/fix-node-pty.mjs --no-rebuild   # solo verifica/normaliza binding.gyp
```

(o revisa a mano `node_modules/node-pty/build/Release/conpty.node`,
`conpty_console_list.node` y `built_with_electron: 1` en
`node_modules/node-pty/build/config.gypi`).

---

## Opción B — Reproducible sin las librerías Spectre

Si no puedes instalar las librerías, usa el script versionado del repo
(`build/codecanvas/fix-node-pty.mjs`). Quita el flag `SpectreMitigation` del `binding.gyp` recién
instalado y recompila contra Electron. **No vive dentro de `node_modules`** y es idempotente.

Flujo reproducible desde cero:

```powershell
npm install
npm run fix-terminal
```

`npm run fix-terminal` ejecuta el script, que:

1. Quita `SpectreMitigation` de `node_modules/node-pty/binding.gyp` (si está).
2. Ejecuta `npm rebuild node-pty` (Electron, según `.npmrc`: `runtime=electron`,
   `target=<electron>`, `build_from_source=true`).
3. Verifica que existan `conpty.node` y `conpty_console_list.node` y que
   `config.gypi` tenga `"built_with_electron": 1`.

El script **no oculta** errores: si el rebuild falla, muestra la salida y recomienda la Opción A.

> Nota: el `postinstall` ya re-aplica esto automáticamente tras cada `npm install`. `npm run
> fix-terminal` queda como recuperación manual / uso en CI (modo estricto: sale con código ≠ 0 si
> falla). En el primer `npm install` desde cero sin prebuilds ni librerías Spectre, el build de
> node-pty durante el install puede fallar; vuelve a correr `npm install` (el postinstall recompila
> con el `binding.gyp` ya normalizado) o usa `npm run fix-terminal`.
