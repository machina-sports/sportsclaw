// Test fixture: an external operator sink exported as a named `sink`
// (no default export). The resolver should pick this up via the
// `default ?? sink` fallback.

export const sink = {
  name: "fixture-named",
  onTickEvent() {
    // no-op
  },
};
