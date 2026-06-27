// Placeholder workspace member. Exists only so the pnpm workspace resolves and
// CI runs a real Node test. Replace nothing here — build real services under
// services/* (issue #11) and apps/* (issue #20).

/**
 * Returns the scaffold marker string.
 * @returns {string}
 */
export function scaffoldMarker() {
  return 'logalot:scaffold';
}
