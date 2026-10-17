import { Role } from '@prisma/client';
export type AuthUser = { id: string; email: string; name: string; role: Role };
