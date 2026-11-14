"use client";

import * as React from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowLeftRight,
  Combine,
  Copy,
  FlipHorizontal2,
  Link2,
  MousePointer2,
  Minus,
  MoreHorizontal,
  PenTool,
  RotateCcw,
  Scissors,
  Sparkles,
  Spline,
  SplitSquareHorizontal,
  Square,
  SquarePlus,
  Trash2,
  Triangle,
  Unlink,
  Waypoints,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DocColorInput } from "../inspector/DocColorInput";
import { FontPicker } from "../inspector/FontPicker";
import { fontPickPatch } from "../fonts/library";
import { StyleFields } from "../inspector/StyleFields";
import { isShapeTool, useSession, type ShapeTool, type Tool } from "../state/session";
import { useToolDefaults } from "../state/tool-defaults";
import { G, IconSeg, ModeSeg, MoreRow, Opt, ToolMore, pod } from "./tool-bar-kit";
import { usePenBar, type PenAction } from "./pen-bar";

/**
 * THE VECTOR TOOLS' SECTIONS — pen, shapes, and type.
 *
 * All three used to live in the RIGHT PANEL, as `ToolDefaultsInspector`: arm
 * the rectangle tool with nothing selected and the inspector showed "Shape
 * defaults". That file is deleted, and the reason is a rule rather than a
 * preference — see `tool-bar-kit.tsx`. The panel belongs to the thing you have
 * SELECTED. Putting the tool's own settings there meant they were reachable
 * only by deselecting, they vanished the instant you clicked your own artwork,
 * and they sat on the opposite side of the screen from the hand holding the
 * tool. Two tools (pen, brush) had bars AND panels that disagreed about which
 * was authoritative.
 *
 * ── THESE EDIT THE TOOL, NEVER THE SELECTION ──
 *
 * Stated because it is the one genuine ambiguity, and leaving it ambiguous is
 * what a control like this normally gets wrong. Everything in this file writes
 * `tool-defaults` — what the NEXT object you draw will look like. Nothing here
 * can change a layer you have already made, whatever is selected, ever. The
 * inspector is where an existing layer is edited, and it stays that way, so
 * there is no state in which picking a colour up here silently restyles
 * something you had forgotten was picked.
 */

// ── Pen ─────────────────────────────────────────────────────────────────────

/**
 * The PEN section — the pen's sub-tools, what the next path looks like, and
 * the verbs for the nodes under your hand.
 *
 * The live node context arrives through `usePenBar`, because it is genuinely
 * born inside `VectorOverlay`; the overlay pushes it out rather than this
 * reaching in.
 */
export function PenSection() {
  const ctx = usePenBar((s) => s.ctx);
  const dispatch = usePenBar((s) => s.dispatch);
  const pen = useToolDefaults((s) => s.pen);
  const setPen = useToolDefaults((s) => s.setPen);
  const junction = useToolDefaults((s) => s.penJunction);
  const setJunction = useToolDefaults((s) => s.setPenJunction);

  const nodes = ctx?.nodeCount ?? 0;
  const mode = usePenBar((s) => s.mode);
  const setMode = usePenBar((s) => s.setMode);
  const tool = useSession((s) => s.tool);

  return (
    <>
      {/* VECTOR-EDIT MODES (D12) — one capsule, icon + word, the modifier that
          reaches each one momentarily in its tooltip. Only modes this app has:
          a mode button that does nothing is worse than no button. */}
      {ctx?.editing && (
        <G>
          <ModeSeg
            value={tool === "cut" ? "cut" : mode}
            onChange={(v) => {
              if (v === "cut") useSession.getState().setTool("cut");
              else {
                setMode(v);
                if (useSession.getState().tool !== "pen") useSession.getState().setTool("pen");
              }
            }}
            options={[
              { v: "move", icon: MousePointer2, label: "Move", tip: "Move points and handles" },
              { v: "bend", icon: Spline, label: "Bend", tip: "Drag a segment to bend it — hold", kbd: "⌘" },
              { v: "cut", icon: Scissors, label: "Cut", tip: "Cut paths" },
            ]}
          />
        </G>
      )}

      {/* IDENTITY (pen ↔ knife) is the bar's own `ToolSwitch`, from the tool
          registry. This section had hand-rolled a segmented control for it,
          which is a second answer to "what are my siblings" and disagreed with
          the rail the moment either list changed. */}

      {/* PAINT — what the next path is made of. Bound like every other colour
          in the app, so a pen default set from a palette variable makes paths
          that follow the palette. */}
      <G>
        <Opt label="Stroke">
          <DocColorInput variant="badge" value={pen.stroke} onChange={(stroke) => setPen({ stroke })} />
        </Opt>
        <NumberInput
          value={pen.strokeWidth}
          min={0.5}
          max={200}
          step={0.5}
          precision={1}
          unit="px"
          className="w-16"
          onChange={(strokeWidth) => setPen({ strokeWidth })}
        />
        <Opt label="Fill">
          <DocColorInput variant="badge" value={pen.fill} onChange={(fill) => setPen({ fill })} />
        </Opt>
      </G>

      {/*
       * WHAT HAPPENS WHEN A STROKE ENDS ON ANOTHER PATH — both answers, visible.
       *
       * This was ONE button showing a chain or a broken chain, opening a menu
       * to change it. That is the shape that cannot be read: a single glyph
       * that is sometimes a state and sometimes a verb leaves you unable to
       * tell whether the chain means "connecting is on" or "press to connect",
       * and the only way to find out was to open the menu and look at which
       * radio was filled.
       *
       * A segmented control has no such question. Both outcomes are on screen,
       * exactly one is armed, and switching is the click you were going to make
       * anyway instead of a click plus a menu plus a click.
       */}
      <G>
        <IconSeg
          value={junction.connect ? "connect" : "apart"}
          onChange={(v) => setJunction({ connect: v === "connect" })}
          options={[
            { v: "connect", icon: Link2, label: "Ending on another path joins them" },
            { v: "apart", icon: Unlink, label: "Ending on another path leaves them separate" },
          ]}
        />
      </G>

      {/* MODES — the nodes under your hand. Only the verbs you reach for
          mid-gesture earn a pod; the rest are real but rare. */}
      <G>
        {nodes > 0 && (
          <>
            <PenVerb label="Smooth" shortcut="⇧S" icon={Spline} onClick={() => dispatch("smooth")} />
            <PenVerb label="Corner" shortcut="⇧C" icon={Triangle} onClick={() => dispatch("corner")} />
            <PenVerb
              label={nodes > 1 ? `Delete ${nodes} nodes` : "Delete node"}
              shortcut="⌫"
              icon={Trash2}
              onClick={() => dispatch("deleteNode")}
            />
          </>
        )}
        {ctx?.editing && <PenOverflow ctx={ctx} dispatch={dispatch} />}
      </G>

      <G>
        <ToolMore title="Pen">
          <MoreRow label="Ask at each junction">
            <Switch checked={junction.ask} onCheckedChange={(ask) => setJunction({ ask })} />
          </MoreRow>
        </ToolMore>
      </G>
    </>
  );
}

function PenVerb({
  label,
  shortcut,
  icon: Icon,
  onClick,
}: {
  label: string;
  shortcut?: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} className={pod()}>
          <Icon />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut && <kbd className="ml-1.5 rounded bg-secondary px-1 font-mono text-[10px]">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Real but rare — every path verb the selection currently supports. */
function PenOverflow({
  ctx,
  dispatch,
}: {
  ctx: NonNullable<ReturnType<typeof usePenBar.getState>["ctx"]>;
  dispatch: (a: PenAction) => void;
}) {
  const hasSel = ctx.nodeCount > 0;
  const multi = ctx.nodeCount >= 2;
  const ALIGN: Array<[PenAction, string, React.ComponentType<{ className?: string }>]> = [
    ["alignL", "Align left", AlignStartVertical],
    ["alignH", "Align centre", AlignCenterVertical],
    ["alignR", "Align right", AlignEndVertical],
    ["alignT", "Align top", AlignStartHorizontal],
    ["alignV", "Align middle", AlignCenterHorizontal],
    ["alignB", "Align bottom", AlignEndHorizontal],
  ];
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More path actions" className={pod()}>
              <MoreHorizontal />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">More path actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-52">
        {hasSel && (
          <>
            <DropdownMenuItem onClick={() => dispatch("mirror")}>
              <FlipHorizontal2 /> Mirror handles
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => dispatch("reset")}>
              <RotateCcw /> Reset handles
            </DropdownMenuItem>
          </>
        )}
        {ctx.singleNode && (
          <DropdownMenuItem onClick={() => dispatch("break")}>
            <SplitSquareHorizontal /> Break path here
          </DropdownMenuItem>
        )}
        {ctx.endpointPair && (
          <DropdownMenuItem onClick={() => dispatch("join")}>
            <Link2 /> Join endpoints
          </DropdownMenuItem>
        )}
        {/* SEGMENT verbs. `ctx.segment` is set by the same brain the stage menu
            and the keyboard read, so the three can never offer different
            answers about what the selection supports. */}
        {ctx.segment && (
          <>
            <DropdownMenuItem onClick={() => dispatch(ctx.segment === "line" ? "toCurve" : "toLine")}>
              {ctx.segment === "line" ? <Spline /> : <Minus />}
              {ctx.segment === "line" ? "Convert to curve" : "Convert to line"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => dispatch("insertPoint")}>
              <SquarePlus /> Add point
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => dispatch("duplicateSeg")}>
              <Copy /> Duplicate segment
            </DropdownMenuItem>
          </>
        )}
        {ctx.adjacentPair && (
          <DropdownMenuItem onClick={() => dispatch("deleteSeg")}>
            <Minus /> Delete segment
          </DropdownMenuItem>
        )}
        {ctx.anyOpen && (
          <DropdownMenuItem onClick={() => dispatch("close")}>
            <Waypoints /> Close path
          </DropdownMenuItem>
        )}
        {ctx.anyClosed && (
          <DropdownMenuItem onClick={() => dispatch("open")}>
            <Unlink /> Open path
          </DropdownMenuItem>
        )}
        {multi && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => dispatch("average")}>
              <Combine /> Average points
            </DropdownMenuItem>
            {ALIGN.map(([a, label, Icon]) => (
              <DropdownMenuItem key={a} onClick={() => dispatch(a)}>
                <Icon /> {label}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => dispatch("reverse")}>
          <ArrowLeftRight /> Reverse direction
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => dispatch("simplify")}>
          <Sparkles /> Simplify path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/**
 * WHICH GEOMETRY NUMBER EARNS A PLACE ON THE BAR, per shape tool.
 *
 * One table, because the alternative is a `switch` in the section and a second
 * one in the overflow that has to stay its exact complement. Each tool names
 * the ONE parameter you set before dragging — the count of a star, the round of
 * a rect — and everything else it has goes behind the shared More door.
 *
 * `null` means the tool has no primary: a triangle is a triangle.
 */
const SHAPE_PRIMARY: Record<ShapeTool, "cornerRadius" | "polygonPoints" | "starPoints" | "arcSweepDeg" | null> = {
  rect: "cornerRadius",
  ellipse: "arcSweepDeg",
  triangle: null,
  polygon: "polygonPoints",
  star: "starPoints",
};

/**
 * SHAPE — fill, stroke, and the one number this particular shape is about.
 *
 * Stroke is a TOGGLE that reveals its own controls, rather than a permanently
 * mounted colour and weight that do nothing while it is off. Options that
 * appear when the switch that needs them is on is the pattern the whole bar
 * follows; a disabled field teaches nothing and costs the same width.
 */
export function ShapeSection() {
  const tool = useSession((s) => s.tool);
  const shape = useToolDefaults((s) => s.shape);
  const set = useToolDefaults((s) => s.setShape);
  if (!isShapeTool(tool)) return null;
  const primary = SHAPE_PRIMARY[tool];
  const round = tool === "rect" ? "cornerRadius" : "vertexRadius";

  return (
    <>
      <G>
        <Opt label="Fill">
          <DocColorInput variant="badge" value={shape.fill} onChange={(fill) => set({ fill })} />
        </Opt>
      </G>

      <G>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Stroke"
              aria-pressed={shape.strokeOn}
              onClick={() => set({ strokeOn: !shape.strokeOn })}
              className={pod(shape.strokeOn)}
            >
              <Square strokeWidth={3} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Stroke {shape.strokeOn ? "on" : "off"}</TooltipContent>
        </Tooltip>
        {shape.strokeOn && (
          <>
            <DocColorInput variant="badge" value={shape.stroke} onChange={(stroke) => set({ stroke })} />
            <NumberInput
              value={shape.strokeWidth}
              min={0.5}
              max={200}
              step={0.5}
              precision={1}
              unit="px"
              className="w-16"
              onChange={(strokeWidth) => set({ strokeWidth })}
            />
          </>
        )}
      </G>

      <G>
        {primary === "cornerRadius" && (
          <Opt label="Round">
            <NumberInput
              value={shape.cornerRadius}
              min={0}
              max={9999}
              precision={0}
              unit="px"
              className="w-18"
              onChange={(cornerRadius) => set({ cornerRadius })}
            />
          </Opt>
        )}
        {primary === "polygonPoints" && (
          <Opt label="Sides">
            <NumberInput
              value={shape.polygonPoints}
              min={3}
              max={64}
              precision={0}
              className="w-14"
              onChange={(polygonPoints) => set({ polygonPoints: Math.round(polygonPoints) })}
            />
          </Opt>
        )}
        {primary === "starPoints" && (
          <>
            <Opt label="Points">
              <NumberInput
                value={shape.starPoints}
                min={3}
                max={64}
                precision={0}
                className="w-14"
                onChange={(starPoints) => set({ starPoints: Math.round(starPoints) })}
              />
            </Opt>
            <Opt label="Depth">
              <NumberInput
                value={Math.round(shape.innerRatio * 100)}
                min={1}
                max={99}
                precision={0}
                unit="%"
                className="w-16"
                onChange={(v) => set({ innerRatio: v / 100 })}
              />
            </Opt>
          </>
        )}
        {primary === "arcSweepDeg" && (
          <Opt label="Sweep">
            <NumberInput
              value={shape.arcSweepDeg}
              min={1}
              max={360}
              precision={0}
              unit="°"
              className="w-18"
              onChange={(arcSweepDeg) => set({ arcSweepDeg })}
            />
          </Opt>
        )}
      </G>

      <G>
        <ToolMore title="Next shape">
          <MoreRow label={tool === "rect" ? "Corner round" : "Vertex round"}>
            <NumberInput
              value={round === "cornerRadius" ? shape.cornerRadius : shape.vertexRadius}
              min={0}
              max={9999}
              precision={0}
              unit="px"
              className="w-24"
              onChange={(v) => set(round === "cornerRadius" ? { cornerRadius: v } : { vertexRadius: v })}
            />
          </MoreRow>
          {tool === "ellipse" && (
            <>
              <MoreRow label="Start angle">
                <NumberInput
                  value={shape.arcStartDeg}
                  min={0}
                  max={360}
                  precision={0}
                  unit="°"
                  className="w-24"
                  onChange={(arcStartDeg) => set({ arcStartDeg })}
                />
              </MoreRow>
              <MoreRow label="Inner hole">
                <NumberInput
                  value={Math.round(shape.arcRatio * 100)}
                  min={0}
                  max={99}
                  precision={0}
                  unit="%"
                  className="w-24"
                  onChange={(v) => set({ arcRatio: v / 100 })}
                />
              </MoreRow>
            </>
          )}
        </ToolMore>
      </G>
    </>
  );
}

// ── Type ────────────────────────────────────────────────────────────────────

const TEXT_ALIGN: Array<{ v: "left" | "center" | "right"; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "left", icon: AlignLeft, label: "Align left" },
  { v: "center", icon: AlignCenter, label: "Align centre" },
  { v: "right", icon: AlignRight, label: "Align right" },
];

/**
 * TYPE — the five things you set before typing, and the whole editor behind the
 * More door.
 *
 * The hardest section to place, and the reason is that type has thirty
 * properties and no natural five. The split used here is the one every design
 * tool converges on: FAMILY, SIZE, COLOUR, ALIGNMENT go on the bar because they
 * are what you change per piece of text; everything else — weight, slant,
 * case, decoration, tracking, leading, highlight — is a style you set once.
 *
 * The door does NOT hold a second, smaller typography editor. It renders
 * `StyleFields`, the exact component a selected text layer's inspector shows,
 * against the tool's own style. One typography editor in the app, two hosts —
 * which is the same thing the defaults panel got right before it was moved, and
 * the only part of it worth keeping.
 */
export function TextSection() {
  const style = useToolDefaults((s) => s.text);
  const setText = useToolDefaults((s) => s.setText);
  return (
    <>
      <G>
        <div className="w-36">
          <FontPicker
            value={style.fontFamily}
            weight={typeof style.fontWeight === "number" ? style.fontWeight : undefined}
            italic={style.italic}
            onChange={(family, face) =>
              setText(
                fontPickPatch(
                  family,
                  { weight: typeof style.fontWeight === "number" ? style.fontWeight : undefined, italic: style.italic },
                  face,
                ),
              )
            }
          />
        </div>
        {/* `fontSize` may hold a `var:`/`expr:` token — a bound or computed
            size. A bar is the wrong place to edit one of those (the binding
            affordances live in the inspector's own field), so the badge shows
            the literal when there is one and the More door handles the rest. */}
        <NumberInput
          value={typeof style.fontSize === "number" ? style.fontSize : undefined}
          min={1}
          max={2000}
          precision={0}
          unit="px"
          className="w-18"
          onChange={(fontSize) => setText({ fontSize })}
        />
      </G>

      <G>
        <DocColorInput variant="badge" value={style.color} onChange={(color) => setText({ color })} />
        <IconSeg value={style.align} onChange={(align) => setText({ align })} options={TEXT_ALIGN} />
      </G>

      <G>
        <ToolMore title="Next text" width="w-[19rem]">
          {/* The inspector's typography editor, reused whole. */}
          <div className="-mx-2 -my-2">
            <StyleFields value={style} set={(patch) => setText(patch)} />
          </div>
        </ToolMore>
      </G>
    </>
  );
}
