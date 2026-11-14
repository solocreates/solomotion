/**
 * @solomotion/core — THE EXPRESSION LANGUAGE.
 *
 * A small, total language for driving one field: `#references` to built-in
 * globals, document variables and locals you declare, plus functions, operators
 * and a conditional. It is headless and pure — the lexer, parser, checker and
 * evaluator here know nothing about React, the DOM or the store — so the editor,
 * the renderer, the exporter and the node board all run the SAME language and
 * cannot drift.
 *
 * Reading order:
 *   types    — the one type brain, shared with the node sockets and the picker
 *   lexer    — source → tokens with spans (the editor colours straight from these)
 *   parser   — tokens → tree, error-tolerant by design
 *   globals  — the `#time` / `#layer.*` catalogue: one table, four consumers
 *   functions— the verbs, named to match the node catalogue
 *   check    — the messages a person reads
 *   eval     — the pure evaluator
 *   bind     — the compile cache and the ambient host context
 *   document — `fx:<id>` ⇄ a value, and the table's housekeeping
 *   link     — one property following another, as an ordinary expression
 */
export * from "./types";
export * from "./lexer";
export * from "./ast";
export * from "./parser";
export * from "./resolve-ref";
export * from "./globals";
export * from "./scope";
export * from "./functions";
export * from "./check";
export * from "./eval";
export * from "./bind";
export * from "./document";
export * from "./layer-api";
export * from "./link";
