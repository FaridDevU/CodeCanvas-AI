// Sync the Design editor's color tokens with CodeCanvas's active VS Code theme.
// The Design bundle runs in a same-origin iframe inside the workbench, so it can read the
// workbench's `--vscode-*` CSS variables and map them onto Onlook's design tokens. This makes
// the editor match the rest of the app exactly, and follow theme changes automatically.
// When there is no workbench parent (e.g. the standalone dev server), the bundled defaults stay.

type RGB = { r: number; g: number; b: number };

function parseColor(value: string): RGB | null {
	const v = (value || '').trim();
	if (!v) return null;
	if (v.startsWith('#')) {
		let hex = v.slice(1);
		if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
		if (hex.length < 6) return null;
		return {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16),
		};
	}
	const m = v.match(/rgba?\(([^)]+)\)/i);
	if (m) {
		const parts = m[1].split(',').map((s) => parseFloat(s));
		if (parts.length >= 3) {
			return { r: parts[0], g: parts[1], b: parts[2] };
		}
	}
	return null;
}

function toHslComponents(rgb: RGB): string {
	const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0, s = 0;
	const d = max - min;
	if (d !== 0) {
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r: h = (g - b) / d + (g < b ? 6 : 0); break;
			case g: h = (b - r) / d + 2; break;
			default: h = (r - g) / d + 4; break;
		}
		h *= 60;
	}
	return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

// Onlook tokens consumed as `hsl(var(--token))` -> the VS Code variable to derive them from.
const HSL_MAP: Record<string, string> = {
	'--background': '--vscode-editor-background',
	'--background-onlook': '--vscode-editor-background',
	'--background-primary': '--vscode-sideBar-background',
	'--background-secondary': '--vscode-editorWidget-background',
	'--background-hover': '--vscode-list-hoverBackground',
	'--background-active': '--vscode-list-activeSelectionBackground',
	'--foreground': '--vscode-foreground',
	'--foreground-primary': '--vscode-foreground',
	'--foreground-secondary': '--vscode-descriptionForeground',
	'--foreground-tertiary': '--vscode-descriptionForeground',
	'--foreground-onlook': '--vscode-descriptionForeground',
	'--card': '--vscode-editorWidget-background',
	'--card-foreground': '--vscode-foreground',
	'--popover': '--vscode-menu-background',
	'--popover-foreground': '--vscode-menu-foreground',
	'--secondary': '--vscode-button-secondaryBackground',
	'--secondary-foreground': '--vscode-button-secondaryForeground',
	'--muted': '--vscode-input-background',
	'--muted-foreground': '--vscode-descriptionForeground',
	'--accent': '--vscode-list-hoverBackground',
	'--accent-foreground': '--vscode-foreground',
	'--input': '--vscode-input-background',
	'--border': '--vscode-widget-border',
	'--primary': '--vscode-button-background',
	'--primary-foreground': '--vscode-button-foreground',
	'--ring': '--vscode-focusBorder',
};

// Onlook tokens consumed directly as `var(--token)` (already full colors).
const COLOR_MAP: Record<string, string> = {
	'--sidebar': '--vscode-sideBar-background',
	'--sidebar-foreground': '--vscode-sideBar-foreground',
	'--sidebar-border': '--vscode-sideBar-border',
	'--sidebar-accent': '--vscode-list-hoverBackground',
	'--sidebar-accent-foreground': '--vscode-foreground',
};

function getWorkbenchRoot(): HTMLElement | null {
	try {
		const parentDoc = window.parent?.document;
		if (!parentDoc || parentDoc === document) return null;
		// CodeCanvas/VS Code scope the --vscode-* variables to `.monaco-workbench` (not :root),
		// and custom properties only inherit downward, so we must read from that element.
		const workbench = parentDoc.querySelector('.monaco-workbench') as HTMLElement | null;
		return workbench ?? parentDoc.body ?? parentDoc.documentElement;
	} catch {
		return null; // cross-origin
	}
}

export function applyVscodeTheme(): void {
	const parentRoot = getWorkbenchRoot();
	if (!parentRoot) return;
	const cs = getComputedStyle(parentRoot);
	const root = document.documentElement;

	for (const [token, vscodeVar] of Object.entries(HSL_MAP)) {
		const rgb = parseColor(cs.getPropertyValue(vscodeVar));
		if (rgb) root.style.setProperty(token, toHslComponents(rgb));
	}
	for (const [token, vscodeVar] of Object.entries(COLOR_MAP)) {
		const val = cs.getPropertyValue(vscodeVar).trim();
		if (val) root.style.setProperty(token, val);
	}

	// Keep the dark/light class in sync with the theme's background luminance.
	const bg = parseColor(cs.getPropertyValue('--vscode-editor-background'));
	if (bg) {
		const lum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
		root.classList.toggle('dark', lum < 0.5);
	}
}

export function startVscodeThemeSync(): void {
	applyVscodeTheme();
	const parentRoot = getWorkbenchRoot();
	if (!parentRoot) return;
	try {
		const observer = new MutationObserver(() => applyVscodeTheme());
		observer.observe(parentRoot, { attributes: true, attributeFilter: ['class', 'style'] });
		const parentBody = window.parent.document.body;
		if (parentBody) {
			observer.observe(parentBody, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	} catch {
		/* ignore */
	}
}
