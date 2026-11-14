import { describe, expect, it } from "vitest";
import { readTypedValue } from "./typed";
import { fxToken } from "../schema";

/** Typing into a field is the fastest way to bind one, so the line between
 *  "this is a value" and "this is an expression" has to be exact. */
describe("readTypedValue", () => {
  it("keeps plain values plain", () => {
    expect(readTypedValue("42", "float").kind).toBe("literal");
    expect(readTypedValue("-3.5", "float").kind).toBe("literal");
    expect(readTypedValue("", "float").kind).toBe("literal");
    expect(readTypedValue("#ff8732", "color").kind).toBe("literal");
    expect(readTypedValue("hello", "string").kind).toBe("literal");
    expect(readTypedValue("12px", "float").kind).toBe("literal");
  });

  it("reads a global or a layer property as an expression", () => {
    expect(readTypedValue("#frame", "float")).toEqual({ kind: "expression", source: "#frame" });
    expect(readTypedValue("#layer.rotation * 2", "float").kind).toBe("expression");
    expect(readTypedValue("wiggle(2, 10)", "float").kind).toBe("expression");
  });

  it("honours a leading = over every other rule", () => {
    expect(readTypedValue("=5", "float")).toEqual({ kind: "expression", source: "5" });
    expect(readTypedValue("=", "float").kind).toBe("literal");
  });

  it("binds a pasted reference token", () => {
    expect(readTypedValue(fxToken("fx_1"), "float")).toEqual({ kind: "token", token: "fx:fx_1" });
  });

  it("binds text that cannot run, so the field can say why", () => {
    // `#Sizee` may not exist; that is a diagnostic on the bound field, not a
    // reason to silently drop what was typed.
    expect(readTypedValue("#Sizee * 2", "float").kind).toBe("expression");
    // Unparseable text is not an expression at all.
    expect(readTypedValue("2 +", "float").kind).toBe("literal");
  });
});
