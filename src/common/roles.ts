import { Role } from '@prisma/client';

/** Full access: every module, plus users, audit logs and settings. */
export const ADMIN_ROLES: Role[] = [Role.SUPERADMIN, Role.ADMIN];
/** Machines. */
export const MACHINE_ROLES: Role[] = [...ADMIN_ROLES, Role.MANAGER];
/** Godown: add, edit and delete yarn and fabric stock entries. */
export const GODOWN_ROLES: Role[] = [...ADMIN_ROLES, Role.STAFF];
/** Godown stock, read-only for managers. */
export const GODOWN_VIEW_ROLES: Role[] = [...GODOWN_ROLES, Role.MANAGER];
