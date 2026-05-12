// Test fixture: malformed sink — exports a plugin-shaped object that's
// missing the required `name` field. The resolver should reject it
// with a clear error.

export default {
  // name: missing on purpose
  onTickEvent() {},
};
