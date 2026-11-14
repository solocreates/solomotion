/**
 * `bidi-js` ships no types. Its real API is described precisely at the one call
 * site that touches it (`../text/bidi.ts`), which casts the factory's result to
 * the exact shape it uses — so all this declaration owes the compiler is the
 * module's existence and a default export.
 *
 * It lives in core rather than in a consumer because the failure belongs to
 * core: any app that typechecks core's SOURCE (the package resolves to `src`,
 * not to built `.d.ts`) hits it. The site's deploy did — its expressions
 * reference is generated from the language, so it pulls core in — while the web
 * app happened not to, which is why this surfaced on a docs deploy.
 */
declare module "bidi-js" {
  /** Returns the bidi API object; `text/bidi.ts` casts it to the shape it uses. */
  const bidiFactory: () => unknown;
  export default bidiFactory;
}
