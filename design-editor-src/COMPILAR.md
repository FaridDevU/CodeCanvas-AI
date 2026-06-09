# Instrucciones de compilación — CodeCanvas Design Editor

> **Ubicación**: `src/vs/codecanvas/browser/parts/design/onlook-ui/`
> **Estado**: Listo para compilar (stubs creados, config lista)
> **Dependencias**: Node.js + npm (en tu entorno local, no en Kimi shell)

---

## 🚀 Pasos para compilar

### 1. Abrir terminal en tu máquina

```bash
cd "C:\Users\lokih\Desktop\CodeCanvas AI\src\vs\codecanvas\browser\parts\design\onlook-ui"
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Compilar bundle

```bash
npm run build
```

Esto generará:
- `resources/app/design-editor/index.html`
- `resources/app/design-editor/assets/...`

### 4. Compilar CodeCanvas

```bash
cd "C:\Users\lokih\Desktop\CodeCanvas AI"
npm run compile-client
```

### 5. Lanzar CodeCanvas

```bash
cd "C:\Users\lokih\Desktop\CodeCanvas AI"
cmd /c "set VSCODE_DEV=1 && set NODE_ENV=development && start "" .build\electron\CodeCanvas AI.exe --no-sandbox ."
```

---

## 🔧 Stubs creados (resuelven imports problemáticos)

| Import original | Stub | Ubicación |
|----------------|------|-----------|
| `next/link` | `<a>` tag | `src/stubs/next/link.tsx` |
| `next/navigation` | `useRouter()` mock | `src/stubs/next/navigation.ts` |
| `next/image` | `<img>` tag | `src/stubs/next/image.tsx` |
| `next-intl` | `useTranslations()` mock | `src/stubs/next-intl.ts` |
| `posthog-js/react` | `usePostHog()` mock | `src/stubs/posthog.ts` |
| `@/components/store/editor` | `useEditorEngine()` mock | `src/stubs/store.ts` |
| `@/hooks/*` | Hooks mock | `src/stubs/hooks.ts` |
| `@/lib/utils` | `cn()` utility | `src/stubs/lib.ts` |

---

## ⚠️ Errores esperados (y cómo resolverlos)

### Error 1: "Cannot find module '@/components/store/editor/..."
**Solución**: Añadir alias en `vite.config.ts` apuntando a `src/stubs/store.ts`

### Error 2: "Cannot find module 'some-dependency'"
**Solución**: `npm install some-dependency`

### Error 3: "Property X does not exist on type Y" (TypeScript)
**Solución**: Añadir `// @ts-ignore` o actualizar stub

### Error 4: "@onlook/models" exporta dependencias cloud
**Solución**: Crear `packages/models/src/index-local.ts` que solo exporte tipos locales

---

## 📋 Si la compilación falla

1. **Copiar el error completo** (mensaje + archivo + línea)
2. **Pegarlo aquí** y lo arreglo
3. **Repetir** hasta que compile

---

## 🎯 Qué verás si funciona

1. Abres CodeCanvas
2. Click en icono 🎨 (Design)
3. Se abre panel con:
   - TopBar (device toggles, preview button)
   - LeftPanel (tabs: Layers, Components, Images, Settings)
   - Canvas (área gris con grid, iframe vacío)
   - RightPanel (tabs: Properties, Styles, Layout, Text)
   - BottomBar (zoom, status, git branch)

---

*Documento generado tras preparar stubs, config y componentes wrapper para compilación.*
