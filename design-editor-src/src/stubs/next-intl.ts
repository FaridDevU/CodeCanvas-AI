// Local stub for next-intl backed by the bundled messages, so the editor shows
// real labels instead of raw translation keys.
import en from '../../messages/en.json';

// The workbench passes the chosen language via ?locale= on the iframe URL
// (driven by the `codecanvas.language` setting). Only English is bundled today;
// other locales fall back to English until their message file is added.
// ponytail: single en bundle, add messages/<locale>.json + a bundles map when translated.
const bundles: Record<string, Record<string, any>> = { en };

function currentLocale(): string {
	try {
		return new URLSearchParams(globalThis.location?.search).get('locale') || 'en';
	} catch {
		return 'en';
	}
}

function messages(): Record<string, any> {
	return bundles[currentLocale()] ?? en;
}

function lookup(path: string): string | undefined {
	const value = path.split('.').reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), messages());
	return typeof value === 'string' ? value : undefined;
}

export function useTranslations(namespace?: string) {
	const prefix = namespace ? `${namespace}.` : '';
	const t = (key: string, values?: Record<string, any>) => {
		let str = lookup(`${prefix}${key}`) ?? key;
		if (values) {
			for (const [k, v] of Object.entries(values)) {
				str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
			}
		}
		return str;
	};
	t.rich = (key: string) => lookup(`${prefix}${key}`) ?? key;
	t.markup = (key: string) => lookup(`${prefix}${key}`) ?? key;
	t.raw = (key: string) => lookup(`${prefix}${key}`) ?? key;
	t.has = (key: string) => lookup(`${prefix}${key}`) !== undefined;
	return t;
}

export function useLocale() {
	return currentLocale();
}

export function useMessages() {
	return messages();
}

export const NextIntlClientProvider = ({ children }: { children?: any }) => children ?? null;
