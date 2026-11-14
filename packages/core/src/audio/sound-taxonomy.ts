/**
 * THE SOUND TAXONOMY — what a sound effect IS, derived from what it is called.
 *
 * A sound archive lives or dies on whether you can find anything in it. The
 * raw material is not promising: upstream packs arrive as `drop_004.ogg`,
 * `forceField_000.ogg`, `footstep_concrete_002.ogg` — thousands of files whose
 * only metadata is a path. Hand-tagging that is a week of work that is stale
 * the moment a pack updates, and it is exactly the kind of work that gets done
 * badly once and never again.
 *
 * So tags are DERIVED, the same way an icon's are (`iconTags`) and the same way
 * every mechanical fact in a published pack is. Three inputs — the file's path,
 * the pack it came from, and the measured audio — produce a name a human would
 * have written and a tag set a human would have to be paid to write.
 *
 * Headless and pure, so the ONE implementation runs in the ingest script that
 * builds the catalogue AND in the editor when someone publishes their own pack.
 * A sound tagged one way by the pipeline and another way by the app would be a
 * sound that is findable depending on who added it.
 *
 * The category list is CLOSED on purpose. Free tags are a bag of words that
 * cannot be a browse rail; a closed, ordered list is a shelf you can put in a
 * sidebar and still covers everything a motion tool reaches for. Adding one is
 * an arm here — never a special case at a call site.
 *
 * AND EVERY ARM NAMES A SOUND, never a genre it was made for. That rule was
 * learned the expensive way. The list used to carry `game`, which is not a
 * sound — you cannot make one with your mouth — and in an archive assembled
 * from game-asset sites it did what a genre always does among sounds: it
 * became the junk drawer. A quarter of the catalogue landed there, monsters
 * beside coins beside casino chips, and the shelf told a reader nothing except
 * where the file had been downloaded from. Worse, `rpg` as a category word let
 * a PACK name stamp `game` on four hundred files whose own names said sword,
 * door or footstep.
 *
 * So the words that describe a genre or an era — `rpg`, `retro`, `arcade`,
 * `8bit`, `chiptune` — are QUALITIES now, like `heavy` and `metal`. They stay
 * searchable, they modify a shelf, and they no longer pretend to be one.
 */

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export const SOUND_CATEGORIES = [
  "interface",
  "impact",
  "whoosh",
  "digital",
  "magic",
  "creature",
  "foley",
  "human",
  "nature",
  "machine",
  "weapon",
  "ambience",
  "music",
] as const;

export type SoundCategory = (typeof SOUND_CATEGORIES)[number];

/** Shelf labels — the one place a category is spelled for a human. */
export const SOUND_CATEGORY_LABELS: Record<SoundCategory, string> = {
  interface: "Interface",
  impact: "Impacts",
  whoosh: "Whooshes",
  digital: "Digital",
  magic: "Magic",
  creature: "Creatures",
  foley: "Foley",
  human: "Human",
  nature: "Nature",
  machine: "Machines",
  weapon: "Weapons",
  ambience: "Ambience",
  music: "Music",
};

/**
 * Words that place a sound on a shelf, most specific first.
 *
 * Order is the precedence and it is load-bearing: `laser` must win over `gun`
 * (a laser is digital, not a firearm) and `explosion` must win over `impact`.
 * A map keyed by category with ties broken by category order would get both
 * backwards, which is why this is a list and not a record.
 */
const CATEGORY_WORDS: ReadonlyArray<readonly [SoundCategory, readonly string[]]> = [
  ["digital", ["laser", "glitch", "beep", "bleep", "blip", "data", "computer", "scan", "scanner", "sci", "scifi", "robot", "digital", "electronic", "synth", "modem", "static", "interference", "hologram", "forcefield", "force", "teleport", "phaser", "zap", "error", "alarm", "radar", "sonar"]],
  ["interface", ["ui", "interface", "click", "tap", "tick", "toggle", "switch", "select", "confirm", "cancel", "notification", "notify", "message", "menu", "button", "keyboard", "key", "type", "typing", "hover", "scroll", "swipe", "checkbox", "dropdown", "popup", "tooltip", "modal", "dialog", "thock", "clack", "coin", "pickup", "collect", "unlock", "achievement", "checkpoint", "score", "bonus", "level", "win", "lose", "lost", "gameover", "complete", "success", "fail"]],
  ["magic", ["magic", "spell", "potion", "powerup", "enchant", "arcane", "summon", "sparkle", "shimmer", "buff", "heal", "curse", "rune", "wand", "fairy", "holy", "mana"]],
  ["creature", ["monster", "creature", "beast", "zombie", "slime", "dragon", "goblin", "ogre", "orc", "troll", "ghost", "demon", "alien", "roar", "growl", "snarl", "hiss", "squeak", "chirp", "bark", "howl"]],
  ["whoosh", ["whoosh", "swoosh", "swish", "woosh", "whip", "pass", "passby", "sweep", "riser", "rise", "transition", "transitions", "air", "gust", "flyby", "swoop", "reverse", "downer", "fall"]],
  ["weapon", ["gun", "gunshot", "shoot", "shot", "rifle", "pistol", "shotgun", "reload", "sword", "blade", "slash", "arrow", "bow", "explosion", "explode", "detonate", "grenade", "bomb", "cannon", "missile", "knife", "dagger", "axe", "spear", "stab", "holster", "firearm"]],
  ["impact", ["impact", "hit", "punch", "slam", "crash", "boom", "thud", "smash", "break", "shatter", "glass", "crack", "bang", "knock", "collision", "collide", "wham", "stomp", "kick", "blow", "splat", "squish", "slurp", "thump", "whack", "crunch", "crush", "bump", "clang", "destruction"]],
  ["foley", ["footstep", "foot", "step", "walk", "run", "cloth", "fabric", "paper", "page", "book", "door", "drawer", "handle", "zip", "zipper", "wood", "metal", "plastic", "rustle", "creak", "bag", "box", "chest", "lock", "key", "coinjar", "pour", "grab", "drop", "place", "handling", "inventory", "loot", "dice", "card", "chip", "casino", "money", "cash", "token", "shop", "craft", "jump", "kitchen", "drink", "eat", "chew", "bottle", "cup", "phone", "velcro", "rope", "chain", "throw", "slide", "shove", "stack", "scrape", "shuffle"]],
  ["human", ["voice", "vocal", "speak", "say", "shout", "scream", "laugh", "cough", "breath", "breathe", "sigh", "grunt", "hurt", "pain", "cheer", "clap", "applause", "whistle", "hum", "male", "female", "child", "crowd", "roar", "growl", "snarl", "moan", "groan", "yell", "gasp", "death"]],
  ["nature", ["water", "splash", "drip", "rain", "wave", "ocean", "river", "stream", "wind", "storm", "thunder", "lightning", "fire", "flame", "burn", "crackle", "leaf", "leaves", "forest", "bird", "animal", "dog", "cat", "insect", "earth", "snow", "ice"]],
  ["machine", ["engine", "motor", "car", "vehicle", "truck", "train", "plane", "helicopter", "machine", "mechanical", "servo", "hydraulic", "gear", "fan", "drill", "saw", "elevator", "conveyor", "printer", "camera", "shutter"]],
  ["ambience", ["ambience", "ambient", "atmosphere", "atmo", "room", "roomtone", "drone", "bed", "background", "loop", "hum", "rumble", "texture", "pad"]],
  ["music", ["music", "melody", "theme", "song", "track", "stinger", "sting", "jingle", "chord", "note", "piano", "guitar", "drum", "beat", "percussion", "bass", "orchestral", "cinematic", "trailer"]],
];

/**
 * DESCRIPTIVE words worth keeping as tags even though they name no shelf.
 * These are how someone narrows a shelf they are already on — "#heavy impact",
 * "#soft click" — and the list is a filter rather than a vocabulary, so an
 * unlisted word is simply dropped instead of becoming a tag nobody searches.
 */
const QUALITY_WORDS: ReadonlySet<string> = new Set([
  "soft", "hard", "heavy", "light", "deep", "high", "low", "bright", "dark", "warm",
  "sharp", "dull", "crisp", "smooth", "rough", "dry", "wet", "big", "small", "tiny",
  "huge", "fast", "slow", "quick", "long", "short", "subtle", "loud", "quiet",
  "metal", "wood", "glass", "stone", "concrete", "dirt", "grass", "sand", "water",
  "single", "double", "triple", "multi", "layered", "clean", "distorted", "filtered",
  // Genre and era. They describe a sound's FLAVOUR, never what it is, and the
  // day one of them was a category a quarter of the archive filed itself there.
  "retro", "arcade", "8bit", "chiptune", "rpg", "fantasy", "scifi", "horror", "cartoon",
]);

/**
 * Words that carry no information and would otherwise become tags on thousands
 * of files — upstream's own folder names, format noise, and the word "sound".
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "audio", "sound", "sounds", "sfx", "effect", "effects", "wav", "ogg", "mp3", "flac",
  "the", "and", "for", "with", "new", "final", "master", "mix", "edit", "version",
  "sample", "samples", "pack", "file", "files", "export", "render", "untitled",
]);

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A path split into meaningful lowercase words.
 *
 * Handles the three conventions upstream packs actually use, in one pass:
 * `forceField_000` (camelCase + numeric suffix), `footstep-concrete-02`
 * (kebab), `Impact Heavy 3.wav` (spaces). The trailing take number is dropped
 * from the WORDS — it is not a searchable fact — but kept by `soundName`,
 * where it is the only thing distinguishing four otherwise identical files.
 */
export function soundWords(path: string): string[] {
  const stem = path
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\\/]+/g, " ");
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    // `v2`, `x3` and bare digits are versioning noise — a tag nobody searches
    // for, on thousands of files.
    .filter((w) => w.length > 1 && !/^[a-z]?\d+$/.test(w) && !STOP_WORDS.has(w));
}

/**
 * The take number a file ends on, as written. `drop_004` → 4, `hit3` → 3,
 * `whoosh` → null.
 *
 * Deliberately NOT interpreted here. Whether `_001` is the first take or the
 * second is not knowable from one filename — upstream packs use both
 * conventions, sometimes in the same download — so this reports the digits and
 * `nameSounds` decides, because it is the only thing that sees the whole
 * series. A per-file guess is how a shelf ends up starting at "Back 2".
 */
export function soundTake(path: string): number | null {
  const stem = path.replace(/\.[a-z0-9]+$/i, "");
  const m = /(?:^|[^0-9])(\d{1,3})$/.exec(stem);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Category                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which shelf this sound belongs on.
 *
 * The file's own words win over the pack's, because a pack called "Interface
 * Sounds" containing `error_alarm` is telling you two different things and the
 * specific one is right. The pack's words are the fallback, which is what makes
 * an opaquely-named file in a well-named pack still land somewhere sensible —
 * and `null` is a real answer, reserved for a file whose name says nothing at
 * all, so a caller can decide rather than be handed a wrong shelf.
 */
export function soundCategory(path: string, packWords: readonly string[] = []): SoundCategory | null {
  return matchCategory(soundWords(path)) ?? matchCategory(packWords);
}

function matchCategory(words: readonly string[]): SoundCategory | null {
  const set = new Set(words.flatMap(stems));
  for (const [category, keys] of CATEGORY_WORDS) {
    for (const key of keys) if (set.has(key)) return category;
  }
  return null;
}

/**
 * Every singular `word` could be the plural of — itself included.
 *
 * Upstream names the FOLDER in the plural and the file in the singular —
 * `Footsteps/footstep_01`, `Hits/hit_heavy` — because that is how anyone would
 * organise a drive. A vocabulary listing only singulars therefore misses the
 * single most informative word in the path, and the miss is invisible: the
 * sound still ships, it just lands on no shelf. It measured 19% of a
 * nine-hundred-pack archive.
 *
 * CANDIDATES rather than one answer, because English does not let you pick:
 * `bodies` → `body` and `zombies` → `zombie` are the same three letters and
 * opposite rules, and a stemmer that commits to one gets the other wrong every
 * time. Guessing is only affordable here because the result is exclusively
 * LOOKED UP in a closed vocabulary and never shown — a wrong candidate matches
 * nothing and costs nothing, where a real stemmer would cost a dependency to
 * reach the same place.
 */
function stems(word: string): string[] {
  if (word.length < 4 || !word.endsWith("s") || word.endsWith("ss")) return [word];
  const out = [word, word.slice(0, -1)];
  if (word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Name                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `Audio/forceField_000.ogg` → `Force Field 1`.
 *
 * Title case with the take number kept and made one-based, because upstream
 * counts from zero and no human has ever looked for "Impact 0". A file with
 * nothing but a number left is named after its pack, so a row never reads just
 * "4" — the one case where borrowing the pack's name is better than the truth.
 */
export function soundName(path: string, packTitle = ""): string {
  // The FILE'S OWN words first, not the whole path.
  //
  // A folder is the most informative thing about a sound and the worst thing
  // to name it after, because upstream repeats itself: `Battle sound
  // effects/Battle/bow.wav` is an ordinary layout and folding it in produces
  // "Battle Battle Bow". Deeper trees are worse than ugly — five sounds under
  // "Essential Retro Video Game Sound Effects/" all render as "Essential Retro
  // Video Ga…" and become rows a human cannot tell apart, which is the exact
  // defect `nameSounds` exists to prevent, arriving by another door. The
  // folders are still read, in full, by `soundTags`.
  const own = titleOf(soundWords(basename(path)));
  if (own) return own;
  // A file called `001.wav` says nothing, and then the folder it sits in is the
  // only thing that can name it — `Footsteps/01` is "Footsteps 1", not "1".
  // The pack's name is the last resort, because a row reading "4" tells the
  // reader nothing at all.
  return titleOf(soundWords(path)) || packTitle.trim() || "Sound";
}

/** The last path segment, with no dependency on `node:path` — core is headless. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Words → a title, each word used once.
 *
 * Deduping is not cosmetic: upstream names a folder and the files inside it
 * after the same thing often enough that "Swish Swish 2" is a real row, and a
 * repeated word is never what anyone meant.
 */
function titleOf(words: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w[0]!.toUpperCase() + w.slice(1));
  }
  return out.join(" ").trim();
}

/**
 * Name a WHOLE FOLDER of sounds at once — the only way take numbers can be
 * right.
 *
 * Two facts are properties of a series and invisible from one filename:
 *
 *  • Whether upstream counted from zero. `back_001…back_004` is one-based and
 *    `drop_000…drop_007` is zero-based, and the same publisher ships both. The
 *    series knows: if any member is 0, the series is zero-based and every
 *    label shifts by one.
 *  • Whether a number means anything at all. `bong_001` is the only bong in
 *    the pack, and "Bong 1" is a number that exists purely because a tool
 *    could not tell. A lone take is dropped, and the sound is just "Bong".
 *
 * Returns path → display name, so the caller keeps its own ordering.
 */
export function nameSounds(paths: readonly string[], packTitle = ""): Map<string, string> {
  const rows = paths.map((path) => ({ path, base: soundName(path, packTitle), take: soundTake(path) }));

  const series = new Map<string, number[]>();
  for (const r of rows) {
    if (r.take === null) continue;
    const list = series.get(r.base) ?? [];
    list.push(r.take);
    series.set(r.base, list);
  }

  const out = new Map<string, string>();
  for (const r of rows) {
    const takes = series.get(r.base);
    // A single take, or none — the number carries no information.
    if (r.take === null || !takes || takes.length < 2) {
      out.set(r.path, r.base);
      continue;
    }
    const offset = Math.min(...takes) === 0 ? 1 : 0;
    out.set(r.path, `${r.base} ${r.take + offset}`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Tags                                                                        */
/* -------------------------------------------------------------------------- */

/** The measured facts that are worth being searchable. */
export interface SoundShapeFacts {
  /** Audible length, ms. Drives the length tags. */
  durationMs: number;
  /** Detected transient, ms. A late one means the sound swells rather than hits. */
  hitMs: number;
}

/** A sound under 400 ms is a hit; over 4 s it is a bed. Both are how you search. */
function lengthTags(facts: SoundShapeFacts): string[] {
  const out: string[] = [];
  if (facts.durationMs > 0 && facts.durationMs < 400) out.push("short");
  else if (facts.durationMs > 4000) out.push("long");
  // A transient more than a tenth of the way in is a swell, not a strike —
  // which is exactly the difference between a riser and an impact.
  if (facts.durationMs > 0 && facts.hitMs > Math.max(120, facts.durationMs * 0.1)) out.push("swell");
  return out;
}

/**
 * Every searchable word for one sound: its shelf, its own descriptive words,
 * its pack's, and what the audio measured.
 *
 * Deduped and lowercase, in a stable order — category first, because that is
 * the tag the browse rail filters on and the one a reader should see first on
 * a card that only has room for three.
 */
export function soundTags(input: {
  path: string;
  packTags?: readonly string[];
  packWords?: readonly string[];
  facts?: SoundShapeFacts;
}): string[] {
  const words = soundWords(input.path);
  const category = soundCategory(input.path, input.packWords ?? []);
  const out = new Set<string>();
  if (category) out.add(category);
  // A word earns its place as a tag by naming a shelf or a quality. Everything
  // else stays findable through the name, which the matcher already searches —
  // tagging every word would make every tag meaningless.
  for (const w of words) {
    const tag = tagWord(w);
    if (tag) out.add(tag);
  }
  for (const t of input.packTags ?? []) out.add(t.toLowerCase());
  if (input.facts) for (const t of lengthTags(input.facts)) out.add(t);
  return [...out];
}

const CATEGORY_WORD_SET: ReadonlySet<string> = new Set(CATEGORY_WORDS.flatMap(([, ws]) => ws));

/**
 * The canonical searchable form of a word, or `null` for a word not worth
 * keeping. A plural is normalised to the singular the vocabulary lists, so
 * `#hit` finds the file called `hits_01` — a tag that only matches the spelling
 * upstream happened to use is a tag with a typo in it.
 */
function tagWord(word: string): string | null {
  for (const stem of stems(word)) {
    if (QUALITY_WORDS.has(stem) || CATEGORY_WORD_SET.has(stem)) return stem;
  }
  return null;
}

/** Is this tag one of the closed categories? What the rail asks of a facet. */
export function isSoundCategory(tag: string): tag is SoundCategory {
  return (SOUND_CATEGORIES as readonly string[]).includes(tag);
}
