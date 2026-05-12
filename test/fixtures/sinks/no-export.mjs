// Test fixture: module that loads cleanly but exports neither a default
// nor a named `sink`. The resolver should reject it with a clear error.

export const unrelated = { foo: "bar" };
