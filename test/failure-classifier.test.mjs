import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFailure } from "../dist/failures/classifier.js";

describe("classifyFailure", () => {
  it("classifies a rate-limit error as retryable rate_limited", () => {
    const f = classifyFailure("HTTP 429 Too Many Requests");
    assert.equal(f.category, "rate_limited");
    assert.equal(f.retryable, true);
  });

  it("classifies a storage permission error as non-retryable permission_config", () => {
    const f = classifyFailure("403 storage.objects.create denied");
    assert.equal(f.category, "permission_config");
    assert.equal(f.retryable, false);
  });

  it("classifies a not-ready fixture error as retryable data_not_ready", () => {
    const f = classifyFailure("Not enough knockout matches to build a bracket (0).");
    assert.equal(f.category, "data_not_ready");
    assert.equal(f.retryable, true);
  });

  it("classifies a 401 as non-retryable auth_error", () => {
    const f = classifyFailure("401 Unauthorized");
    assert.equal(f.category, "auth_error");
    assert.equal(f.retryable, false);
  });

  it("always produces a non-empty userMessage and developerMessage", () => {
    const f = classifyFailure("some totally unknown failure");
    assert.equal(f.category, "unknown");
    assert.ok(f.userMessage.length > 0);
    assert.ok(f.developerMessage.length > 0);
  });

  it("accepts an object with a message field", () => {
    const f = classifyFailure({ message: "circuit breaker open" });
    assert.equal(f.category, "provider_error");
    assert.equal(f.retryable, false);
  });

  it("does not misclassify HTTP-code digits embedded in larger tokens/numbers", () => {
    const a = classifyFailure("athlete 40123 not found");
    assert.equal(a.category, "unknown");
    const b = classifyFailure("market KX401ABC unavailable");
    assert.equal(b.category, "unknown");
  });
});
