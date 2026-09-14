import type { Role, User } from "@prisma/client";

export type AuthedUser = User & {
  memberships: Array<{
    organizationId: string;
    organization: { id: string; name: string; approved: boolean };
  }>;
};

export function publicUser(user: AuthedUser | User) {
  const memberships = "memberships" in user ? user.memberships : [];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role as Role,
    kycStatus: user.kycStatus,
    carrierId: user.carrierId,
    organizationId: memberships[0]?.organizationId ?? null,
    organization: memberships[0]?.organization ?? null,
  };
}
