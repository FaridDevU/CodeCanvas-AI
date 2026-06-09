// Local stub for next-intl backed by the bundled English messages, so the editor shows
// real labels instead of raw translation keys.
import en from '../../messages/en.json';

function lookup(path: string): string | undefined {
	const value = path.split('.').reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), en);
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
	return 'en';
}

export function useMessages() {
	return en;
}

export const NextIntlClientProvider = ({ children }: { children?: any }) => children ?? null;
