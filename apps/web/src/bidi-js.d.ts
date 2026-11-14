// bidi-js ships no declarations. @solomotion/core/src/text/bidi.ts is the only
// consumer and fully types its own usage via a cast — this just satisfies
// the web app's separate tsconfig program (core/src/text/bidi-js.d.ts covers
// core's own typecheck, but isn't in this app's `include` glob).
declare module "bidi-js" {
  const bidiFactory: () => unknown;
  export default bidiFactory;
}
