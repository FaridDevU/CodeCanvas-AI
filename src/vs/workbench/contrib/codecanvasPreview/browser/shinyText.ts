/*---------------------------------------------------------------------------------------------
 *  CodeCanvas AI - Shiny Text helper
 *  Native (no React/motion) port of the ShinyText effect. Styles live in
 *  ./media/shinyText.css (class `cc-shiny-text`).
 *--------------------------------------------------------------------------------------------*/

export interface IShinyTextOptions {
	/** Animation duration in seconds (default 2). */
	speed?: number;
	/** Gradient angle in degrees (default 120). */
	spread?: number;
	/** Base text color (default #b5b5b5). */
	color?: string;
	/** Shine color (default #ffffff). */
	shineColor?: string;
	/** Shine travel direction (default 'left'). */
	direction?: 'left' | 'right';
	/** Pause the shimmer while hovered (default false). */
	pauseOnHover?: boolean;
	/** Render without animation (default false). */
	disabled?: boolean;
	/** Extra class names. */
	className?: string;
}

function applyOptions(el: HTMLElement, opts: IShinyTextOptions): void {
	el.classList.add('cc-shiny-text');
	if (opts.direction === 'right') { el.classList.add('cc-shiny-reverse'); }
	if (opts.pauseOnHover) { el.classList.add('cc-shiny-pause-hover'); }
	if (opts.disabled) { el.classList.add('cc-shiny-disabled'); }
	if (opts.className) { el.classList.add(...opts.className.split(' ').filter(Boolean)); }
	el.style.setProperty('--cc-shiny-speed', `${opts.speed ?? 2}s`);
	el.style.setProperty('--cc-shiny-spread', `${opts.spread ?? 120}deg`);
	el.style.setProperty('--cc-shiny-base', opts.color ?? '#b5b5b5');
	el.style.setProperty('--cc-shiny-shine', opts.shineColor ?? '#ffffff');
}

/** Create a <span> with the shiny effect. */
export function createShinyText(text: string, opts: IShinyTextOptions = {}): HTMLElement {
	const el = document.createElement('span');
	el.textContent = text;
	applyOptions(el, opts);
	return el;
}

/** Apply the shiny effect to an existing element (keeps its current text). */
export function applyShinyText(el: HTMLElement, opts: IShinyTextOptions = {}): void {
	applyOptions(el, opts);
}
