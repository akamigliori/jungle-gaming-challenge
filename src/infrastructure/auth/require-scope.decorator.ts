import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPES_KEY = 'requiredScopes';

/** Declara os escopos que a rota exige; se o token não tiver nenhum deles, o guard responde 403. */
export const RequireScope = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);
