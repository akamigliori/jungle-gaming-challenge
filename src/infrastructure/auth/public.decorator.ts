import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca a rota como pública: o `AuthGuard` a libera sem exigir autenticação. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
