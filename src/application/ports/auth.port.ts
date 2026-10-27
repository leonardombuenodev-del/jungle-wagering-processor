export interface AuthenticatedProvider {
  providerId: string;
  authenticated: boolean;
}

export abstract class ProviderIdentityPort {
  abstract verifyProviderRequest(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedProvider>;
}

export class NoOpProviderIdentityAdapter extends ProviderIdentityPort {
  async verifyProviderRequest(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedProvider> {
    const rawProvider = headers["x-provider-id"];
    const providerId = Array.isArray(rawProvider) ? rawProvider[0] : rawProvider;
    return {
      providerId: providerId ?? "anonymous-provider",
      authenticated: true,
    };
  }
}
