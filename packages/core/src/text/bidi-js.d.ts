/** No upstream types published for bidi-js — ./bidi.ts fully types its own usage via a cast. */
declare module "bidi-js" {
  const bidiFactory: () => unknown;
  export default bidiFactory;
}
