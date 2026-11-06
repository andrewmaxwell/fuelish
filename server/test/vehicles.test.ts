import { describe, expect, it } from "vitest";
import { VIN_RE, vehicleFromVpic } from "../src/vehicles";

describe("vehicle from VIN", () => {
  it("names a car the way the trip pages match it", () => {
    const civic = vehicleFromVpic("19xfc2f59ge000000", { ModelYear: "2016", Make: "HONDA", Model: "Civic", DisplacementL: "1.996", BodyClass: "Sedan/Saloon" });
    expect(civic).toMatchObject({ vin: "19XFC2F59GE000000", name: "2016 Honda Civic 2.0L", year: 2016, displacementL: 2 });
    expect(/2016.*civic.*2\.0/i.test(civic!.name)).toBe(true); // the EPA table's pattern
    expect(vehicleFromVpic("x", { ModelYear: "2019", Make: "RAM", Model: "1500", DisplacementL: "5.7", BodyClass: "Pickup" })!.name).toBe("2019 RAM 1500 5.7L");
    expect(vehicleFromVpic("x", { ModelYear: "2020", Make: "MERCEDES-BENZ", Model: "GLC", DisplacementL: "" })!.name).toBe("2020 Mercedes-Benz GLC");
  });

  it("gives up on a VIN that doesn't decode", () => {
    expect(vehicleFromVpic("x", { ModelYear: "", Make: "", Model: "" })).toBeNull();
    expect(vehicleFromVpic("x", undefined)).toBeNull();
  });

  it("only takes 17-character VINs without I, O or Q", () => {
    expect(VIN_RE.test("19XFC2F59GE000000")).toBe(true);
    expect(VIN_RE.test("19XFC2F59GE00000")).toBe(false);
    expect(VIN_RE.test("19XFC2F59GE00000O")).toBe(false);
  });
});
