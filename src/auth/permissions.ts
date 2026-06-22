import type { AppUser, AppUserRole } from '../domain/types.js'
import { GatewayError } from '../errors.js'

const roleRank: Record<AppUserRole, number> = {
  viewer: 1,
  admin: 2,
  owner: 3,
}

export function hasRole(user: AppUser, minimumRole: AppUserRole): boolean {
  return roleRank[user.role] >= roleRank[minimumRole]
}

export function requireRole(user: AppUser, minimumRole: AppUserRole): void {
  if (!hasRole(user, minimumRole)) {
    throw new GatewayError(
      'gateway_auth_error',
      `Requires ${minimumRole} permission`,
      403,
    )
  }
}

export function assertCanManageUser(actor: AppUser, target?: AppUser): void {
  requireRole(actor, 'owner')
  if (target?.role === 'owner' && actor.id !== target.id) {
    throw new GatewayError(
      'gateway_auth_error',
      'Only the owner user can modify another owner',
      403,
    )
  }
}
