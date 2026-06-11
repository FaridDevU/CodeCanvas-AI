/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reglas extraidas de stack-analyser (MIT). Solo datos declarativos; sin motor.
// https://github.com/stack-analyser/stack-analyser

export interface StackRule {
	readonly tech: string;
	readonly name: string;
	readonly dependencies: string[];
	readonly files: string[];
}

export const STACK_RULES: readonly StackRule[] = [
	// Frameworks
	{ tech: 'nextjs', name: 'Next.js', dependencies: ['next', '@netlify/plugin-nextjs'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
	{ tech: 'remixrun', name: 'Remix', dependencies: ['@remix-run/node', '@remix-run/serve'], files: [] },
	{ tech: 'nuxtjs', name: 'Nuxt.js', dependencies: ['nuxt', 'nuxt-edge', 'nuxt3'], files: ['nuxt.config.js'] },
	{ tech: 'sveltekit', name: 'SvelteKit', dependencies: ['@sveltejs/kit'], files: [] },
	{ tech: 'tanstackstart', name: 'Tanstack Start', dependencies: ['@tanstack/react-start'], files: [] },
	{ tech: 'redwoodjs', name: 'RedwoodJS', dependencies: ['@vercel/redwood', '@redwoodjs/api-server', '@redwoodjs/telemetry', '@redwoodjs/auth', '@redwoodjs/api', '@redwoodjs/core', '@redwoodjs/web', '@defer/redwood', 'inngest-setup-redwoodjs'], files: ['redwood.toml'] },
	{ tech: 'blitzjs', name: 'Blitz.js', dependencies: ['blitz'], files: [] },
	{ tech: 'astro', name: 'Astro', dependencies: ['astro'], files: ['astro.config.mjs', 'astro.config.ts'] },

	// Builders
	{ tech: 'vite', name: 'Vite', dependencies: ['vite'], files: [] },
	{ tech: 'webpack', name: 'Webpack', dependencies: ['webpack'], files: [] },
	{ tech: 'rspack', name: 'Rspack', dependencies: ['rspack', '@rspack/core'], files: ['rspack.config.js'] },
	{ tech: 'parcel', name: 'Parcel', dependencies: ['parcel'], files: [] },
	{ tech: 'esbuild', name: 'ESBuild', dependencies: ['esbuild'], files: [] },
	{ tech: 'rollup', name: 'Rollup', dependencies: ['rollup'], files: [] },
	{ tech: 'turborepo', name: 'Turborepo', dependencies: ['turbo'], files: [] },

	// UI / libs
	{ tech: 'react', name: 'React', dependencies: ['react'], files: [] },
	{ tech: 'tailwind', name: 'Tailwind CSS', dependencies: ['tailwindcss'], files: ['tailwind.config.js', 'tailwind.config.ts'] },
	{ tech: 'vue', name: 'Vue', dependencies: ['vue'], files: [] },
	{ tech: 'svelte', name: 'Svelte', dependencies: ['svelte'], files: [] },
	{ tech: 'angular', name: 'Angular', dependencies: ['@angular/core'], files: [] },

	// CRA (no tiene regla propia en stack-analyser; se detecta por react-scripts)
	{ tech: 'cra', name: 'Create React App', dependencies: ['react-scripts'], files: [] },
];
