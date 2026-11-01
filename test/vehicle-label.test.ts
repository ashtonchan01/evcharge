import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vehicleLabel } from "../src/vehicleLabel.ts";

describe("vehicleLabel", () => {
  it("names Ashton's Model 3 and Model X even when Tesla sends a VIN or M3/MX", () => {
    assert.equal(vehicleLabel("5YJ3F7EA5KF461091"), "Model 3");
    assert.equal(vehicleLabel("5YJ3F7EA5KF461091", "5YJ3F7EA5KF461091"), "Model 3");
    assert.equal(vehicleLabel("5YJ3F7EA5KF461091", "M3"), "Model 3");
    assert.equal(vehicleLabel("5YJXDCE25JF080915"), "Model X");
    assert.equal(vehicleLabel("5YJXDCE25JF080915", "MX"), "Model X");
    assert.equal(vehicleLabel("5yjxdce25jf080915", "mx"), "Model X");
  });

  it("expands short Tesla names and uses the VIN model character for other cars", () => {
    assert.equal(vehicleLabel("5YJ3UNKNOWN0000001", "M3"), "Model 3");
    assert.equal(vehicleLabel("5YJYGDEE0MF000001", ""), "Model Y");
    assert.equal(vehicleLabel("5YJSA1E20HF000001"), "Model S");
    assert.equal(vehicleLabel("LRW3E7EB5MC000001", ""), "Model 3");
  });

  it("keeps a real custom name and does not invent one for a non-Tesla id", () => {
    assert.equal(vehicleLabel("5YJ3UNKNOWN0000001", "Daily driver"), "Daily driver");
    assert.equal(vehicleLabel("NOTATESLA000000001", ""), "NOTATESLA000000001");
  });
});
