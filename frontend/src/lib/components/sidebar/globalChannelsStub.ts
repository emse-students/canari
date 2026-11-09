/**
 * The part of the `globalChannels` store that mounting the community admin panel touches, for the
 * Sidebar suites that replace the whole store module with an empty object. One definition, so a
 * method the panel starts calling is added here once and not in every suite's own mock.
 */
export function globalChannelsStub() {
  return {
    rolePermissions: {} as Record<string, string[]>,
    roleLabels: {} as Record<string, string | null>,
    setRolePermissions: () => {},
    setRoleLabels: () => {},
    setRoleLabel: () => {},
  };
}
