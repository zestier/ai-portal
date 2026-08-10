import { getProvider } from '.';

export function providerAuthToken(provider: string, userId: string): string | undefined {
	return getProvider(provider).resolveAuthToken?.(userId);
}
