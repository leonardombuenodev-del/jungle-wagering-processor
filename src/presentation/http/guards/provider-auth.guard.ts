import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ProviderIdentityPort } from "../../../application/ports/auth.port";

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(ProviderIdentityPort) private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const provider = await this.identityPort.verifyProviderRequest(req.headers ?? {});
    req.providerIdentity = provider;
    return provider.authenticated;
  }
}
