// Starter file from `init` — replace with your own code.
import { describe, test, expect } from "vitest";
import { MathEngine } from "./MathEngine.js";
import { MathError } from "./MathError.js";

describe("MathEngine", () => {
    const engine = new MathEngine();

    test("add returns the sum and echoes the operation", () => {
        expect(engine.add(3, 4)).toEqual({
            value: 7,
            operation: "add",
            operands: [3, 4],
        });
    });

    test("subtract returns the difference", () => {
        expect(engine.subtract(10, 4).value).toBe(6);
    });

    test("rejects non-finite operands with a MathError", () => {
        expect(() => engine.add(1, Infinity)).toThrow(MathError);
    });
});
