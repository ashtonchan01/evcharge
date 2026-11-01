import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FLEET_AUTH_URL, describeTeslaHttpBody, resolveFleetAuthUrl } from "../src/tesla/authUrl.ts";

describe("fleet auth url", () => {
  it("refreshes tokens at fleet-auth, not the consumer auth.tesla.com edge", () => {
    assert.equal(DEFAULT_FLEET_AUTH_URL, "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token");
    assert.equal(resolveFleetAuthUrl(undefined), DEFAULT_FLEET_AUTH_URL);
    assert.equal(resolveFleetAuthUrl(""), DEFAULT_FLEET_AUTH_URL);
    assert.doesNotMatch(DEFAULT_FLEET_AUTH_URL, /auth\.tesla\.com/);
  });
});

describe("describeTeslaHttpBody", () => {
  it("keeps status text and strips tokens", () => {
    const body = describeTeslaHttpBody(
      'HTTP 403 <HTML><TITLE>Access Denied</TITLE></HTML> refresh_token=secret "access_token":"abc"'
    );
    assert.match(body, /Access Denied/);
    assert.doesNotMatch(body, /secret/);
    assert.doesNotMatch(body, /"abc"/);
  });
});
