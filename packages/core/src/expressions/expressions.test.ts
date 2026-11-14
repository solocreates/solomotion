import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTextClip } from "../factories";
import { parseDocument, serializeDocument } from "../io";
import { addVariable, resolveColor, resolveNumber, setVariableClock, variableWriteConflicts } from "../variables";
import { addExpression, expressionUsage, pruneExpressions, resolveExpressionToken } from "./document";
import { checkProgram } from "./check";
import { evaluateProgram, type EvalScope } from "./eval";
import { GLOBALS, type ExprContext } from "./globals";
import { tokenize } from "./lexer";
import { parseExpression } from "./parser";
import { evaluateExpressionSource, getExpressionContext, setExpressionContext, withExpressionLayer, withFieldValue } from "./bind";
import { layerPropertyIndex } from "./layer-api";
import type { ExprValue } from "./types";
import { fxToken, type MotionDocument } from "../schema";
import type { ExprType } from "./types";

/**
 * The expression language. These tests pin the two things a language has to get
 * right before anything is built on it: that the same source always produces the
 * same value, and that a mistake produces a message a person can act on.
 */

const CTX: ExprContext = {
  timeMs: 1000,
  fps: 30,
  comp: { width: 1920, height: 1080, durationMs: 5000 },
  layer: { id: "c1", name: "Hero", index: 2, startMs: 400, durationMs: 2000, width: 300, height: 100, opacity: 0.5 },
  playing: false,
  seed: 0.42,
};

/** A layer surface, exactly as `exprLayerProperties` produces one. */
const TITLE_PROPS = layerPropertyIndex([
  { path: "x", label: "X", group: "Transform", type: "float" },
  { path: "rotation", label: "Rotation", group: "Transform", type: "float" },
  { path: "text", label: "Text", group: "Typography", type: "string" },
  { path: "fill.f1.color", label: "Fill", group: "Fill", type: "color" },
]);
const HERO_PROPS = layerPropertyIndex([
  { path: "rotation", label: "Rotation", group: "Transform", type: "float" },
  { path: "width", label: "Width", group: "Shape", type: "float" },
]);

const VALUES: Record<string, ExprValue> = {
  "title|x": 120,
  "title|text": "Hello",
  "title|fill.f1.color": "#ff0000",
  "hero|rotation": 45,
  "hero|width": 999,
};

/** A context whose layer API answers for two layers — the shape a host injects. */
const LAYER_CTX: ExprContext = {
  ...CTX,
  layer: { ...CTX.layer!, id: "hero" },
  layers: {
    idFor: (name) => (name.trim() ? name.trim().toLowerCase() : undefined),
    nameOf: (id) => id,
    propertiesOf: (id) => [...(id === "title" ? TITLE_PROPS : HERO_PROPS).values()],
    read: (id, path) => VALUES[`${id}|${path}`],
    all: () => [
      { id: "hero", name: "Hero" },
      { id: "title", name: "Title" },
    ],
  },
};

function scopeWith(vars: Record<string, { value: number | string; type: ExprType }> = {}): EvalScope {
  return {
    ctx: CTX,
    readVariable: (name) => {
      const v = vars[name.toLowerCase()];
      return v ? { id: `var_${name}`, value: v.value, type: v.type } : undefined;
    },
  };
}

/** Evaluate a source string, ignoring types — the shorthand most tests want. */
function run(source: string, vars?: Record<string, { value: number | string; type: ExprType }>) {
  const result = evaluateProgram(parseExpression(source), scopeWith(vars));
  return result?.value;
}

/** Type-check a source string against a field type; returns its messages. */
function lint(source: string, expect: ExprType | null = null, variables: Array<{ id: string; name: string; type: ExprType }> = []) {
  return checkProgram(parseExpression(source), { variables, expect }).diagnostics;
}

describe("lexer", () => {
  it("gives every token a span the editor can paint from", () => {
    const tokens = tokenize("#time * 2");
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ["ref", "#time"],
      ["operator", "*"],
      ["number", "2"],
    ]);
    expect(tokens[0]).toMatchObject({ start: 0, end: 5, path: ["time"] });
    expect(tokens[2]).toMatchObject({ start: 8, end: 9, value: 2 });
  });

  it("reads a dotted reference as ONE token — scope decides where the name ends", () => {
    expect(tokenize("#layer.index")[0]).toMatchObject({ kind: "ref", path: ["layer", "index"] });
  });

  it("accepts a quoted name so a variable may contain spaces", () => {
    expect(tokenize('#"Brand Pink"')[0]).toMatchObject({ kind: "ref", path: ["Brand Pink"], quoted: true });
  });

  it("keeps comments as tokens rather than dropping them", () => {
    expect(tokenize("1 // hi").map((t) => t.kind)).toEqual(["number", "comment"]);
  });
});

describe("parser", () => {
  it("binds * tighter than +", () => {
    expect(run("1 + 2 * 3")).toBe(7);
  });

  it("makes ^ right-associative and tighter than unary minus", () => {
    expect(run("-2 ^ 2")).toBe(-4);
    expect(run("2 ^ 3 ^ 2")).toBe(512);
  });

  it("parses a conditional", () => {
    expect(run("1 > 2 ? 10 : 20")).toBe(20);
  });

  it("never throws on half-typed source", () => {
    for (const source of ["", "1 +", "mix(", "#", "#a =", "((", "1 ? 2"]) {
      expect(() => parseExpression(source)).not.toThrow();
    }
  });
});

describe("globals", () => {
  it("reads time, frame and fps from the host context", () => {
    expect(run("#time")).toBe(1);
    expect(run("#frame")).toBe(30);
    expect(run("#fps")).toBe(30);
  });

  it("derives layer-local time from the layer's own start", () => {
    // The playhead is at 1000ms and the layer began at 400ms.
    expect(run("#layer.time")).toBeCloseTo(0.6);
    expect(run("#layer.progress")).toBeCloseTo(0.3);
    expect(run("#layer.index")).toBe(2);
  });

  it("reads composition geometry", () => {
    expect(run("#comp.width")).toBe(1920);
    expect(run("#progress")).toBeCloseTo(0.2);
  });

  it("declares a type for every entry, and every entry reads without throwing", () => {
    for (const g of GLOBALS) {
      expect(g.describe.length).toBeGreaterThan(10);
      expect(() => g.read(CTX)).not.toThrow();
    }
  });
});

describe("variables and locals", () => {
  it("reads a document variable by name, case-insensitively", () => {
    expect(run("#size * 2", { size: { value: 21, type: "float" } })).toBe(42);
    expect(run("#SIZE", { size: { value: 7, type: "float" } })).toBe(7);
  });

  it("declares locals that later lines can use", () => {
    expect(run("#half = 10 / 2; #half + 1")).toBe(6);
    expect(run("#a = 2; #b = #a * 3; #b")).toBe(6);
  });

  it("refuses to redefine a built-in global", () => {
    const messages = lint("#time = 5; #time");
    expect(messages.some((d) => d.severity === "error" && d.message.includes("built in"))).toBe(true);
  });

  it("refuses to redefine a document variable", () => {
    const messages = lint("#Brand = 5; #Brand", null, [{ id: "v1", name: "Brand", type: "color" }]);
    expect(messages.some((d) => d.message.includes("already a document variable"))).toBe(true);
  });

  it("refuses to define the same local twice", () => {
    expect(lint("#a = 1; #a = 2; #a").some((d) => d.message.includes("already defined"))).toBe(true);
  });
});

describe("diagnostics", () => {
  it("names an unknown reference and suggests the closest one", () => {
    const [first] = lint("#tiem");
    expect(first?.message).toContain("Nothing is called");
    expect(first?.message).toContain("#time");
    expect(first?.fix?.replacement).toBe("#time");
  });

  it("tells you a bare word needs a sigil", () => {
    const [first] = lint("time * 2");
    expect(first?.message).toContain("#time");
    expect(first?.fix?.replacement).toBe("#time");
  });

  it("catches the wrong number of arguments", () => {
    expect(lint("clamp(1, 2)")[0]?.message).toContain("takes 3 arguments");
  });

  it("suggests a near-miss function name", () => {
    expect(lint("clmap(1, 2, 3)")[0]?.message).toContain("clamp");
  });

  it("errors when the result cannot fit the field", () => {
    const [first] = lint('"hello"', "float");
    expect(first?.severity).toBe("error");
    expect(first?.message).toContain("number");
  });

  it("warns — but allows — a result that has to be converted", () => {
    const [first] = lint("0.5", "color");
    expect(first?.severity).toBe("warning");
  });

  it("says nothing about an expression that fits", () => {
    expect(lint("#time * 100", "float")).toEqual([]);
    expect(lint('mix("#000000", "#ffffff", #progress)', "color")).toEqual([]);
  });

  it("reports a field a type doesn't have", () => {
    expect(lint("#time.z")[0]?.message).toContain("no “.z”");
  });

  it("warns when a global is unavailable at this site", () => {
    const messages = checkProgram(parseExpression("#layer.width"), {
      variables: [],
      expect: null,
      available: { layer: false },
    }).diagnostics;
    expect(messages[0]?.severity).toBe("warning");
    expect(messages[0]?.message).toContain("isn’t on one");
  });
});

describe("functions", () => {
  it("mixes numbers, colours and vectors with the same verb", () => {
    expect(run("mix(0, 10, 0.25)")).toBe(2.5);
    expect(run('mix("#000000", "#ffffff", 0.5)')).toMatch(/^#7f7f7f|^#808080/i);
    expect(run("mix(vec(0, 0), vec(10, 20), 0.5)")).toEqual({ x: 5, y: 10 });
  });

  it("maps and clamps ranges", () => {
    expect(run("map(0.5, 0, 1, 0, 100)")).toBe(50);
    expect(run("map(2, 0, 1, 0, 100)")).toBe(200);
    expect(run("clamp(2, 0, 1)")).toBe(1);
  });

  it("pads and formats numbers into text", () => {
    expect(run("pad(42, 4)")).toBe("0042");
    expect(run("fixed(1.239, 2)")).toBe("1.24");
  });

  it("bounces instead of jumping", () => {
    expect(run("pingpong(0.25, 1)")).toBe(0.25);
    expect(run("pingpong(1.75, 1)")).toBeCloseTo(0.25);
  });

  it("keeps randomness stable across evaluations but different per call site", () => {
    const once = run("random()");
    const twice = run("random()");
    expect(once).toBe(twice);
    const both = run("random() - random()") as number;
    expect(both).not.toBe(0);
  });

  it("keeps two wiggles in one expression independent", () => {
    expect(run("wiggle(2, 10) - wiggle(2, 10)")).not.toBe(0);
  });

  it("gives wiggle the same answer for the same time and seed", () => {
    expect(run("wiggle(2, 10)")).toBe(run("wiggle(2, 10)"));
  });
});

describe("operators", () => {
  it("joins text with +", () => {
    expect(run('"Frame " + pad(#frame, 3)')).toBe("Frame 030");
  });

  it("loops with a positive remainder, both as % and as mod()", () => {
    expect(run("-1 % 3")).toBe(2);
    expect(run("mod(-1, 3)")).toBe(2);
  });

  it("works on colours channel by channel, so scaling darkens", () => {
    expect(run('"#ffffff" * 0.5')).toMatch(/^#7f7f7f|^#808080/i);
  });

  it("reads colour channels and vector components", () => {
    expect(run('"#ff0000".r')).toBe(1);
    expect(run('"#ff0000".g')).toBe(0);
    expect(run("vec(3, 4).y")).toBe(4);
    expect(run("length(vec(3, 4))")).toBe(5);
  });

  it("short-circuits so the right side is never evaluated needlessly", () => {
    expect(run("false && 1 / 0 > 0")).toBe(false);
  });

  it("treats text that looks like a colour AS a colour", () => {
    expect(evaluateProgram(parseExpression('"#ff8732"'), scopeWith())?.type).toBe("color");
    expect(evaluateProgram(parseExpression('"hello"'), scopeWith())?.type).toBe("string");
  });
});

describe("binding into a document", () => {
  function docWithExpression(source: string): { doc: MotionDocument; token: string } {
    const doc = createEmptyDocument();
    const expression = addExpression(doc, source);
    return { doc, token: fxToken(expression.id) };
  }

  it("resolves an fx token through the same funnel colours already use", () => {
    const { doc, token } = docWithExpression('mix("#000000", "#ffffff", 1)');
    expect(resolveColor(doc, token).toLowerCase()).toBe("#ffffff");
  });

  it("resolves an fx token in a number slot", () => {
    const { doc, token } = docWithExpression("6 * 7");
    expect(resolveNumber(doc, token)).toBe(42);
  });

  it("reads the ambient context, so #time follows the playhead", () => {
    const { doc, token } = docWithExpression("#time * 10");
    setExpressionContext({ ...CTX, timeMs: 2000 });
    expect(resolveNumber(doc, token)).toBe(20);
    setExpressionContext(null);
    expect(resolveNumber(doc, token)).toBe(0); // no host facts: time reads 0
  });

  it("reads any layer's REAL properties — the same list its node card shows", () => {
    // One surface, two ways in. `#layer.<path>` is the layer this expression is
    // on; `layer("Name").<path>` is any other. Both resolve against the SAME
    // projection a Layer node builds its sockets from, so a value you can wire
    // is a value you can write, and neither can drift from the other.
    const at = (source: string) =>
      evaluateProgram(parseExpression(source), { ctx: LAYER_CTX, readVariable: () => undefined })?.value;

    expect(at("#layer.rotation")).toBe(45);
    expect(at("#layer.rotation / 2")).toBe(22.5);
    expect(at('layer("Title").x')).toBe(120);
    expect(at('layer("Title").x + 40')).toBe(160);
    expect(at('layer("Title").text')).toBe("Hello");
    // Deep paths work because a path is a path: nothing here knows what a fill is.
    expect(at('layer("Title").fill.f1.color')).toBe("#ff0000");
    // The old two-argument form still reads, so existing documents keep working.
    expect(at('layer("Title", "x")')).toBe(120);
  });

  it("keeps the layer INTRINSICS winning over same-named properties", () => {
    // `#layer.width` is the box you can see and `#layer.time` is clip-local time.
    // A shape also has a `width` property; the intrinsic is the older, documented
    // meaning, so it stays the answer and the property is reachable by its own
    // name through the other layer form.
    const at = (source: string) =>
      evaluateProgram(parseExpression(source), { ctx: LAYER_CTX, readVariable: () => undefined })?.value;
    expect(at("#layer.width")).toBe(300); // the intrinsic, not the property's 999
    expect(at("#layer.time")).toBeCloseTo(0.6);
  });

  it("never throws on a layer that isn't there", () => {
    const at = (source: string) =>
      evaluateProgram(parseExpression(source), { ctx: LAYER_CTX, readVariable: () => undefined })?.value;
    expect(at('layer("Nope").x')).toBe(0);
    expect(at('layer("").x')).toBe(0);
    expect(at('layer("Title").nonsense')).toBe(0);
    // A host with no layer API at all reads neutrally rather than crashing.
    expect(evaluateProgram(parseExpression('layer("Title").x'), scopeWith())?.value).toBe(0);
  });

  it("names a path the layer does not have, and suggests the near one", () => {
    const check = checkProgram(parseExpression('layer("Title").rotatoin'), {
      variables: [],
      expect: null,
      layerPropertiesByName: () => TITLE_PROPS,
    });
    expect(check.diagnostics[0]?.message).toContain("rotation");
  });

  it("refuses to end on a layer, because a layer is not a value", () => {
    const check = checkProgram(parseExpression('layer("Title")'), { variables: [], expect: "float" });
    expect(check.diagnostics[0]?.message).toContain("isn’t a value");
  });

  it("scopes layer facts to one layer at a time", () => {
    const { doc, token } = docWithExpression("#layer.index");
    setExpressionContext({ ...CTX, layer: null });
    expect(resolveNumber(doc, token)).toBe(0);
    const inside = withExpressionLayer(
      { id: "c2", name: "Other", index: 7, startMs: 0, durationMs: 1000, width: 10, height: 10, opacity: 1 },
      () => resolveNumber(doc, token),
    );
    expect(inside).toBe(7);
    expect(resolveNumber(doc, token)).toBe(0); // restored
    setExpressionContext(null);
  });

  it("reads a document variable by name, keyframes included", () => {
    const doc = createEmptyDocument();
    addVariable(doc, "number", "Size", 10);
    const expression = addExpression(doc, "#Size * 2");
    expect(resolveNumber(doc, fxToken(expression.id))).toBe(20);

    const size = doc.variables[0]!;
    size.keyframes = [
      {
        id: "t1",
        property: "value",
        range: null,
        keys: [
          { id: "k1", timeMs: 0, value: 0, easing: { kind: "linear" } },
          { id: "k2", timeMs: 1000, value: 100, easing: { kind: "linear" } },
        ],
      },
    ];
    setVariableClock(500);
    expect(resolveNumber(doc, fxToken(expression.id))).toBe(100); // 50 × 2
    setVariableClock(null);
  });

  it("leaves an unbound literal completely alone", () => {
    const doc = createEmptyDocument();
    expect(resolveColor(doc, "#123456")).toBe("#123456");
    expect(resolveNumber(doc, 12)).toBe(12);
  });

  it("counts usages and sweeps the rows nothing points at", () => {
    const doc = createEmptyDocument();
    const used = addExpression(doc, "1");
    const orphan = addExpression(doc, "2");
    doc.frames[0]!.background = fxToken(used.id);

    expect(expressionUsage(doc).get(used.id)).toBe(1);
    expect(expressionUsage(doc).get(orphan.id)).toBeUndefined();

    pruneExpressions(doc);
    expect(doc.expressions.map((e) => e.id)).toEqual([used.id]);
  });

  it("survives a save and a reload from a Bindable slot", () => {
    // The regression this pins: `Bindable` once matched only `var:` tokens, so a
    // font size driven by an expression saved happily and then failed zod on the
    // way back in — the whole document refused to open. Any reference token a
    // slot can hold has to be a token the schema accepts.
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const expression = addExpression(doc, "24 + #time * 4");
    const clip = createTextClip({ frameId, startMs: 0, text: "Hi" });
    clip.style.fontSize = fxToken(expression.id);
    doc.tracks[0]!.clips.push(clip);

    const reopened = parseDocument(serializeDocument(doc));
    const reloaded = reopened.tracks[0]!.clips[0]!;
    expect(reloaded.kind).toBe("text");
    if (reloaded.kind !== "text") return;
    expect(reloaded.style.fontSize).toBe(fxToken(expression.id));
    // …and the row it points at came back with it, rather than being pruned.
    expect(reopened.expressions).toHaveLength(1);
    expect(resolveNumber(reopened, reloaded.style.fontSize)).toBe(24);
  });

  it("returns undefined for a token pointing at nothing, so the field falls back", () => {
    const doc = createEmptyDocument();
    expect(resolveExpressionToken(doc, fxToken("fx_missing"), "float")).toBeUndefined();
  });
});

/** A variable has ONE owner. Every surface that enforces it — the disabled
 *  socket, the take-over confirm, the sync that refuses a foreign write — reads
 *  this one answer. */
describe("variableWriteConflicts", () => {
  const doc = (): MotionDocument => {
    const d = createEmptyDocument();
    d.variables = [
      { id: "v1", name: "Size", type: "number", value: 10, driver: "expr:g1@n1.v1" } as never,
      { id: "v2", name: "Tint", type: "color", value: "#fff", driver: null } as never,
    ];
    d.graphs = [{ id: "g1", name: "Wobble", nodes: [], edges: [] } as never];
    return d;
  };

  it("names the graph that already writes a variable", () => {
    const held = variableWriteConflicts(doc(), "g2");
    expect(held.get("v1")).toMatchObject({ variableName: "Size", graphId: "g1", graphName: "Wobble" });
    expect(held.has("v2")).toBe(false);
  });

  it("is not a conflict with yourself", () => {
    expect(variableWriteConflicts(doc(), "g1").size).toBe(0);
  });
});

describe("characters: bone() and blink()", () => {
  const RIG_PROPS = layerPropertyIndex([
    { path: "bone.b1.rotation", label: "Rotation", group: "Jaw", type: "float" },
    { path: "bone.b1.y", label: "Move Y", group: "Jaw", type: "float" },
    { path: "bone.b2.rotation", label: "Rotation", group: "Brow", type: "float" },
  ]);
  const RIG_CTX: ExprContext = {
    ...CTX,
    layers: {
      idFor: (name) => (name.toLowerCase() === "face" ? "face" : undefined),
      nameOf: (id) => id,
      propertiesOf: () => [...RIG_PROPS.values()],
      read: (_id, path) => ({ "bone.b1.rotation": 20, "bone.b1.y": -6, "bone.b2.rotation": 3 })[path],
      all: () => [{ id: "face", name: "Face" }],
    },
  };
  const at = (source: string, ctx: ExprContext) => evaluateProgram(parseExpression(source), { ctx, readVariable: () => undefined })?.value;

  it("reads a bone by the rig's and the bone's names, any case, rotation by default", () => {
    expect(at('bone("Face", "jaw")', RIG_CTX)).toBe(20);
    expect(at('bone("Face", "Jaw", "y")', RIG_CTX)).toBe(-6);
    expect(at('map(bone("Face", "Jaw"), 0, 40, 0, 1)', RIG_CTX)).toBeCloseTo(0.5, 9);
    // Unknown rig, bone or channel: zero, never a throw mid-render.
    expect(at('bone("Body", "Jaw")', RIG_CTX)).toBe(0);
    expect(at('bone("Face", "Nose")', RIG_CTX)).toBe(0);
    expect(at('bone("Face", "Jaw", "scaleZ")', RIG_CTX)).toBe(0);
  });

  it("blinks shut briefly, unevenly, and the same way on every replay", () => {
    const sample = (seed: number) => {
      const shut: number[] = [];
      for (let ms = 0; ms < 60_000; ms += 10) if (at("blink()", { ...CTX, timeMs: ms, seed }) === 1) shut.push(ms);
      return shut;
    };
    const a = sample(0.42);
    expect(sample(0.42)).toEqual(a);
    // Runs of shut frames: each short, about one every 4 s, the gaps not all equal.
    const runs: Array<[number, number]> = [];
    for (const ms of a) {
      const last = runs[runs.length - 1];
      if (last && ms - last[1] <= 10) last[1] = ms;
      else runs.push([ms, ms]);
    }
    expect(runs.length).toBeGreaterThan(10);
    expect(runs.length).toBeLessThan(25);
    expect(runs.every(([s, e]) => e - s < 150)).toBe(true);
    const gaps = runs.slice(1).map((r, i) => r[0] - runs[i]![0]);
    expect(new Set(gaps.map((g) => Math.round(g / 100))).size).toBeGreaterThan(3);
    // Another seed (another eye, another character) blinks at other moments.
    expect(sample(0.77)).not.toEqual(a);
  });

  it("type-checks as a switch choice", () => {
    expect(lint('if(blink(4) > 0, "Closed", "Open")', "string")).toEqual([]);
    // `#value` is the field's own choice — text in a text field, a number in a number one.
    expect(lint('if(blink(4) > 0, "Closed", #value)', "string")).toEqual([]);
    expect(lint("#value + wiggle(2, 5)", "float")).toEqual([]);
  });
});

describe("#value", () => {
  const run = (source: string, own: ExprValue | undefined, expect_: ExprType | null) =>
    withFieldValue(() => own, () => evaluateExpressionSource(source, { ctx: getExpressionContext(), readVariable: () => undefined }, expect_));

  it("reads the field's own value, in the field's type", () => {
    expect(run("#value * 2", 21, "float")).toBe(42);
    expect(run('if(false, "Closed", #value)', "Angry", "string")).toBe("Angry");
    // Undeclared field type: whatever the field holds.
    expect(run('if(false, "Closed", #value)', "Angry", null)).toBe("Angry");
  });

  it("is the identity where there is no field", () => {
    expect(evaluateExpressionSource("#value + 1", { ctx: getExpressionContext(), readVariable: () => undefined }, "float")).toBe(1);
  });
});
