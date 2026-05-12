// Test fixture: an external operator sink exported as `default`.
// Imported dynamically by the resolver when cfg.sink points at this file.

export default {
  name: "fixture-default",
  registerTools({ toolNames }) {
    toolNames.push("__fixture_default_tool");
  },
};
