// Test fixture: module exports BOTH a default and a `sink`. The
// resolver must prefer the default — pinning the documented priority.

export default {
  name: "fixture-default-wins",
};

export const sink = {
  name: "fixture-named-should-be-ignored",
};
