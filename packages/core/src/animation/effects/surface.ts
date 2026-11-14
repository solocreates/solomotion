import { createId } from "../../ids";
import { SURFACE_MATERIALS } from "../../schema/layer-effects";
import type { EffectFieldOption } from "../effect-base";
import { TIME_GROUP, animateToggle, mixField, steppedPicture, temporalDefaults, temporalFields, type LayerEffectTypeDef } from "./shared";

/** One option per material — the material select and the morph target read the same list. */
const MATERIAL_OPTIONS: EffectFieldOption[] = [
  { value: "paper", label: "Paper", hint: "Cotton drawing paper — fine tooth, soft fibres." },
  { value: "kraft", label: "Kraft", hint: "Warm brown, long fibres, flecks of pulp." },
  { value: "blackCard", label: "Black card", hint: "Dark cardstock with pale fibres. Made for chalk." },
  { value: "linen", label: "Linen", hint: "A fine plain weave — every thread over and under." },
  { value: "canvas", label: "Canvas", hint: "Coarse primed cloth." },
  { value: "felt", label: "Felt", hint: "Soft matted fibres that fuzz every edge." },
  { value: "cardboard", label: "Cardboard", hint: "A kraft liner over corrugated flutes." },
  { value: "crumpled", label: "Crumpled paper", hint: "Folds and creases catching the light." },
  { value: "watercolor", label: "Watercolour paper", hint: "Cold-press pits and a blotchy wash; with Edge, pigment pools at the rim." },
  { value: "clay", label: "Clay", hint: "Pressed lumps, fingerprints and tool drags; puffy with Lift." },
  { value: "blueprint", label: "Blueprint", hint: "Prussian-blue cyanotype paper with a drafting grid in it." },
  { value: "newsprint", label: "Newsprint", hint: "Grey groundwood pulp, short fibres, specks of bark." },
  { value: "wood", label: "Wood", hint: "A planed board: rings, latewood lines and pores along the grain." },
  { value: "graph", label: "Graph paper", hint: "A printed grid that shows through what is drawn on it." },
  { value: "foil", label: "Holographic foil", hint: "A rainbow that lives in the angle. Key the light to make it shimmer." },
  { value: "chrome", label: "Liquid chrome", hint: "Inflated, mirror-finished, a studio horizon in every curve." },
  { value: "neon", label: "Neon", hint: "Every edge a glowing glass tube, on a brick wall." },
  { value: "stainedGlass", label: "Stained glass", hint: "Hammered panes held in lead, light coming through." },
  { value: "frosted", label: "Frosted glass", hint: "The picture seen through etched glass." },
  { value: "crystal", label: "Crystal", hint: "Cut facets that catch the light one by one." },
  { value: "soapFilm", label: "Soap film", hint: "A clear bubble with swirling rainbow bands." },
  { value: "ferrofluid", label: "Ferrofluid", hint: "Wet black mirror. Raise Edge and it spikes." },
  { value: "kintsugi", label: "Kintsugi", hint: "Glazed ceramic, mended with gold." },
  { value: "tufted", label: "Tufted rug", hint: "Loops of yarn in soft pillows of pile." },
  { value: "phosphor", label: "CRT phosphor", hint: "Red, green and blue stripes, blooming." },
  { value: "ricePaper", label: "Rice paper", hint: "Long fibres. With Edge, ink bleeds along them." },
  { value: "marble", label: "Marbling", hint: "The picture floated on water and combed into swirls." },
];

/**
 * SURFACE — the texture family: the material a picture is printed on or made
 * of. The maths is `animation/surface.ts`; this is what the card offers.
 */
export const SURFACE_EFFECT_TYPES: LayerEffectTypeDef[] = [
  {
    type: "surface",
    // A fibre and a thread are sizes in frame px — the picture of a material
    // changes with the grid it is rendered on.
    gridBound: true,
    label: "Surface",
    blurb: "Makes the picture out of a real material — paper, felt, clay, foil, chrome, neon, glass — and morphs between them.",
    category: "texture",
    tags: ["texture", "paper", "kraft", "card", "cardstock", "linen", "canvas", "felt", "cardboard", "crumpled", "watercolour", "watercolor", "clay", "plasticine", "blueprint", "cyanotype", "newsprint", "newspaper", "wood", "woodgrain", "graph paper", "grid", "notebook", "foil", "holographic", "hologram", "iridescent", "chrome", "metal", "mirror", "neon", "glow", "stained glass", "glass", "frosted", "crystal", "gem", "soap", "bubble", "ferrofluid", "kintsugi", "gold", "ceramic", "tufted", "rug", "yarn", "crt", "phosphor", "rice paper", "ink bleed", "marbling", "suminagashi", "morph", "transform", "emboss", "deboss", "letterpress", "material", "cut out", "stop motion", "craft", "fibre", "tooth", "relief", "handmade"],
    editor: { width: 400 },
    // Moves only when it re-rolls; a still sheet is a single cached picture.
    timeDriven: (fx) => fx.type === "surface" && fx.animate,
    picture: steppedPicture(),
    groups: [
      { id: "material", label: "Material" },
      { id: "light", label: "Light" },
      { id: "cut", label: "Cut" },
      { id: "behaviour", label: "Behaviour" },
      { id: "morph", label: "Morph" },
      TIME_GROUP,
    ],
    fields: [
      {
        key: "texture",
        label: "Texture",
        kind: "image",
        group: "material",
        empty: "Material's own",
        hint: "The sheet's pattern. Drop in your own image — a scan, a photo — and the material lights it.",
      },
      { key: "textureColor", label: "Its colour", kind: "number", min: 0, max: 1, step: 0.01, group: "material", showIf: { key: "texture", equals: [""], not: true }, hint: "Print the texture's own colours. At 0 only its relief and tone show." },
      {
        key: "textureTiling",
        label: "Tiling",
        kind: "select",
        group: "material",
        showIf: { key: "texture", equals: [""], not: true },
        options: [
          { value: "repeat", label: "Repeat", hint: "As it is. Best for textures made to tile." },
          { value: "mirror", label: "Mirror", hint: "Flipped at every edge, so any picture tiles without a seam." },
        ],
      },
      {
        key: "material",
        label: "Material",
        kind: "select",
        group: "material",
        preview: "material",
        options: MATERIAL_OPTIONS,
        hint: "With your own texture, this is how it behaves: felt pillows, foil shines, neon glows.",
      },
      { key: "scale", label: "Scale", kind: "number", min: 0.25, max: 8, step: 0.05, unit: "×", scaled: true, group: "material", hint: "Size of the fibres, threads and folds." },
      { key: "tooth", label: "Tooth", kind: "number", min: 0, max: 4, step: 0.01, unit: "×", group: "material", hint: "The fine grain of the surface." },
      {
        key: "colorMode",
        label: "Colour",
        kind: "select",
        group: "material",
        options: [
          { value: "lit", label: "Keep colours", hint: "The picture keeps its colours and takes the material's light." },
          { value: "multiply", label: "Print on it", hint: "The picture is printed onto the material's own colour." },
          { value: "under", label: "Sheet under", hint: "The material replaces the background." },
          { value: "blind", label: "Blind", hint: "No ink: only the relief shows, like a blind emboss." },
        ],
      },
      { key: "dye", label: "Dye", kind: "color", group: "material", showIf: { key: "colorMode", equals: ["multiply", "under"] }, hint: "Tints the material. White keeps its own colour." },
      mixField("material"),

      { key: "relief", label: "Relief", kind: "number", min: 0, max: 4, step: 0.01, unit: "×", group: "light", hint: "How deep the surface reads." },
      { key: "lightAngle", label: "Angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", bipolar: true, group: "light", hint: "Where the light comes from. −90° is straight above." },
      { key: "lights", label: "Spare lights", kind: "number", min: 0, max: 1, step: 0.01, group: "light", hint: "Light in the picture (an ember, a laser, a lit sign) passes through the material untouched." },
      {
        key: "lightsFrom",
        label: "Lights",
        kind: "select",
        group: "light",
        options: [
          { value: "layers", label: "Light layers", hint: "Layers marked Emits light, glow and all." },
          { value: "colour", label: "Coloured pixels", hint: "For video and photos: anything with a colour. White and grey still take the material." },
        ],
      },

      { key: "lift", label: "Lift", kind: "number", min: -200, max: 200, step: 0.5, unit: "px", scaled: true, bipolar: true, group: "cut", hint: "Shapes stand off the sheet like cut paper. Below 0 they press into it, like letterpress." },
      { key: "shadow", label: "Shadow", kind: "number", min: 0, max: 1, step: 0.01, group: "cut", hint: "The shadow a lifted shape casts." },
      { key: "edge", label: "Edge", kind: "number", min: 0, max: 1, step: 0.01, group: "cut", hint: "How much the material eats the edge: torn fibres, felt fuzz." },
      { key: "breakup", label: "Breakup", kind: "number", min: 0, max: 1, step: 0.01, group: "cut", hint: "Ink skips the low grain, like chalk or a dry brush." },

      { key: "body", label: "Body", kind: "number", min: 0, max: 4, step: 0.01, unit: "×", group: "behaviour", hint: "How round a piece is: felt's pillow, clay's dome, chrome's bulge, neon's tube." },
      { key: "sheen", label: "Sheen", kind: "number", min: 0, max: 4, step: 0.01, unit: "×", group: "behaviour", hint: "Highlights, foil's rainbow, chrome's reflection." },
      { key: "glow", label: "Glow", kind: "number", min: 0, max: 4, step: 0.01, unit: "×", group: "behaviour", hint: "The light it gives off: neon, phosphor, glass." },
      { key: "flow", label: "Flow", kind: "number", min: 0, max: 4, step: 0.01, unit: "×", group: "behaviour", hint: "How far the material carries the picture: marbling, frost." },

      { key: "to", label: "Into", kind: "select", group: "morph", preview: "material", options: [{ value: "none", label: "Nothing" }, ...MATERIAL_OPTIONS], hint: "The material this one becomes as Morph goes to 1." },
      { key: "morph", label: "Morph", kind: "number", min: 0, max: 1, step: 0.01, group: "morph", showIf: { key: "to", equals: SURFACE_MATERIALS }, hint: "How far it has become the other material. Key it." },
      {
        key: "morphStyle",
        label: "Front",
        kind: "select",
        group: "morph",
        showIf: { key: "to", equals: SURFACE_MATERIALS },
        options: [
          { value: "spread", label: "Spread", hint: "Patches appear and grow until they meet." },
          { value: "sweep", label: "Sweep", hint: "A ragged front crosses from the light's side." },
          { value: "fade", label: "Fade", hint: "All of it at once." },
        ],
      },

      ...temporalFields(),
    ],
    toggles: [animateToggle("time")],
    // What playback may drop when the frame budget is blown: the cut reads the
    // picture's pixels every frame it changes (≈50 ms at 1080×1920 on an M1
    // with lift and edge), the lit sheet alone stays on the GPU. Export never
    // degrades.
    fidelity: [{ edge: 0 }, { edge: 0, breakup: 0, lift: 0 }],
    create: () => ({
      id: createId("lfx"),
      type: "surface",
      enabled: true,
      animate: false,
      ...temporalDefaults({ rate: 12 }),
      material: "paper",
      texture: "",
      textureColor: 0,
      textureTiling: "repeat",
      scale: 1,
      relief: 1,
      tooth: 1,
      lightAngle: -45,
      colorMode: "lit",
      dye: "#ffffff",
      edge: 0,
      lift: 0,
      shadow: 0.5,
      breakup: 0,
      body: 1,
      sheen: 1,
      glow: 1,
      flow: 1,
      to: "none",
      morph: 0,
      morphStyle: "spread",
      lights: 0,
      lightsFrom: "layers",
      mix: 1,
    }),
  },
];
