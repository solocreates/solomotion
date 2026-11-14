"use client";

import {
  AudioLines,
  Crosshair,
  FolderInput,
  FolderOpen,
  BookOpen,
  Boxes,
  Brush,
  Clapperboard,
  Eye,
  FileSearch,
  Film,
  Flag,
  FunctionSquare,
  Group,
  ImagePlus,
  Layers,
  ListTree,
  Mic,
  MousePointer2,
  Palette,
  PenTool,
  Plus,
  Scissors,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  Type,
  Users,
  Waypoints,
  Wand2,
  type LucideIcon,
} from "lucide-react";

/**
 * How a tool call reads in the chat: a verb phrase and an icon, derived from
 * the command and its input. "Create text “Summer sale”" rather than
 * `layer_create {"kind":"text",...}` — the raw call is one click away for
 * anyone who wants it, but the trail should read like work being done.
 */

export interface ToolLabel {
  icon: LucideIcon;
  /** Present tense while running, past once done. */
  running: string;
  done: string;
}

const q = (s: unknown, n = 36) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t ? `“${t.length > n ? `${t.slice(0, n - 1)}…` : t}”` : "";
};

const keys = (o: unknown, n = 3) => {
  const k = o && typeof o === "object" ? Object.keys(o) : [];
  return k.length > n ? `${k.slice(0, n).join(", ")} +${k.length - n}` : k.join(", ");
};

type Input = Record<string, unknown>;

const TABLE: Record<string, (i: Input) => ToolLabel> = {
  doc_overview: () => ({ icon: ListTree, running: "Reading the project", done: "Read the project" }),
  layers_list: () => ({ icon: Layers, running: "Listing layers", done: "Listed layers" }),
  layer_get: (i) => ({ icon: Search, running: `Reading ${i.id}`, done: `Read ${i.id}` }),
  layer_properties: (i) => ({ icon: Settings2, running: `Reading properties of ${i.id}`, done: `Read properties of ${i.id}` }),
  api_describe: (i) => ({ icon: BookOpen, running: `Looking up ${i.type}${i.path ? `.${i.path}` : ""}`, done: `Looked up ${i.type}${i.path ? `.${i.path}` : ""}` }),
  catalog_list: (i) => ({ icon: BookOpen, running: `Browsing ${i.catalog}${i.query ? ` for ${q(i.query)}` : ""}`, done: `Browsed ${i.catalog}` }),
  catalog_get: (i) => ({ icon: BookOpen, running: `Reading ${i.id}`, done: `Read ${i.id}` }),
  media_list: () => ({ icon: Film, running: "Checking media", done: "Checked media" }),
  layer_create: (i) => {
    const what = i.kind === "text" ? `text ${q(i.text)}` : i.kind === "shape" ? `${i.shape ?? "shape"}` : String(i.kind ?? "layer");
    return { icon: i.kind === "text" ? Type : i.kind === "path" ? PenTool : Plus, running: `Creating ${what}`, done: `Created ${what}` };
  },
  layer_set: (i) => ({ icon: Settings2, running: `Setting ${keys(i.values)}`, done: `Set ${keys(i.values)}` }),
  layer_patch: (i) => ({ icon: Wand2, running: `Editing ${i.id}`, done: `Edited ${i.id}` }),
  layer_pivot: () => ({ icon: Crosshair, running: "Moving the pivot", done: "Moved the pivot" }),
  project_list: (i) => ({ icon: FolderOpen, running: i.id ? "Looking in a project" : "Listing your projects", done: i.id ? "Looked in a project" : "Listed your projects" }),
  project_import: (i) => ({ icon: FolderInput, running: `Bringing in from ${q(i.from)}`, done: `Brought in from ${q(i.from)}` }),
  text_set: (i) => ({ icon: Type, running: `Writing ${q(i.text)}`, done: `Wrote ${q(i.text)}` }),
  text_style: (i) => ({ icon: Type, running: `Styling ${i.match ? q(i.match) : "text"}`, done: `Styled ${i.match ? q(i.match) : "text"}` }),
  template_apply: (i) => ({ icon: Sparkles, running: `Applying ${i.templateId}`, done: `Applied ${i.templateId}` }),
  keyframes_set: (i) => ({ icon: Waypoints, running: `Keying ${i.property}`, done: `Keyed ${i.property}` }),
  keyframes_clear: () => ({ icon: Waypoints, running: "Clearing keyframes", done: "Cleared keyframes" }),
  animation_set: (i) => ({
    icon: Waypoints,
    running: i.preset ? `Animating ${i.slot} with ${i.preset}` : `Removing ${i.slot} animation`,
    done: i.preset ? `Animated ${i.slot}: ${i.preset}` : `Removed ${i.slot} animation`,
  }),
  effects_add: (i) => ({ icon: Sparkles, running: `Adding ${i.type}`, done: `Added ${i.type}` }),
  effects_update: () => ({ icon: Sparkles, running: "Tuning an effect", done: "Tuned an effect" }),
  grade_node: (i) => ({ icon: Palette, running: `Grading${i.name ? ` · ${i.name}` : ""}`, done: `Graded${i.name ? ` · ${i.name}` : ""}` }),
  grade_effect: (i) => ({ icon: Palette, running: `Adding ${i.type} to the grade`, done: `Added ${i.type} to the grade` }),
  grade_read: () => ({ icon: Palette, running: "Reading the grade", done: "Read the grade" }),
  expression_set: (i) => ({ icon: FunctionSquare, running: `Linking ${i.property}`, done: i.source === null ? `Unlinked ${i.property}` : `Linked ${i.property}` }),
  expression_reference: () => ({ icon: FunctionSquare, running: "Reading the expression language", done: "Read the expression language" }),
  transition_add: (i) => ({ icon: Clapperboard, running: `Adding ${i.preset}`, done: `Added ${i.preset}` }),
  transition_remove: () => ({ icon: Clapperboard, running: "Removing a transition", done: "Removed a transition" }),
  layers_delete: () => ({ icon: Trash2, running: "Deleting", done: "Deleted" }),
  layers_duplicate: () => ({ icon: Boxes, running: "Duplicating", done: "Duplicated" }),
  layers_copy: () => ({ icon: Boxes, running: "Copying into the comp", done: "Copied into the comp" }),
  layers_group: (i) => ({ icon: Group, running: `Grouping${i.layout ? " with auto layout" : ""}`, done: `Grouped${i.name ? ` ${q(i.name)}` : ""}` }),
  layers_ungroup: () => ({ icon: Group, running: "Ungrouping", done: "Ungrouped" }),
  layers_nest: (i) => ({ icon: Boxes, running: "Nesting into a comp", done: `Nested${i.name ? ` ${q(i.name)}` : ""}` }),
  layout_set: () => ({ icon: Group, running: "Adjusting auto layout", done: "Adjusted auto layout" }),
  layers_restack: () => ({ icon: Layers, running: "Reordering", done: "Reordered" }),
  timeline_move: () => ({ icon: Clapperboard, running: "Moving in time", done: "Moved in time" }),
  timeline_trim: () => ({ icon: Scissors, running: "Trimming", done: "Trimmed" }),
  timeline_split: () => ({ icon: Scissors, running: "Cutting", done: "Cut" }),
  timeline_close_gaps: () => ({ icon: Scissors, running: "Closing gaps", done: "Closed gaps" }),
  timeline_compact: () => ({ icon: Layers, running: "Tidying lanes", done: "Tidied lanes" }),
  timeline_cut_ranges: (i) => ({ icon: Scissors, running: "Cutting", done: `Cut ${Array.isArray(i.ranges) ? i.ranges.length : ""} range${Array.isArray(i.ranges) && i.ranges.length === 1 ? "" : "s"}` }),
  frame_create: (i) => ({ icon: Plus, running: `Creating comp ${q(i.name)}`, done: `Created comp ${q(i.name)}` }),
  frame_duplicate: (i) => ({ icon: Boxes, running: "Duplicating the comp", done: `Duplicated the comp${i.name ? ` as ${q(i.name)}` : ""}` }),
  frame_update: () => ({ icon: Settings2, running: "Editing the comp", done: "Edited the comp" }),
  frame_delete: () => ({ icon: Trash2, running: "Deleting a comp", done: "Deleted a comp" }),
  page_create: (i) => ({ icon: Plus, running: `Adding page ${q(i.name)}`, done: `Added page ${q(i.name)}` }),
  history_undo: () => ({ icon: Wand2, running: "Undoing my last step", done: "Undid my last step" }),
  api_batch: (i) => {
    // While the input streams, the call list is not parseable yet — say so without a count.
    const n = Array.isArray(i.calls) ? i.calls.length : 0;
    return { icon: Boxes, running: n ? `Running ${n} steps` : "Planning steps", done: n ? `Ran ${n} steps` : "Ran steps" };
  },
  view_render: (i) => ({ icon: Eye, running: `Looking${i.layers ? " closely" : ""}`, done: `Looked${i.atMs !== undefined ? ` at ${Math.round(Number(i.atMs))}ms` : ""}` }),
  view_frames: () => ({ icon: Film, running: "Watching the motion", done: "Watched the motion" }),
  session_set: () => ({ icon: MousePointer2, running: "Updating the view", done: "Updated the view" }),
  media_import: () => ({ icon: ImagePlus, running: "Importing media", done: "Imported media" }),
  media_inspect: () => ({ icon: FileSearch, running: "Studying the reference", done: "Studied the reference" }),
  audio_analyze: () => ({ icon: AudioLines, running: "Listening to the audio", done: "Measured the audio" }),
  media_transcribe: (i) => ({ icon: Mic, running: i.lyrics ? "Timing the lyrics" : "Transcribing", done: i.lyrics ? "Timed the lyrics" : i.captions ? "Transcribed and captioned" : "Transcribed" }),
  generate_image: (i) =>
    i.edit
      ? { icon: ImagePlus, running: `Editing image ${q(i.prompt, 24)}`, done: `Edited image ${q(i.prompt, 24)}` }
      : { icon: ImagePlus, running: `Drawing ${q(i.prompt, 28)}`, done: `Drew ${q(i.prompt, 28)}` },
  media_remove_background: () => ({ icon: ImagePlus, running: "Removing the background", done: "Removed the background" }),
  media_upscale: (i) => ({ icon: ImagePlus, running: `Upscaling ${i.factor ?? 2}×`, done: `Upscaled ${i.factor ?? 2}×` }),
  media_remove_pauses: (i) => ({ icon: Scissors, running: "Removing pauses", done: i.dryRun ? "Found the pauses" : "Removed pauses" }),
  audio_isolate: () => ({ icon: AudioLines, running: "Cleaning up the voice", done: "Cleaned up the voice" }),
  voices_list: () => ({ icon: AudioLines, running: "Listening to voices", done: "Picked from the voices" }),
  generate_sound: (i) => ({ icon: AudioLines, running: `Designing ${q(i.prompt, 28)}`, done: `Made ${q(i.prompt, 28)}` }),
  generate_music: (i) => ({ icon: AudioLines, running: `Composing ${q(i.prompt, 28)}`, done: `Composed ${q(i.prompt, 28)}` }),
  generate_speech: (i) => ({ icon: AudioLines, running: `Voicing ${q(i.text, 28)}`, done: `Voiced ${q(i.text, 28)}` }),
  generate_video: (i) =>
    i.edit
      ? { icon: Film, running: `Editing video ${q(i.prompt, 24)}`, done: `Edited video ${q(i.prompt, 24)}` }
      : { icon: Film, running: `${i.from ? "Animating" : "Shooting"} ${q(i.prompt, 24)}`, done: `${i.from ? "Animated" : "Shot"} ${q(i.prompt, 24)}` },
  font_install: () => ({ icon: Type, running: "Installing a font", done: "Installed a font" }),
  sounds_list: (i) => ({ icon: AudioLines, running: i.query ? `Searching sounds for ${q(i.query)}` : "Browsing sounds", done: i.query ? `Searched sounds for ${q(i.query)}` : "Browsed sounds" }),
  sounds_use: () => ({ icon: AudioLines, running: "Fetching the sound", done: "Added the sound" }),
  app_console: () => ({ icon: Terminal, running: "Reading the console", done: "Read the console" }),
  skill_read: (i) => ({ icon: BookOpen, running: `Reading ${i.path}`, done: `Read ${i.path}` }),
  report_issue: (i) => ({ icon: Flag, running: "Filing a report", done: `Reported ${q(i.title, 40)}` }),
  agent_delegate: (i) => ({ icon: Users, running: String(i.label ?? "Delegating"), done: String(i.label ?? "Delegated") }),
};

export function toolLabel(name: string, input: unknown): ToolLabel {
  const f = TABLE[name];
  const i = (input && typeof input === "object" ? input : {}) as Input;
  if (f) {
    try {
      return f(i);
    } catch {
      /* fall through to the generic label */
    }
  }
  const words = name.replace(/_/g, " ");
  return { icon: name.startsWith("plugin") ? Brush : Wand2, running: words, done: words };
}
