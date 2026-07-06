import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamService, type AddMemberPayload, type CreateRolePayload } from '@/services/team.service';
import { companyKeys } from './keys';

export function useRolesQuery(companyId: string | undefined) {
  return useQuery({
    queryKey: companyId ? companyKeys.roles(companyId) : (['companies', 'roles', 'pending'] as const),
    queryFn: () => teamService.getRoles(companyId!),
    enabled: Boolean(companyId),
  });
}

export function useCreateRoleMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateRolePayload) => teamService.createRole(companyId, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: companyKeys.roles(companyId) }),
  });
}

export function useUpdateRoleMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roleId, data }: { roleId: string; data: Partial<CreateRolePayload> }) =>
      teamService.updateRole(companyId, roleId, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: companyKeys.roles(companyId) }),
  });
}

export function useDeleteRoleMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) => teamService.deleteRole(companyId, roleId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: companyKeys.roles(companyId) }),
  });
}

export function useMembersQuery(companyId: string | undefined) {
  return useQuery({
    queryKey: companyId ? companyKeys.members(companyId) : (['companies', 'members', 'pending'] as const),
    queryFn: () => teamService.getMembers(companyId!),
    enabled: Boolean(companyId),
  });
}

export function useAddMemberMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: AddMemberPayload) => teamService.addMember(companyId, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: companyKeys.members(companyId) }),
  });
}

export function useUpdateMemberMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      membershipId,
      data,
    }: {
      membershipId: string;
      data: {
        company_role_id?: string;
        is_active?: boolean;
        first_name?: string;
        last_name?: string;
        email?: string | null;
        password?: string;
      };
    }) => teamService.updateMember(companyId, membershipId, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: companyKeys.members(companyId) }),
  });
}

export function useRemoveMemberMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (membershipId: string) => teamService.removeMember(companyId, membershipId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: companyKeys.members(companyId) }),
  });
}
