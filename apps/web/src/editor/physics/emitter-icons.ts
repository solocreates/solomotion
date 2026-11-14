import { Cloud, CloudRain, Disc3, Droplet, Droplets, Flame, Haze, Orbit, PartyPopper, Radio, Rocket, Shrink, Snowflake, Sparkle, Sparkles, Spline, Split, Wind, Zap, type LucideIcon } from "lucide-react";

/**
 * The particle icons — an emitter type's and a look's — on their own, so the
 * timeline's + menu can name the looks without loading the emitter stack.
 */

const TYPE_ICON: Record<string, LucideIcon> = { stream: Orbit, burst: PartyPopper, hit: Zap, sub: Split };
const LOOK_ICON: Record<string, LucideIcon> = { sparks: Flame, fountain: Droplets, smoke: Cloud, rain: CloudRain, snow: Snowflake, confetti: PartyPopper, firework: Sparkles, shell: Rocket, crackle: Sparkle, peony: Sparkles, splash: Droplet, impact: Zap, dust: Haze, trail: Spline, accretion: Disc3, infall: Shrink, wind: Wind, supernova: Radio };

export function emitterIcon(type: string): LucideIcon {
  return TYPE_ICON[type] ?? Orbit;
}

export function lookIcon(id: string): LucideIcon {
  return LOOK_ICON[id] ?? Orbit;
}
