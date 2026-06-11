import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: '.',
  base: './',
  build: {
    outDir: '../resources/app/design-editor',
    emptyOutDir: true,
    rollupOptions: {
      input: './index.html',
    },
  },
  resolve: {
    // Array form so we can use regex for @onlook/ui's subpath export map.
    // Entries are matched in order; keep specific ones before general ones.
    alias: [
      // --- @onlook/ui subpath exports: "./*" -> ./src/components/*.tsx (+ special cases) ---
      { find: /^@onlook\/ui\/utils$/, replacement: path.resolve(__dirname, './packages/ui/src/utils/index.ts') },
      { find: /^@onlook\/ui\/hooks$/, replacement: path.resolve(__dirname, './packages/ui/src/hooks/index.ts') },
      { find: /^@onlook\/ui\/icons$/, replacement: path.resolve(__dirname, './packages/ui/src/components/icons/index.tsx') },
      { find: /^@onlook\/ui\/color-picker$/, replacement: path.resolve(__dirname, './packages/ui/src/components/color-picker/index.tsx') },
      { find: /^@onlook\/ui\/ai-elements$/, replacement: path.resolve(__dirname, './packages/ui/src/components/ai-elements/index.tsx') },
      { find: /^@onlook\/ui\/globals\.css$/, replacement: path.resolve(__dirname, './packages/ui/src/globals.css') },
      { find: /^@onlook\/ui\/tokens$/, replacement: path.resolve(__dirname, './packages/ui/tokens.ts') },
      { find: /^@onlook\/ui\/(.*)$/, replacement: path.resolve(__dirname, './packages/ui/src/components/$1') },
      { find: /^@onlook\/ui$/, replacement: path.resolve(__dirname, './packages/ui/src') },

      // --- Onlook internal packages (vendored under ./packages) ---
      // Deep "@onlook/<pkg>/src/..." imports map straight into the vendored src.
      { find: /^@onlook\/parser\/src\/(.*)$/, replacement: path.resolve(__dirname, './packages/parser/src/$1') },
      { find: /^@onlook\/utility\/src\/(.*)$/, replacement: path.resolve(__dirname, './packages/utility/src/$1') },
      { find: /^@onlook\/models\/src\/(.*)$/, replacement: path.resolve(__dirname, './packages/models/src/$1') },
      { find: '@onlook/models', replacement: path.resolve(__dirname, './packages/models/src') },
      { find: '@onlook/constants', replacement: path.resolve(__dirname, './packages/constants/src') },
      { find: '@onlook/utility', replacement: path.resolve(__dirname, './packages/utility/src') },
      { find: '@onlook/parser', replacement: path.resolve(__dirname, './packages/parser/src') },
      { find: '@onlook/penpal', replacement: path.resolve(__dirname, './packages/penpal/src') },
      { find: '@onlook/code-provider', replacement: path.resolve(__dirname, './packages/code-provider/src') },
      { find: '@onlook/file-system', replacement: path.resolve(__dirname, './packages/file-system/src') },
      { find: '@onlook/fonts', replacement: path.resolve(__dirname, './packages/fonts/src') },

      // --- Cloud/backend modules replaced by local stubs ---
      { find: /^@onlook\/db(\/.*)?$/, replacement: path.resolve(__dirname, './src/stubs/db.ts') },
      { find: '@onlook/git', replacement: path.resolve(__dirname, './src/stubs/git.ts') },
      { find: '@onlook/stripe', replacement: path.resolve(__dirname, './src/stubs/stripe.ts') },
      { find: /^@onlook\/ai(\/.*)?$/, replacement: path.resolve(__dirname, './src/stubs/onlook-ai.ts') },
      { find: /^@onlook\/email(\/.*)?$/, replacement: path.resolve(__dirname, './src/stubs/empty.ts') },
      { find: /^@codesandbox\/sdk(\/.*)?$/, replacement: path.resolve(__dirname, './src/stubs/codesandbox.ts') },
      { find: '@/trpc/client', replacement: path.resolve(__dirname, './src/stubs/trpc.ts') },
      { find: '@/trpc/react', replacement: path.resolve(__dirname, './src/stubs/trpc.ts') },
      { find: '@/env', replacement: path.resolve(__dirname, './src/stubs/env.ts') },
      { find: '@/utils/git', replacement: path.resolve(__dirname, './src/stubs/utils-git.ts') },
      { find: '@/hooks/use-font-loader', replacement: path.resolve(__dirname, './src/stubs/font-loader.ts') },
      { find: '@/hooks/use-create-blank-project', replacement: path.resolve(__dirname, './src/stubs/hooks.ts') },
      { find: '@/hooks/use-projects', replacement: path.resolve(__dirname, './src/stubs/hooks.ts') },
      { find: '@/hooks/use-auth', replacement: path.resolve(__dirname, './src/stubs/hooks.ts') },
      { find: '@/lib/utils', replacement: path.resolve(__dirname, './src/stubs/lib.ts') },

      // --- Next.js stubs ---
      { find: 'next/link', replacement: path.resolve(__dirname, './src/stubs/next/link.tsx') },
      { find: 'next/navigation', replacement: path.resolve(__dirname, './src/stubs/next/navigation.ts') },
      { find: 'next/image', replacement: path.resolve(__dirname, './src/stubs/next/image.tsx') },
      { find: 'next-intl', replacement: path.resolve(__dirname, './src/stubs/next-intl.ts') },
      { find: 'posthog-js/react', replacement: path.resolve(__dirname, './src/stubs/posthog.ts') },

      // --- Removed third-party deps ---
      { find: 'use-resize-observer', replacement: path.resolve(__dirname, './src/stubs/use-resize-observer.ts') },

      // --- Node builtins polyfilled for the browser ---
      { find: /^path$/, replacement: 'path-browserify' },
      { find: /^node:path$/, replacement: 'path-browserify' },

      // --- App source (general; must come LAST so specific @/ stubs win first) ---
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
});
