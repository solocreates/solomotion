# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub:
**[Report a vulnerability](https://github.com/novincode/solomotion/security/advisories/new)**
(the Security tab of this repository). Do not open a public issue, pull
request or discussion for it.

A useful report says what an attacker can do, which version and platform you
tested, and the smallest project file, link or steps that show it.

## What happens next

SoloMotion is maintained by a very small team, so here is what you can count on:

- We acknowledge the report within five working days.
- We confirm or rule out the problem, and tell you which, within fourteen days.
- We fix confirmed problems in the next release, sooner for anything serious,
  and publish a GitHub Security Advisory with a CVE when one applies.
- We credit you in the advisory, unless you ask us not to.

Please give us a reasonable time to ship a fix before you disclose the problem
publicly. We will tell you when the fix is out.

## Supported versions

Security fixes go into the latest release. The live app always runs the
latest release.

## Scope

In scope: the studio, the `@solomotion/*` packages (the MCP bridge included)
and the website. Out of scope: problems that need a malicious browser extension, a
compromised machine, or physical access to an unlocked device.

Project files are code-like: a project can contain expressions and scripts.
Opening a project from a source you do not trust is the same decision as
running a script from one. Report any way a project can reach beyond what the
studio itself is allowed to do.
