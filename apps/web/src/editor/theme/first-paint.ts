import { compile, presetById } from "@solomotion/theme";
import { identity } from "../identity";
import { NAMES } from "../names";

/**
 * FIRST PAINT IS THE PRODUCT'S. The stylesheet's fallback tokens belong to no
 * product in particular, so without this a product briefly showed whichever
 * colours globals.css happened to hold. On the server, at build time, the
 * product's default look is compiled into a `:root` rule and root attributes;
 * then, before any chunk loads, a tiny script paints the theme this person
 * last saw (applyThemeToDom keeps it), custom themes included.
 */
export function firstPaint(): { css: string; attrs: Record<string, string>; script: string; themeColor: string } {
  identity.registerThemes();
  const theme = presetById(identity.defaultThemeId)?.theme;
  if (!theme) return { css: "", attrs: {}, script: "", themeColor: "#0a0a0d" };
  const c = compile(theme, theme.mode);
  const css = `:root:root{${Object.entries(c.vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")};color-scheme:${c.scheme}}`;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.attrs)) attrs[`data-${k}`] = v;
  const script = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(NAMES.storage.themePaint)})||"null");if(p&&p.v){var r=document.documentElement;for(var k in p.v)r.style.setProperty(k,p.v[k]);for(var a in p.a)r.setAttribute("data-"+a,p.a[a]);r.style.colorScheme=p.s}}catch(e){}`;
  return { css, attrs, script, themeColor: theme.neutral[theme.mode].bg };
}
